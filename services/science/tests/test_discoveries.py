"""Tier 5: discovery candidates: validation, catalogue searches, evidence trail, status ladder,
and above all the wording, which must never claim more than the searches support."""

from __future__ import annotations

import json
import threading
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Iterator

import pytest
from fastapi.testclient import TestClient

from matterlab_science import discovery
from matterlab_science.db import Database

from .helpers import ASPIRIN, ASPIRIN_INCHIKEY, PENTAVALENT_CARBON, Contract, is_error_shape, run_job, smiles

LADDER = [
    "user-created",
    "structurally-validated",
    "no-match-in-searched-catalogs",
    "computationally-plausible",
    "experimentally-observed",
    "independently-validated",
]
# Structures that are not in the starter catalogue (the tests assert that, they do not assume it).
UNLISTED = "OC(=O)C1CC1c1ccncc1"
UNLISTED_B = "CCOC(=O)C1CC1c1ccncc1"
UNLISTED_C = "NC(=O)C1CC1c1ccncc1"
FORBIDDEN_WORDING = ("novel", "new compound", "new molecule", "previously unknown", "unknown to science", "never been", "first synthesis", "discovered a")


@pytest.fixture(scope="module")
def recorded() -> dict:
    return json.loads((Path(__file__).parent / "data" / "pubchem_recorded.json").read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def pubchem_replay(recorded: dict) -> Iterator[SimpleNamespace]:
    """A local HTTP server that replays recorded PubChem answers (see tests/data/pubchem_recorded.json)."""
    seen: list[str] = []

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            seen.append(self.path)
            if self.path.startswith("/broken/"):
                payload, status, content_type = b"upstream failure", 500, "text/plain"
            else:
                parts = self.path.split("/")
                key = parts[parts.index("inchikey") + 1] if "inchikey" in parts else ""
                entry = recorded["lookups"].get(key, recorded["not_found"])
                payload, status, content_type = json.dumps(entry["body"]).encode("utf-8"), entry["http_status"], "application/json"
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *args: Any) -> None:
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}"
    yield SimpleNamespace(base_url=f"{base}/rest/pug", broken_url=f"{base}/broken/rest/pug", requests=seen)
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)


def create(client: TestClient, structure: str, **extra: Any) -> dict:
    response = client.post("/v1/discoveries", json={"title": f"Candidate {structure}", "structure": smiles(structure), **extra})
    assert response.status_code == 201, response.text
    return response.json()


def assert_honest_wording(document: Any) -> None:
    text = json.dumps(document).lower()
    for phrase in FORBIDDEN_WORDING:
        assert phrase not in text, f"a discovery response must never say {phrase!r}"


def local_catalog(body: dict) -> dict:
    return next(c for c in body["searched_catalogs"] if c["catalog_scope"] == "local")


# ---------------------------------------------------------------------------------------------
# Creation: validation, searches, wording
# ---------------------------------------------------------------------------------------------


def test_status_ladder_is_exactly_the_specified_one(client: TestClient) -> None:
    assert list(discovery.LADDER) == LADDER
    body = create(client, UNLISTED)
    assert body["status_ladder"] == LADDER
    schema = client.app.openapi()["components"]["schemas"]["Discovery"]["properties"]["status"]  # type: ignore[attr-defined]
    assert schema["enum"] == LADDER
    assert client.delete(f"/v1/discoveries/{body['id']}").status_code == 204


