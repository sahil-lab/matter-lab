"""API contract: every operation of the published OpenAPI schema is called for real, and every
response it documents (success and error) is produced and validated against its schema.

The tests of this module build on each other and run in file order: the last two check that
nothing in the schema was left unexercised.
"""

from __future__ import annotations

import io
import uuid
from dataclasses import replace
from typing import Any, Callable, Iterator

import psycopg
import pytest
from fastapi.testclient import TestClient
from openpyxl import Workbook
from psycopg.conninfo import make_conninfo

from matterlab_science.config import Settings
from matterlab_science.main import create_app

from .helpers import ASPIRIN, ASPIRIN_INCHIKEY, PENTAVALENT_CARBON, Contract, is_error_shape, smiles, wait_for_job

XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
UNLISTED = "OC(=O)C1CC1c1ccncc1"


class Driver:
    """Sends requests, validates each response against the schema and remembers what was covered."""

    def __init__(self, client: TestClient) -> None:
        self.client = client
        self.contract = Contract(client.app.openapi())  # type: ignore[attr-defined]
        self.seen: set[tuple[str, str, int]] = set()
        self.successful: dict[tuple[str, str], tuple[str, dict[str, Any]]] = {}

    def call(self, method: str, template: str, expect: int, url: str | None = None, **kwargs: Any) -> Any:
        target = url or template
        response = self.client.request(method, target, **kwargs)
        assert response.status_code == expect, f"{method} {target}: expected {expect}, got {response.status_code}: {response.text[:400]}"
        body = self.contract.check(method, template, response)
        if expect >= 400:
            assert is_error_shape(body), f"{method} {target} {expect}: not the documented error shape: {body}"
        else:
            self.successful.setdefault((method, template), (target, kwargs))
        self.seen.add((method, template, expect))
        return body

    def documented(self) -> set[tuple[str, str, int]]:
        return {
            (method.upper(), path, int(status))
            for path, item in self.contract.spec["paths"].items()
            for method, operation in item.items()
            for status in operation["responses"]
        }


@pytest.fixture(scope="module")
def api(client: TestClient) -> Driver:
    return Driver(client)


@pytest.fixture(scope="module")
def state() -> dict[str, Any]:
    """Identifiers of records created by earlier tests of this module."""
    return {}


def missing() -> str:
    return str(uuid.uuid4())


# ---------------------------------------------------------------------------------------------
# The schema itself
# ---------------------------------------------------------------------------------------------


def test_openapi_schema_is_served_and_well_formed(client: TestClient, api: Driver) -> None:
    served = client.get("/openapi.json")
    assert served.status_code == 200 and served.json() == api.contract.spec
    docs = client.get("/docs")
    assert docs.status_code == 200 and "swagger" in docs.text.lower() and "/openapi.json" in docs.text

    spec = api.contract.spec
    assert spec["info"]["title"] == "MATTER LAB science service" and spec["info"]["version"]
    operations = [(method.upper(), path, operation) for path, item in spec["paths"].items() for method, operation in item.items()]
    assert len(operations) == 49
    assert len({operation["operationId"] for _, _, operation in operations}) == len(operations)
    tags = {tag["name"] for tag in spec["tags"]}
    for method, path, operation in operations:
        where = f"{method} {path}"
        assert path in ("/", "/health") or path.startswith("/v1/"), f"{where} is not versioned"
        assert operation.get("summary") and set(operation.get("tags", [])) <= tags and operation.get("tags"), where
        successes = [status for status in operation["responses"] if status.startswith("2")]
        assert len(successes) == 1, f"{where} documents exactly one success response"
        for status, response in operation["responses"].items():
            content = response.get("content", {})
            if status == "204":
                assert not content, where
            elif status.startswith("2"):
                assert content and all("schema" in media for media in content.values()), f"{where} {status} has no response schema"
            else:
                assert content["application/json"]["schema"] == {"$ref": "#/components/schemas/ErrorResponse"}, f"{where} {status} is not the common error shape"
    # No operation is documented with FastAPI's default validation-error body; the service never sends it.
    assert "HTTPValidationError" not in spec["components"]["schemas"]