def test_candidate_without_a_catalogue_match(client: TestClient, contract: Contract, db: Database) -> None:
    catalogue_size = db.fetch_one("SELECT count(*) AS n FROM compounds")["n"]
    response = client.post("/v1/discoveries", json={"title": "  Candidate A  ", "structure": smiles(UNLISTED), "notes": "drawn in the builder"})
    body = contract.check("POST", "/v1/discoveries", response)
    assert response.status_code == 201
    assert body["title"] == "Candidate A" and body["notes"] == "drawn in the builder"
    assert body["status"] == "no-match-in-searched-catalogs" and body["structure_valid"] is True
    assert body["identical_structure_found"] is False
    assert body["canonical_smiles"] == "O=C(O)C1CC1c1ccncc1" and body["molecular_formula"] == "C9H9NO2" and len(body["inchikey"]) == 27
    assert body["input"] == smiles(UNLISTED), "the structure is kept exactly as submitted"
    assert body["validation"]["valid"] is True and body["validation"]["errors"] == []
    assert body["provenance"]["source_key"] == "matterlab-user" and body["derived_by"]["engine"] == "RDKit"

    # Which catalogues, how many records, and when: always stated.
    assert len(body["searched_catalogs"]) == 1
    catalog = body["searched_catalogs"][0]
    assert catalog["catalog_key"] == "matterlab-compound-catalogue" and catalog["catalog_scope"] == "local"
    assert catalog["records_searched"] == catalogue_size
    assert catalog["first_searched_at"].endswith("Z") and catalog["first_searched_at"] <= catalog["last_searched_at"]
    assert catalog["first_searched_at"][:13] == body["created_at"][:13] or catalog["first_searched_at"] < body["created_at"]
    assert catalog["methods"] == ["exact-inchikey", "similarity-morgan-tanimoto"]
    assert catalog["identity_search_completed"] is True and catalog["identical_structure_found"] is False and catalog["last_identity_outcome"] == "no-match"

    exact, similar = body["catalog_searches"]
    assert exact["search_method"] == "exact-inchikey" and exact["match_kind"] == "identity" and exact["outcome"] == "no-match" and exact["matches"] == []
    assert exact["records_searched"] == catalogue_size and exact["parameters"]["inchikey"] == body["inchikey"]
    assert similar["search_method"] == "similarity-morgan-tanimoto" and similar["match_kind"] == "similarity"
    assert similar["parameters"]["threshold"] == 0.7 and similar["records_searched"] == catalogue_size

    # The wording: a bounded statement about the searched catalogues, never a claim about the compound.
    statement = body["statement"]
    assert statement.startswith("No identical structure was found in the searched catalogues")
    assert f"{catalogue_size} records" in statement and "MATTER LAB local compound catalogue" in statement
    assert "does not show that the compound is absent from other databases or from the literature" in statement
    assert "PubChem" not in statement, "PubChem was not searched, so it must not be mentioned as searched"
    assert "Other databases and the literature were not searched" in body["status_meaning"]
    assert_honest_wording(body)

    # The evidence trail records every step, in order.
    trail = [(e["kind"], e["recorded_by"], e["status_before"], e["status_after"]) for e in body["evidence"]]
    assert trail == [
        ("note", "user", None, "user-created"),
        ("structure-validation", "service", None, None),
        ("status-change", "service", "user-created", "structurally-validated"),
        ("catalog-search", "service", None, None),
        ("catalog-search", "service", None, None),
        ("status-change", "service", "structurally-validated", "no-match-in-searched-catalogs"),
    ]
    assert [e["created_at"] for e in body["evidence"]] == sorted(e["created_at"] for e in body["evidence"])
    assert body["evidence"][3]["catalog_search_id"] == exact["id"] and body["evidence"][4]["catalog_search_id"] == similar["id"]
    assert f"({catalogue_size} records)" in body["evidence"][3]["summary"]

    fetched = contract.check("GET", "/v1/discoveries/{discovery_id}", client.get(f"/v1/discoveries/{body['id']}"))
    assert fetched == body, "identifiers are persistent and the stored candidate is what was returned"
    assert client.delete(f"/v1/discoveries/{body['id']}").status_code == 204


def test_candidate_that_is_a_known_compound(client: TestClient) -> None:
    body = create(client, "OC(=O)C1=CC=CC=C1OC(C)=O")
    assert body["status"] == "structurally-validated", "a structure that is in a searched catalogue never reaches the no-match rung"
    assert body["identical_structure_found"] is True and body["inchikey"] == ASPIRIN_INCHIKEY
    exact = body["catalog_searches"][0]
    assert exact["outcome"] == "match" and [m["name"] for m in exact["matches"]] == ["Aspirin"]
    assert client.get(f"/v1/compounds/{exact['matches'][0]['compound_id']}").json()["inchikey"] == ASPIRIN_INCHIKEY
    assert local_catalog(body)["identical_structure_found"] is True
    assert body["statement"].startswith("An identical structure (same InChIKey) is listed in: MATTER LAB local compound catalogue")
    assert "known compound" in body["statement"]
    assert [e["status_after"] for e in body["evidence"] if e["kind"] == "status-change"] == ["structurally-validated"]
    similar = body["catalog_searches"][1]
    assert similar["matches"][0]["name"] == "Aspirin" and similar["matches"][0]["similarity"] == 1.0
    assert_honest_wording(body)
    assert client.delete(f"/v1/discoveries/{body['id']}").status_code == 204


def test_similarity_hits_are_recorded_but_are_not_identity(client: TestClient) -> None:
    methyl_ester = create(client, "COC(=O)c1ccccc1OC(C)=O", similarity_threshold=0.4, similarity_limit=3)
    assert methyl_ester["status"] == "no-match-in-searched-catalogs" and methyl_ester["identical_structure_found"] is False
    similar = methyl_ester["catalog_searches"][1]
    assert similar["outcome"] == "match" and 1 <= len(similar["matches"]) <= 3
    assert similar["matches"][0]["name"] == "Aspirin" and 0.4 <= similar["matches"][0]["similarity"] < 1.0
    assert "not an identity match" in similar["detail"]
    assert "most similar is Aspirin" in next(e["summary"] for e in methyl_ester["evidence"] if e["catalog_search_id"] == similar["id"])
    assert_honest_wording(methyl_ester)
    assert client.delete(f"/v1/discoveries/{methyl_ester['id']}").status_code == 204


def test_invalid_structure_stays_user_created(client: TestClient, contract: Contract) -> None:
    response = client.post("/v1/discoveries", json={"title": "Impossible carbon", "structure": smiles(PENTAVALENT_CARBON)})
    body = contract.check("POST", "/v1/discoveries", response)
    assert response.status_code == 201, "the candidate is kept, with the reason it is not valid"
    assert body["status"] == "user-created" and body["structure_valid"] is False
    assert body["canonical_smiles"] is None and body["inchikey"] is None and body["molblock"] is None
    assert body["validation"]["valid"] is False
    assert body["validation"]["errors"][0]["message"] == "Explicit valence for atom # 1 C, 5, is greater than permitted"
    assert body["searched_catalogs"] == [] and body["catalog_searches"] == [] and body["identical_structure_found"] is False
    assert body["statement"] == "RDKit could not validate this structure, so no catalogue was searched and nothing has been established about it."
    assert [e["kind"] for e in body["evidence"]] == ["note", "structure-validation"]
    assert "Explicit valence for atom # 1 C, 5, is greater than permitted" in body["evidence"][1]["summary"]
    assert_honest_wording(body)

    # Nothing can be searched or claimed for it.
    again = client.post(f"/v1/discoveries/{body['id']}/searches", json={})
    assert again.status_code == 409 and contract.check("POST", "/v1/discoveries/{discovery_id}/searches", again)["error"]["code"] == "structure_not_valid"
    climb = client.post(f"/v1/discoveries/{body['id']}/status", json={"status": "structurally-validated", "justification": "please"})
    assert climb.status_code == 409 and is_error_shape(climb.json())
    assert client.delete(f"/v1/discoveries/{body['id']}").status_code == 204


def test_request_validation(client: TestClient, contract: Contract) -> None:
    before = client.get("/v1/discoveries").json()["total"]
    for body in (
        {"structure": smiles("CCO")},
        {"title": "   ", "structure": smiles("CCO")},
        {"title": "x", "structure": {"format": "xyz", "data": "CCO"}},
        {"title": "x", "structure": smiles("CCO"), "similarity_threshold": 2},
        {"title": "x", "structure": smiles("CCO"), "claim": "novel"},
    ):
        response = client.post("/v1/discoveries", json=body)
        assert response.status_code == 422 and is_error_shape(contract.check("POST", "/v1/discoveries", response)), body
    assert client.get("/v1/discoveries").json()["total"] == before