# ---------------------------------------------------------------------------------------------
# Service and chemistry
# ---------------------------------------------------------------------------------------------


def test_service_endpoints(api: Driver, settings: Settings) -> None:
    root = api.call("GET", "/", 200)
    assert root["api_base"] == "/v1" and root["docs"] == "/docs"
    health = api.call("GET", "/health", 200)
    newest = max(path.name[:4] for path in settings.migrations_dir.glob("*.sql"))
    assert health["status"] == "ok" and health["database"]["connected"] is True and health["database"]["schema_version"] == newest
    assert health["jobs"]["supervisor_running"] is True and health["time"].endswith("Z")
    engines = api.call("GET", "/v1/engines", 200)
    assert {e["id"] for e in engines["engines"]} == {"rdkit", "xtb", "pyscf"}
    assert health["engines"] == {e["id"]: (e["version"] if e["available"] else None) for e in engines["engines"]}


def test_chemistry_endpoints(api: Driver) -> None:
    assert api.call("POST", "/v1/chem/validate", 200, json={"structure": smiles("c1ccccc1")})["valid"] is True
    assert api.call("POST", "/v1/chem/validate", 200, json={"structure": smiles(PENTAVALENT_CARBON)})["valid"] is False
    assert api.call("POST", "/v1/chem/validate", 422, json={"structure": {"format": "smiles"}})["error"]["code"] == "validation_error"

    assert api.call("POST", "/v1/chem/3d", 200, json={"structure": smiles("CCO")})["embedding"]["succeeded"] is True
    assert api.call("POST", "/v1/chem/3d", 422, json={"structure": smiles(PENTAVALENT_CARBON)})["error"]["code"] == "invalid_structure"

    assert api.call("POST", "/v1/chem/descriptors", 200, json={"structure": smiles(ASPIRIN)})["inchikey"] == ASPIRIN_INCHIKEY
    assert api.call("POST", "/v1/chem/descriptors", 422, json={"structure": smiles("C(C")})["error"]["code"] == "invalid_structure"

    assert api.call("POST", "/v1/chem/functional-groups", 200, json={"structure": smiles(ASPIRIN)})["groups"]
    assert api.call("POST", "/v1/chem/functional-groups", 422, json={"structure": smiles("CCO"), "sets": ["nope"]})["error"]["code"] == "unknown_functional_group_set"


# ---------------------------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------------------------


def test_job_endpoints(api: Driver, state: dict[str, Any]) -> None:
    kinds = api.call("GET", "/v1/job-kinds", 200)["kinds"]
    assert {k["kind"] for k in kinds} == {"rdkit.geometry_optimization", "rdkit.conformer_search", "xtb.single_point", "xtb.geometry_optimization", "pyscf.single_point"}

    accepted = api.call("POST", "/v1/jobs", 202, json={"kind": "rdkit.geometry_optimization", "input": {"structure": smiles("CCO")}})
    assert api.call("POST", "/v1/jobs", 422, json={"kind": "nope", "input": {}})["error"]["code"] == "validation_error"
    job = wait_for_job(api.client, accepted["id"])
    assert job["status"] == "succeeded"
    state["job"] = job

    listing = api.call("GET", "/v1/jobs", 200, params={"limit": 5, "input_hash": job["input_hash"]})
    assert job["id"] in [item["id"] for item in listing["items"]]
    api.call("GET", "/v1/jobs", 422, params={"limit": 0})

    assert api.call("GET", "/v1/jobs/{job_id}", 200, f"/v1/jobs/{job['id']}")["result"] == job["result"]
    assert api.call("GET", "/v1/jobs/{job_id}", 404, f"/v1/jobs/{missing()}")["error"]["code"] == "not_found"
    api.call("GET", "/v1/jobs/{job_id}", 422, "/v1/jobs/not-a-uuid")

    # Cancelling a finished job returns it unchanged.
    assert api.call("DELETE", "/v1/jobs/{job_id}", 200, f"/v1/jobs/{job['id']}")["status"] == "succeeded"
    api.call("DELETE", "/v1/jobs/{job_id}", 404, f"/v1/jobs/{missing()}")
    api.call("DELETE", "/v1/jobs/{job_id}", 422, "/v1/jobs/not-a-uuid")