# ---------------------------------------------------------------------------------------------
# Evidence and the ladder
# ---------------------------------------------------------------------------------------------


def set_status(client: TestClient, discovery_id: str, status: str) -> Any:
    return client.post(f"/v1/discoveries/{discovery_id}/status", json={"status": status, "justification": f"test asks for {status}"})


def test_ladder_is_climbed_one_rung_at_a_time_with_evidence(client: TestClient, contract: Contract) -> None:
    candidate = create(client, UNLISTED_B)
    cid = candidate["id"]
    assert candidate["status"] == "no-match-in-searched-catalogs"

    def refused(status: str) -> dict:
        response = set_status(client, cid, status)
        body = contract.check("POST", "/v1/discoveries/{discovery_id}/status", response)
        assert response.status_code == 409 and is_error_shape(body) and body["error"]["code"] == "status_transition_not_allowed", (status, body)
        assert client.get(f"/v1/discoveries/{cid}").json()["status"] == body["error"]["details"]["current_status"], "a refused transition changes nothing"
        return body["error"]

    # No skipping rungs, and no rung without its evidence.
    assert refused("experimentally-observed")["details"]["next_status"] == "computationally-plausible"
    assert refused("independently-validated")["details"]["next_status"] == "computationally-plausible"
    assert refused("computationally-plausible")["details"]["required_evidence"] == "calculation"

    # A calculation on some other molecule does not count.
    other = run_job(client, "rdkit.geometry_optimization", {"structure": smiles("CCO")})
    response = client.post(f"/v1/discoveries/{cid}/evidence", json={"kind": "calculation", "calculation_id": other["id"]})
    attached = contract.check("POST", "/v1/discoveries/{discovery_id}/evidence", response)
    assert response.status_code == 201
    wrong = attached["evidence"][-1]
    assert wrong["kind"] == "calculation" and wrong["calculation_id"] == other["id"] and wrong["recorded_by"] == "service"
    assert wrong["details"]["structure_matches_candidate"] is False and wrong["details"]["counts_towards_computationally_plausible"] is False
    assert "on a different structure" in wrong["summary"]
    assert attached["status"] == "no-match-in-searched-catalogs", "attaching evidence never changes the status by itself"
    assert refused("computationally-plausible")["details"]["required_evidence"] == "calculation"

    # Neither does a calculation that failed.
    failed = run_job(client, "rdkit.geometry_optimization", {"structure": smiles(UNLISTED_B)}, {"force_field": "uff", "max_iterations": 1})
    assert failed["status"] == "succeeded" and failed["converged"] is False
    unconverged = client.post(f"/v1/discoveries/{cid}/evidence", json={"kind": "calculation", "calculation_id": failed["id"]}).json()["evidence"][-1]
    assert unconverged["details"]["structure_matches_candidate"] is True and unconverged["details"]["converged"] is False
    assert unconverged["details"]["counts_towards_computationally_plausible"] is False
    refused("computationally-plausible")

    # A converged calculation on the candidate itself does.
    job = run_job(client, "rdkit.geometry_optimization", {"structure": smiles(UNLISTED_B)})
    assert job["status"] == "succeeded" and job["converged"] is True
    good = client.post(f"/v1/discoveries/{cid}/evidence", json={"kind": "calculation", "calculation_id": job["id"], "summary": "MMFF94 minimum"}).json()["evidence"][-1]
    assert good["details"]["counts_towards_computationally_plausible"] is True and good["details"]["input_hash"] == job["input_hash"]
    assert good["summary"].startswith("MMFF94 minimum [Calculation rdkit.geometry_optimization (MMFF94;")
    response = set_status(client, cid, "computationally-plausible")
    plausible = contract.check("POST", "/v1/discoveries/{discovery_id}/status", response)
    assert response.status_code == 200 and plausible["status"] == "computationally-plausible"
    change = plausible["evidence"][-1]
    assert (change["kind"], change["recorded_by"], change["status_before"], change["status_after"]) == ("status-change", "user", "no-match-in-searched-catalogs", "computationally-plausible")
    assert "A calculation is not an observation" in plausible["status_meaning"]

    # Observation and validation are user assertions and need a reference.
    assert refused("experimentally-observed")["details"]["required_evidence"] == "experimental-observation"
    no_reference = client.post(f"/v1/discoveries/{cid}/evidence", json={"kind": "experimental-observation", "summary": "seen by NMR"})
    assert no_reference.status_code == 422 and is_error_shape(contract.check("POST", "/v1/discoveries/{discovery_id}/evidence", no_reference))
    observed = client.post(
        f"/v1/discoveries/{cid}/evidence",
        json={"kind": "experimental-observation", "summary": "1H NMR consistent with the structure", "reference": "Lab notebook 12, p. 34", "details": {"technique": "NMR"}},
    ).json()["evidence"][-1]
    assert observed["recorded_by"] == "user" and observed["details"] == {"technique": "NMR", "verified_by_service": False}
    assert observed["reference"] == "Lab notebook 12, p. 34"
    assert set_status(client, cid, "experimentally-observed").json()["status"] == "experimentally-observed"
    assert "The service has not verified it" in client.get(f"/v1/discoveries/{cid}").json()["status_meaning"]

    assert refused("independently-validated")["details"]["required_evidence"] == "independent-validation"
    client.post(f"/v1/discoveries/{cid}/evidence", json={"kind": "independent-validation", "summary": "Reproduced by a second group", "reference": "doi:10.0000/example"})
    final = set_status(client, cid, "independently-validated").json()
    assert final["status"] == "independently-validated"
    assert [e["status_after"] for e in final["evidence"] if e["kind"] == "status-change"] == LADDER[1:]

    # A status can be withdrawn, but not below what validation and the searches established.
    lowered = set_status(client, cid, "computationally-plausible").json()
    assert lowered["status"] == "computationally-plausible" and lowered["evidence"][-1]["status_before"] == "independently-validated"
    assert refused("structurally-validated")["details"]["lowest_allowed"] == "no-match-in-searched-catalogs"
    assert refused("user-created")["details"]["lowest_allowed"] == "no-match-in-searched-catalogs"
    count = len(client.get(f"/v1/discoveries/{cid}").json()["evidence"])
    assert set_status(client, cid, "computationally-plausible").status_code == 200
    assert len(client.get(f"/v1/discoveries/{cid}").json()["evidence"]) == count, "asking for the current status is a no-op"
    assert_honest_wording(client.get(f"/v1/discoveries/{cid}").json())
    assert client.delete(f"/v1/discoveries/{cid}").status_code == 204