# ---------------------------------------------------------------------------------------------
# Reference data and catalogue
# ---------------------------------------------------------------------------------------------


def test_reference_endpoints(api: Driver) -> None:
    sources = api.call("GET", "/v1/data-sources", 200)
    assert sources["total"] == len(sources["items"]) >= 8
    assert api.call("GET", "/v1/elements", 200)["total"] == 118
    assert api.call("GET", "/v1/elements/{element}", 200, "/v1/elements/Fe")["atomic_number"] == 26
    assert api.call("GET", "/v1/elements/{element}", 200, "/v1/elements/26")["symbol"] == "Fe"
    assert api.call("GET", "/v1/elements/{element}", 404, "/v1/elements/Xx")["error"]["code"] == "not_found"
    api.call("GET", "/v1/elements/{element}", 404, "/v1/elements/119")
    api.call("GET", "/v1/elements/{element}", 422, "/v1/elements/iron")

    hydrogen = api.call("GET", "/v1/isotopes", 200, params={"symbol": "H"})
    assert hydrogen["total"] == len(hydrogen["items"]) > 0 and {item["atomic_number"] for item in hydrogen["items"]} == {1}
    api.call("GET", "/v1/isotopes", 422, params={"atomic_number": 0})

    sets = api.call("GET", "/v1/functional-groups/sets", 200)["sets"]
    assert sum(s["definition_count"] for s in sets) == api.call("GET", "/v1/functional-groups", 200, params={"limit": 5})["total"]
    api.call("GET", "/v1/functional-groups", 422, params={"limit": 0})

    for collection, template in (("solvents", "/v1/solvents/{solvent_id}"), ("catalysts", "/v1/catalysts/{catalyst_id}")):
        page = api.call("GET", f"/v1/{collection}", 200, params={"limit": 3})
        assert len(page["items"]) == 3 and page["total"] > 3
        api.call("GET", f"/v1/{collection}", 422, params={"limit": 0})
        first = page["items"][0]
        assert api.call("GET", template, 200, f"/v1/{collection}/{first['id']}")["name"] == first["name"]
        api.call("GET", template, 404, f"/v1/{collection}/{missing()}")
        api.call("GET", template, 422, f"/v1/{collection}/not-a-uuid")


def test_catalogue_endpoints(api: Driver) -> None:
    found = api.call("GET", "/v1/compounds", 200, params={"name": "aspirin"})
    assert [item["inchikey"] for item in found["items"]] == [ASPIRIN_INCHIKEY]
    api.call("GET", "/v1/compounds", 422, params={"inchikey": "not-a-key"})

    exact = api.call("POST", "/v1/compounds/search/exact", 200, json={"structure": smiles(ASPIRIN)})
    assert [m["inchikey"] for m in exact["matches"]] == [ASPIRIN_INCHIKEY]
    assert api.call("POST", "/v1/compounds/search/exact", 422, json={"structure": smiles("C(C")})["error"]["code"] == "invalid_structure"

    substructure = api.call("POST", "/v1/compounds/search/substructure", 200, json={"query": {"format": "smarts", "data": "c1ccccc1C(=O)[OH]"}, "limit": 5})
    assert substructure["matches"]
    assert api.call("POST", "/v1/compounds/search/substructure", 422, json={"query": {"format": "smarts", "data": "[#6"}})["error"]["code"] == "invalid_query"

    similar = api.call("POST", "/v1/compounds/search/similarity", 200, json={"structure": smiles(ASPIRIN), "threshold": 0.5, "limit": 5})
    assert similar["hits"][0]["similarity"] == 1.0
    api.call("POST", "/v1/compounds/search/similarity", 422, json={"structure": smiles(ASPIRIN), "threshold": 2})

    compound_id = found["items"][0]["id"]
    assert api.call("GET", "/v1/compounds/{compound_id}", 200, f"/v1/compounds/{compound_id}")["inchikey"] == ASPIRIN_INCHIKEY
    api.call("GET", "/v1/compounds/{compound_id}", 404, f"/v1/compounds/{missing()}")
    api.call("GET", "/v1/compounds/{compound_id}", 422, "/v1/compounds/not-a-uuid")


# ---------------------------------------------------------------------------------------------
# Reactions, experiments, discoveries
# ---------------------------------------------------------------------------------------------


def test_reaction_endpoints(api: Driver, state: dict[str, Any]) -> None:
    created = api.call("POST", "/v1/reactions", 201, json={"name": "Contract reaction", "reaction_smiles": "C=C.[H][H]>>CC"})
    assert created["balanced"] is True
    assert api.call("POST", "/v1/reactions", 422, json={"name": "Broken", "reaction_smiles": "CC>>C(C"})["error"]["code"] == "invalid_reaction"
    assert created["id"] in [r["id"] for r in api.call("GET", "/v1/reactions", 200, params={"limit": 500})["items"]]
    api.call("GET", "/v1/reactions", 422, params={"limit": 0})
    assert api.call("GET", "/v1/reactions/{reaction_id}", 200, f"/v1/reactions/{created['id']}") == created
    api.call("GET", "/v1/reactions/{reaction_id}", 404, f"/v1/reactions/{missing()}")
    api.call("GET", "/v1/reactions/{reaction_id}", 422, "/v1/reactions/not-a-uuid")

    disposable = api.call("POST", "/v1/reactions", 201, json={"name": "Disposable", "reaction_smiles": "CC>>C=C.[H][H]"})
    assert api.call("DELETE", "/v1/reactions/{reaction_id}", 204, f"/v1/reactions/{disposable['id']}") is None
    api.call("DELETE", "/v1/reactions/{reaction_id}", 404, f"/v1/reactions/{disposable['id']}")
    api.call("DELETE", "/v1/reactions/{reaction_id}", 422, "/v1/reactions/not-a-uuid")
    state["reaction"] = created


def test_experiment_endpoints(api: Driver, state: dict[str, Any]) -> None:
    job, reaction = state["job"], state["reaction"]
    created = api.call("POST", "/v1/experiments", 201, json={"title": "Contract experiment", "reaction_id": reaction["id"], "calculation_ids": [job["id"]]})
    path, template = f"/v1/experiments/{created['id']}", "/v1/experiments/{experiment_id}"
    assert created["revision"] == 1 and [c["id"] for c in created["calculations"]] == [job["id"]]
    api.call("POST", "/v1/experiments", 422, json={"description": "no title"})
    assert api.call("POST", "/v1/experiments", 422, json={"title": "x", "calculation_ids": [missing()]})["error"]["code"] == "unknown_reference"

    assert created["id"] in [x["id"] for x in api.call("GET", "/v1/experiments", 200, params={"q": "contract"})["items"]]
    api.call("GET", "/v1/experiments", 422, params={"limit": 0})
    assert api.call("GET", template, 200, path) == created
    api.call("GET", template, 404, f"/v1/experiments/{missing()}")
    api.call("GET", template, 422, "/v1/experiments/not-a-uuid")

    replaced = api.call("PUT", template, 200, path, json={"title": "Replaced", "calculation_ids": [job["id"]], "expected_revision": 1})
    assert replaced["revision"] == 2 and replaced["reaction_id"] is None
    api.call("PUT", template, 404, f"/v1/experiments/{missing()}", json={"title": "x"})
    assert api.call("PUT", template, 409, path, json={"title": "x", "expected_revision": 1})["error"]["code"] == "revision_conflict"
    api.call("PUT", template, 422, path, json={"notes": "no title"})

    patched = api.call("PATCH", template, 200, path, json={"notes": "patched", "expected_revision": 2})
    assert patched["revision"] == 3 and patched["title"] == "Replaced" and patched["notes"] == "patched"
    api.call("PATCH", template, 404, f"/v1/experiments/{missing()}", json={"notes": "x"})
    api.call("PATCH", template, 409, path, json={"notes": "x", "expected_revision": 1})
    api.call("PATCH", template, 422, path, json={"title": None})

    rerun = api.call("POST", "/v1/experiments/{experiment_id}/rerun", 202, f"{path}/rerun")
    assert len(rerun["submitted"]) == 1 and rerun["submitted"][0]["input_hash"] == job["input_hash"]
    assert wait_for_job(api.client, rerun["submitted"][0]["id"])["status"] == "succeeded"
    api.call("POST", "/v1/experiments/{experiment_id}/rerun", 404, f"/v1/experiments/{missing()}/rerun")
    api.call("POST", "/v1/experiments/{experiment_id}/rerun", 422, "/v1/experiments/not-a-uuid/rerun")

    assert api.call("DELETE", template, 204, path) is None
    api.call("DELETE", template, 404, path)
    api.call("DELETE", template, 422, "/v1/experiments/not-a-uuid")