def test_service_rungs_cannot_be_requested(client: TestClient) -> None:
    known = create(client, ASPIRIN)
    assert known["status"] == "structurally-validated"
    response = set_status(client, known["id"], "no-match-in-searched-catalogs")
    assert response.status_code == 409 and "established by the service" in response.json()["error"]["message"]
    job = run_job(client, "rdkit.geometry_optimization", {"structure": smiles(ASPIRIN)})
    client.post(f"/v1/discoveries/{known['id']}/evidence", json={"kind": "calculation", "calculation_id": job["id"]})
    assert set_status(client, known["id"], "computationally-plausible").status_code == 409, "a known compound cannot climb past the no-match rung"
    assert client.get(f"/v1/discoveries/{known['id']}").json()["status"] == "structurally-validated"
    assert client.delete(f"/v1/discoveries/{known['id']}").status_code == 204


def test_evidence_request_validation(client: TestClient) -> None:
    candidate = create(client, UNLISTED)
    path = f"/v1/discoveries/{candidate['id']}/evidence"
    assert client.post(path, json={"kind": "calculation"}).status_code == 422
    assert client.post(path, json={"kind": "note"}).status_code == 422
    assert client.post(path, json={"kind": "status-change", "summary": "forged"}).status_code == 422, "service evidence kinds cannot be written by users"
    assert client.post(path, json={"kind": "note", "summary": "x", "calculation_id": "00000000-0000-4000-8000-000000000000"}).status_code == 422
    unknown = client.post(path, json={"kind": "calculation", "calculation_id": "00000000-0000-4000-8000-000000000000"})
    assert unknown.status_code == 422 and unknown.json()["error"]["code"] == "unknown_reference"
    note = client.post(path, json={"kind": "note", "summary": "Looks interesting"})
    assert note.status_code == 201 and note.json()["evidence"][-1]["summary"] == "Looks interesting"
    assert len(client.get(f"/v1/discoveries/{candidate['id']}").json()["evidence"]) == len(candidate["evidence"]) + 1
    assert client.delete(f"/v1/discoveries/{candidate['id']}").status_code == 204


# ---------------------------------------------------------------------------------------------
# External lookups
# ---------------------------------------------------------------------------------------------


def test_pubchem_lookup_is_recorded(client: TestClient, recorded: dict, pubchem_replay: SimpleNamespace, override_settings: Callable[..., None]) -> None:
    override_settings(pubchem_base_url=pubchem_replay.base_url)
    before = len(pubchem_replay.requests)
    without = create(client, UNLISTED_C)
    assert len(pubchem_replay.requests) == before, "PubChem is only contacted when asked"
    assert [c["catalog_scope"] for c in without["searched_catalogs"]] == ["local"]
    assert client.delete(f"/v1/discoveries/{without['id']}").status_code == 204

    body = create(client, UNLISTED_C, query_pubchem=True)
    assert len(pubchem_replay.requests) == before + 1
    assert pubchem_replay.requests[-1] == f"/rest/pug/compound/inchikey/{body['inchikey']}/cids/JSON"
    assert body["status"] == "no-match-in-searched-catalogs" and body["identical_structure_found"] is False
    lookup = body["catalog_searches"][-1]
    assert lookup["catalog_key"] == "pubchem-compound" and lookup["catalog_scope"] == "external" and lookup["match_kind"] == "identity"
    assert lookup["search_method"] == "external-inchikey-lookup" and lookup["outcome"] == "no-match" and lookup["matches"] == []
    assert lookup["http_status"] == 404 and lookup["request_url"] == f"{pubchem_replay.base_url}/compound/inchikey/{body['inchikey']}/cids/JSON"
    assert lookup["records_searched"] is None and "does not report how many records" in lookup["detail"]
    assert lookup["searched_at"].endswith("Z")

    external = next(c for c in body["searched_catalogs"] if c["catalog_scope"] == "external")
    assert external["records_searched"] is None and external["identity_search_completed"] is True and external["identical_structure_found"] is False
    trail = next(e for e in body["evidence"] if e["kind"] == "external-lookup")
    assert trail["catalog_search_id"] == lookup["id"] and "PubChem has no compound with this InChIKey" in trail["summary"]
    assert "PubChem Compound" in body["statement"] and "record count not reported by the service" in body["statement"]
    assert "MATTER LAB local compound catalogue" in body["statement"]
    assert_honest_wording(body)
    assert client.delete(f"/v1/discoveries/{body['id']}").status_code == 204