def test_discovery_endpoints(api: Driver) -> None:
    created = api.call("POST", "/v1/discoveries", 201, json={"title": "Contract candidate", "structure": smiles(UNLISTED)})
    path, template = f"/v1/discoveries/{created['id']}", "/v1/discoveries/{discovery_id}"
    assert created["status"] == "no-match-in-searched-catalogs" and created["searched_catalogs"]
    api.call("POST", "/v1/discoveries", 422, json={"title": "No structure"})
    invalid = api.call("POST", "/v1/discoveries", 201, json={"title": "Impossible carbon", "structure": smiles(PENTAVALENT_CARBON)})
    assert invalid["status"] == "user-created"

    assert created["id"] in [d["id"] for d in api.call("GET", "/v1/discoveries", 200, params={"limit": 500})["items"]]
    api.call("GET", "/v1/discoveries", 422, params={"status": "novel"})
    assert api.call("GET", template, 200, path) == created
    api.call("GET", template, 404, f"/v1/discoveries/{missing()}")
    api.call("GET", template, 422, "/v1/discoveries/not-a-uuid")

    assert api.call("PATCH", template, 200, path, json={"notes": "second thoughts"})["notes"] == "second thoughts"
    api.call("PATCH", template, 404, f"/v1/discoveries/{missing()}", json={"notes": "x"})
    api.call("PATCH", template, 422, path, json={"status": "independently-validated"})

    searches = "/v1/discoveries/{discovery_id}/searches"
    again = api.call("POST", searches, 200, f"{path}/searches", json={})
    assert len(again["catalog_searches"]) > len(created["catalog_searches"])
    api.call("POST", searches, 404, f"/v1/discoveries/{missing()}/searches", json={})
    assert api.call("POST", searches, 409, f"/v1/discoveries/{invalid['id']}/searches", json={})["error"]["code"] == "structure_not_valid"
    api.call("POST", searches, 422, f"{path}/searches", json={"query_pubchem": "perhaps"})

    evidence = "/v1/discoveries/{discovery_id}/evidence"
    noted = api.call("POST", evidence, 201, f"{path}/evidence", json={"kind": "note", "summary": "Looks interesting"})
    assert noted["evidence"][-1]["kind"] == "note" and noted["evidence"][-1]["recorded_by"] == "user"
    api.call("POST", evidence, 404, f"/v1/discoveries/{missing()}/evidence", json={"kind": "note", "summary": "x"})
    api.call("POST", evidence, 422, f"{path}/evidence", json={"kind": "note"})

    status = "/v1/discoveries/{discovery_id}/status"
    same = api.call("POST", status, 200, f"{path}/status", json={"status": created["status"], "justification": "unchanged"})
    assert same["status"] == created["status"]
    api.call("POST", status, 404, f"/v1/discoveries/{missing()}/status", json={"status": "user-created", "justification": "x"})
    refused = api.call("POST", status, 409, f"{path}/status", json={"status": "independently-validated", "justification": "skipping ahead"})
    assert refused["error"]["details"]["current_status"] == created["status"]
    api.call("POST", status, 422, f"{path}/status", json={"status": "novel", "justification": "x"})

    assert api.call("DELETE", template, 204, path) is None
    api.call("DELETE", template, 404, path)
    api.call("DELETE", template, 422, "/v1/discoveries/not-a-uuid")
    api.client.delete(f"/v1/discoveries/{invalid['id']}")