def test_external_match_returns_the_candidate_to_structurally_validated(
    client: TestClient, contract: Contract, recorded: dict, pubchem_replay: SimpleNamespace, override_settings: Callable[..., None]
) -> None:
    override_settings(pubchem_base_url=pubchem_replay.base_url)
    phenacetin = recorded["structures"]["phenacetin"]
    body = create(client, phenacetin["smiles"])
    assert body["inchikey"] == phenacetin["inchikey"], "RDKit and PubChem agree on the identifier"
    assert body["status"] == "no-match-in-searched-catalogs", "phenacetin is not in the starter catalogue"

    job = run_job(client, "rdkit.geometry_optimization", {"structure": smiles(phenacetin["smiles"])})
    client.post(f"/v1/discoveries/{body['id']}/evidence", json={"kind": "calculation", "calculation_id": job["id"]})
    assert set_status(client, body["id"], "computationally-plausible").json()["status"] == "computationally-plausible"

    response = client.post(f"/v1/discoveries/{body['id']}/searches", json={"query_pubchem": True})
    searched = contract.check("POST", "/v1/discoveries/{discovery_id}/searches", response)
    assert response.status_code == 200
    assert searched["status"] == "structurally-validated", "once a searched catalogue lists the structure it is a known compound"
    assert searched["identical_structure_found"] is True
    lookup = searched["catalog_searches"][-1]
    expected = recorded["lookups"][phenacetin["inchikey"]]["body"]["IdentifierList"]["CID"]
    assert lookup["outcome"] == "match" and lookup["http_status"] == 200 and [m["pubchem_cid"] for m in lookup["matches"]] == expected
    assert lookup["matches"][0]["external_id"] == f"CID {expected[0]}" and lookup["matches"][0]["url"] == f"https://pubchem.ncbi.nlm.nih.gov/compound/{expected[0]}"
    demotion = searched["evidence"][-1]
    assert (demotion["kind"], demotion["status_before"], demotion["status_after"]) == ("status-change", "computationally-plausible", "structurally-validated")
    assert "PubChem" in demotion["summary"] and "known compound" in demotion["summary"]
    assert searched["statement"].startswith("An identical structure (same InChIKey) is listed in: PubChem Compound")
    assert len(searched["catalog_searches"]) == 5, "the earlier searches stay in the record"
    assert local_catalog(searched)["search_count"] == 4 and local_catalog(searched)["identical_structure_found"] is False

    assert set_status(client, body["id"], "computationally-plausible").status_code == 409
    assert set_status(client, body["id"], "no-match-in-searched-catalogs").status_code == 409
    assert_honest_wording(searched)
    assert client.delete(f"/v1/discoveries/{body['id']}").status_code == 204


def test_failed_lookup_is_inconclusive_not_a_negative_result(client: TestClient, pubchem_replay: SimpleNamespace, override_settings: Callable[..., None]) -> None:
    override_settings(pubchem_base_url="http://127.0.0.1:9/rest/pug", pubchem_timeout_seconds=3.0)
    unreachable = create(client, UNLISTED, query_pubchem=True)
    lookup = unreachable["catalog_searches"][-1]
    assert lookup["catalog_key"] == "pubchem-compound" and lookup["outcome"] == "error" and lookup["http_status"] is None
    assert "could not be reached" in lookup["detail"] and "inconclusive" in lookup["detail"]
    external = next(c for c in unreachable["searched_catalogs"] if c["catalog_scope"] == "external")
    assert external["identity_search_completed"] is False and external["last_identity_outcome"] == "error" and external["identical_structure_found"] is False
    assert unreachable["status"] == "no-match-in-searched-catalogs", "the local search did complete"
    assert "PubChem" not in unreachable["statement"], "a lookup that failed must not be reported as a searched catalogue"
    assert "inconclusive" in next(e["summary"] for e in unreachable["evidence"] if e["kind"] == "external-lookup")
    assert client.delete(f"/v1/discoveries/{unreachable['id']}").status_code == 204

    override_settings(pubchem_base_url=pubchem_replay.broken_url)
    broken = create(client, UNLISTED, query_pubchem=True)
    lookup = broken["catalog_searches"][-1]
    assert lookup["outcome"] == "error" and lookup["http_status"] == 500 and "HTTP 500" in lookup["detail"]
    assert "PubChem" not in broken["statement"]
    assert client.delete(f"/v1/discoveries/{broken['id']}").status_code == 204


def test_external_lookups_can_be_disabled(client: TestClient, contract: Contract, override_settings: Callable[..., None]) -> None:
    override_settings(external_lookups_enabled=False)
    before = client.get("/v1/discoveries").json()["total"]
    response = client.post("/v1/discoveries", json={"title": "x", "structure": smiles(UNLISTED), "query_pubchem": True})
    body = contract.check("POST", "/v1/discoveries", response)
    assert response.status_code == 422 and body["error"]["code"] == "external_lookups_disabled"
    assert client.get("/v1/discoveries").json()["total"] == before
    allowed = create(client, UNLISTED)
    assert allowed["status"] == "no-match-in-searched-catalogs"
    assert client.delete(f"/v1/discoveries/{allowed['id']}").status_code == 204