# ---------------------------------------------------------------------------------------------
# Excel
# ---------------------------------------------------------------------------------------------


def test_excel_endpoints(api: Driver, override_settings: Callable[..., None]) -> None:
    layout = api.call("GET", "/v1/excel/format", 200)
    assert len(layout["sheets"]) == 10
    assert api.call("GET", "/v1/excel/export", 200) is None, "the export is a binary workbook, not JSON"

    # A workbook with one sheet that has the right header and no rows: valid, and changes nothing.
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Reactions"
    reactions = next(s for s in layout["sheets"] if s["name"] == "Reactions")
    sheet.append([column["header"] for column in reactions["columns"]])
    buffer = io.BytesIO()
    workbook.save(buffer)
    report = api.call("POST", "/v1/excel/import", 200, files={"file": ("empty.xlsx", buffer.getvalue(), XLSX)})
    assert report["outcome"] == "applied" and report["totals"]["rows"] == 0 and report["sheets"]["Reactions"]["present"] is True

    assert api.call("POST", "/v1/excel/import", 422, files={"file": ("junk.xlsx", b"not a workbook", XLSX)})["error"]["code"] == "workbook_rejected"
    override_settings(max_upload_bytes=1024)
    too_large = api.call("POST", "/v1/excel/import", 413, files={"file": ("big.xlsx", buffer.getvalue() + b"\0" * 2048, XLSX)})
    assert too_large["error"]["code"] == "payload_too_large" and too_large["error"]["details"] == {"max_bytes": 1024}


# ---------------------------------------------------------------------------------------------
# Database outage, and completeness
# ---------------------------------------------------------------------------------------------


@pytest.fixture()
def outage(base_settings: Settings, database_factory: Callable[[], str]) -> Iterator[TestClient]:
    """A second service instance whose database is dropped from under it once it is running."""
    name = database_factory()
    settings = replace(
        base_settings.with_database(name),
        auto_migrate=True,
        auto_seed=False,
        jobs_enabled=False,
        disabled_engines=frozenset({"xtb", "pyscf"}),
        db_pool_timeout_seconds=0.3,
    )
    with TestClient(create_app(settings)) as client:
        assert client.get("/health").status_code == 200
        with psycopg.connect(make_conninfo(base_settings.database_conninfo, dbname="postgres"), autocommit=True) as admin:
            admin.execute(f'DROP DATABASE "{name}" WITH (FORCE)')
        yield client


def test_database_outage_is_reported_by_every_endpoint_that_needs_the_database(api: Driver, outage: TestClient) -> None:
    down = Driver(outage)
    health = down.call("GET", "/health", 503)
    assert health["error"]["code"] == "database_unavailable" and health["error"]["details"]["database"]["connected"] is False

    needs_database = sorted((method, path) for method, path, status in api.documented() if status == 503 and path != "/health")
    assert len(needs_database) == 41
    for method, template in needs_database:
        assert (method, template) in api.successful, f"{method} {template} was not exercised by the tests above"
        target, kwargs = api.successful[(method, template)]
        body = down.call(method, template, 503, target, **kwargs)
        assert body["error"]["code"] == "database_unavailable", f"{method} {template}"
        assert "PostgreSQL" in body["error"]["message"]

    # Endpoints that do not need the database keep working.
    for method, template in sorted(set(api.successful) - set(needs_database) - {("GET", "/health")}):
        target, kwargs = api.successful[(method, template)]
        down.call(method, template, 200, target, **kwargs)
    api.seen |= {entry for entry in down.seen if entry[2] == 503}


def test_every_operation_and_every_documented_response_was_exercised(api: Driver) -> None:
    documented = api.documented()
    assert {(method, path) for method, path, _ in documented} == api.contract.operations()
    not_exercised = sorted(documented - api.seen)
    assert not not_exercised, f"documented but never produced in this module: {not_exercised}"
    assert api.contract.checked == api.contract.operations(), "every operation returned a schema-valid success response"