@pytest.mark.network
def test_live_pubchem_lookup(client: TestClient, ctx: Any) -> None:
    """One real request to PubChem (well under its rate limit)."""
    try:
        urllib.request.urlopen(urllib.request.Request(f"{ctx.settings.pubchem_base_url}/compound/cid/2244/property/InChIKey/JSON"), timeout=15).read()
    except Exception as exc:
        pytest.skip(f"PubChem is not reachable from the test container: {type(exc).__name__}: {exc}")
    body = create(client, ASPIRIN, query_pubchem=True)
    lookup = body["catalog_searches"][-1]
    assert lookup["catalog_key"] == "pubchem-compound" and lookup["outcome"] == "match" and lookup["http_status"] == 200
    assert lookup["request_url"] == f"https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/inchikey/{ASPIRIN_INCHIKEY}/cids/JSON"
    assert 2244 in [m["pubchem_cid"] for m in lookup["matches"]]
    assert {c["catalog_key"] for c in body["searched_catalogs"] if c["identical_structure_found"]} == {"matterlab-compound-catalogue", "pubchem-compound"}
    assert client.delete(f"/v1/discoveries/{body['id']}").status_code == 204


# ---------------------------------------------------------------------------------------------
# Housekeeping
# ---------------------------------------------------------------------------------------------


def test_list_patch_delete(client: TestClient, contract: Contract) -> None:
    first = create(client, UNLISTED)
    second = create(client, ASPIRIN)
    listing = contract.check("GET", "/v1/discoveries", client.get("/v1/discoveries", params={"limit": 500}))
    ids = [d["id"] for d in listing["items"]]
    assert ids.index(second["id"]) < ids.index(first["id"])
    only = client.get("/v1/discoveries", params={"status": "structurally-validated", "inchikey": ASPIRIN_INCHIKEY}).json()
    assert second["id"] in {d["id"] for d in only["items"]} and first["id"] not in {d["id"] for d in only["items"]}
    assert client.get("/v1/discoveries", params={"status": "novel"}).status_code == 422

    patched = contract.check("PATCH", "/v1/discoveries/{discovery_id}", client.patch(f"/v1/discoveries/{first['id']}", json={"title": "Renamed", "notes": "second thoughts"}))
    assert patched["title"] == "Renamed" and patched["notes"] == "second thoughts" and patched["status"] == first["status"]
    assert patched["evidence"] == first["evidence"], "renaming does not touch the evidence trail"
    assert client.patch(f"/v1/discoveries/{first['id']}", json={"structure": smiles("CC")}).status_code == 422, "the structure of a candidate is fixed"
    assert client.patch(f"/v1/discoveries/{first['id']}", json={"status": "independently-validated"}).status_code == 422
    assert client.patch(f"/v1/discoveries/{first['id']}", json={"title": None}).status_code == 422

    deleted = client.delete(f"/v1/discoveries/{first['id']}")
    contract.check("DELETE", "/v1/discoveries/{discovery_id}", deleted)
    assert deleted.status_code == 204
    missing = first["id"]
    for method, path, payload in (
        ("GET", f"/v1/discoveries/{missing}", None),
        ("PATCH", f"/v1/discoveries/{missing}", {"title": "x"}),
        ("DELETE", f"/v1/discoveries/{missing}", None),
        ("POST", f"/v1/discoveries/{missing}/searches", {}),
        ("POST", f"/v1/discoveries/{missing}/evidence", {"kind": "note", "summary": "x"}),
        ("POST", f"/v1/discoveries/{missing}/status", {"status": "computationally-plausible", "justification": "x"}),
    ):
        response = client.request(method, path, json=payload)
        assert response.status_code == 404 and is_error_shape(response.json()), (method, path)
    assert client.delete(f"/v1/discoveries/{second['id']}").status_code == 204
