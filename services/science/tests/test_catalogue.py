"""Tier 4: the compound catalogue and its exact, substructure and similarity searches."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from rdkit import Chem, DataStructs, rdBase

from matterlab_science.chem import fingerprints
from matterlab_science.db import Database

from .helpers import ASPIRIN, ASPIRIN_INCHIKEY, Contract, is_error_shape, smiles


@pytest.fixture(scope="module")
def catalogue(db: Database) -> list[dict]:
    """Every catalogue row straight from PostgreSQL, with an RDKit molecule, for brute-force checks."""
    rows = db.fetch_all("SELECT id, name, canonical_smiles, inchikey, molecular_formula FROM compounds ORDER BY name")
    for row in rows:
        row["mol"] = Chem.MolFromSmiles(row["canonical_smiles"])
        assert row["mol"] is not None
    return rows


def names(items: list[dict]) -> set[str]:
    return {item["name"] for item in items}


# ---------------------------------------------------------------------------------------------
# Exact lookups
# ---------------------------------------------------------------------------------------------


def test_list_compounds_with_provenance(client: TestClient, contract: Contract, catalogue: list[dict]) -> None:
    page = contract.check("GET", "/v1/compounds", client.get("/v1/compounds", params={"limit": 500}))
    assert page["total"] == len(catalogue) == len(page["items"])
    assert 150 <= page["total"] <= 300
    for item in page["items"]:
        source = page["sources"][item["source"]]
        assert source["source_key"] == "pubchem-compound" and source["url"] and source["retrieved"] and source["license"]
        assert isinstance(item["external_ids"]["pubchem_cid"], int)
    second = client.get("/v1/compounds", params={"limit": 10, "offset": 10}).json()
    assert [i["id"] for i in second["items"]] == [i["id"] for i in page["items"][10:20]] and second["total"] == page["total"]


def test_lookup_by_inchikey_name_and_formula(client: TestClient, catalogue: list[dict]) -> None:
    by_key = client.get("/v1/compounds", params={"inchikey": ASPIRIN_INCHIKEY}).json()
    assert by_key["total"] == 1 and by_key["items"][0]["name"] == "Aspirin"
    aspirin_id = by_key["items"][0]["id"]

    for name in ("aspirin", "ASPIRIN", "  Aspirin ", "acetylsalicylic acid", "2-acetyloxybenzoic acid"):
        found = client.get("/v1/compounds", params={"name": name}).json()
        assert [i["id"] for i in found["items"]] == [aspirin_id], name
    assert client.get("/v1/compounds", params={"name": "aspir"}).json()["total"] == 0, "name lookup is exact, not a prefix search"
    assert aspirin_id in {i["id"] for i in client.get("/v1/compounds", params={"q": "aspir"}).json()["items"]}

    by_formula = client.get("/v1/compounds", params={"formula": "C9H8O4"}).json()
    assert names(by_formula["items"]) == {r["name"] for r in catalogue if r["molecular_formula"] == "C9H8O4"} and "Aspirin" in names(by_formula["items"])
    # Isomers share a formula, and the order in which the elements are written does not matter.
    isomers = client.get("/v1/compounds", params={"formula": "OC2H6"}).json()
    assert {"Ethanol", "Dimethyl Ether"} <= names(isomers["items"])
    assert names(isomers["items"]) == {r["name"] for r in catalogue if r["molecular_formula"] == "C2H6O"}
    assert names(client.get("/v1/compounds", params={"formula": "OH2"}).json()["items"]) == {"Water"}

    assert client.get("/v1/compounds", params={"pubchem_cid": 2244}).json()["items"][0]["id"] == aspirin_id
    combined = client.get("/v1/compounds", params={"formula": "C9H8O4", "name": "ethanol"}).json()
    assert combined["total"] == 0, "filters combine with AND"
    assert client.get("/v1/compounds", params={"inchikey": "AAAAAAAAAAAAAA-AAAAAAAAAA-A"}).json()["total"] == 0


def test_lookup_parameter_validation(client: TestClient, contract: Contract) -> None:
    response = client.get("/v1/compounds", params={"inchikey": "not-an-inchikey"})
    body = contract.check("GET", "/v1/compounds", response)
    assert response.status_code == 422 and is_error_shape(body)
    assert client.get("/v1/compounds", params={"limit": 0}).status_code == 422


def test_compound_detail(client: TestClient, contract: Contract) -> None:
    compound_id = client.get("/v1/compounds", params={"inchikey": ASPIRIN_INCHIKEY}).json()["items"][0]["id"]
    body = contract.check("GET", "/v1/compounds/{compound_id}", client.get(f"/v1/compounds/{compound_id}"))
    assert body["name"] == "Aspirin" and body["canonical_smiles"] == "CC(=O)Oc1ccccc1C(=O)O" and body["molecular_formula"] == "C9H8O4"
    assert body["inchi"].startswith("InChI=1S/C9H8O4/") and body["heavy_atom_count"] == 13 and body["formal_charge"] == 0
    assert body["external_ids"] == {"pubchem_cid": 2244}
    assert body["source_url"] == "https://pubchem.ncbi.nlm.nih.gov/compound/2244"
    assert {"name": "Aspirin", "kind": "preferred"} in body["synonyms"] and {"name": "2-acetyloxybenzoic acid", "kind": "iupac"} in body["synonyms"]

    # The stored structure and fingerprints are RDKit's, computed from the source structure.
    assert body["derived_by"]["engine"] == "RDKit" and body["derived_by"]["version"] == rdBase.rdkitVersion
    stored = Chem.MolFromMolBlock(body["molblock"])
    assert Chem.MolToInchiKey(stored) == ASPIRIN_INCHIKEY
    assert Chem.MolToSmiles(stored) == body["canonical_smiles"]
    assert body["morgan_fingerprint_on_bits"] == fingerprints.morgan(Chem.MolFromSmiles(ASPIRIN)).GetNumOnBits()
    assert body["fingerprint_params"]["morgan"]["radius"] == 2 and body["fingerprint_params"]["morgan"]["bits"] == 2048
    assert body["source_record"]["properties"]["InChIKey"] == ASPIRIN_INCHIKEY and body["source_record"]["inchikey_matches_source"] is True

    provenance = body["provenance"]
    assert provenance["source"] == "PubChem Compound (PUG REST)" and provenance["kind"] == "external-service"
    assert provenance["url"] == "https://pubchem.ncbi.nlm.nih.gov/" and provenance["retrieved"] and provenance["license"] and provenance["version"].startswith("snapshot ")

    missing = client.get("/v1/compounds/00000000-0000-4000-8000-000000000000")
    assert missing.status_code == 404 and is_error_shape(contract.check("GET", "/v1/compounds/{compound_id}", missing))


def test_exact_structure_search(client: TestClient, contract: Contract, catalogue: list[dict]) -> None:
    # The same molecule written differently (Kekulé form, other atom order).
    response = client.post("/v1/compounds/search/exact", json={"structure": smiles("OC(=O)C1=CC=CC=C1OC(C)=O")})
    body = contract.check("POST", "/v1/compounds/search/exact", response)
    assert body["query"] == {"canonical_smiles": "CC(=O)Oc1ccccc1C(=O)O", "inchikey": ASPIRIN_INCHIKEY, "molecular_formula": "C9H8O4"}
    assert [m["name"] for m in body["matches"]] == ["Aspirin"] and body["same_connectivity"] == []
    scope = body["scope"]
    assert scope["records_searched"] == len(catalogue) and scope["catalog_key"] == "matterlab-compound-catalogue"
    assert scope["engine"]["version"] == rdBase.rdkitVersion and scope["searched_at"].endswith("Z")
    assert "says nothing about other databases" in scope["note"]

    # Alanine without stereochemistry is not the catalogue's L-alanine, but shares its connectivity.
    racemic = client.post("/v1/compounds/search/exact", json={"structure": smiles("CC(N)C(=O)O")}).json()
    assert racemic["matches"] == []
    assert "L-alanine" in {m["name"].lower() for m in racemic["same_connectivity"]} or any(
        m["inchikey"].startswith(racemic["query"]["inchikey"][:14]) for m in racemic["same_connectivity"]
    )
    assert all(m["inchikey"][:14] == racemic["query"]["inchikey"][:14] and m["inchikey"] != racemic["query"]["inchikey"] for m in racemic["same_connectivity"])
    assert racemic["same_connectivity"], "the stereo-specific catalogue entry is reported as related, not as a match"

    absent = client.post("/v1/compounds/search/exact", json={"structure": smiles("OC(=O)C1CC1c1ccncc1")}).json()
    assert absent["matches"] == [] and absent["same_connectivity"] == [] and absent["scope"]["records_searched"] == len(catalogue)

    invalid = client.post("/v1/compounds/search/exact", json={"structure": smiles("C(C")})
    assert invalid.status_code == 422 and contract.check("POST", "/v1/compounds/search/exact", invalid)["error"]["code"] == "invalid_structure"


# ---------------------------------------------------------------------------------------------
# Substructure search
# ---------------------------------------------------------------------------------------------


def test_substructure_search_agrees_with_a_brute_force_scan(client: TestClient, contract: Contract, catalogue: list[dict]) -> None:
    for fmt, text in (("smarts", "c1ccccc1C(=O)[OH]"), ("smarts", "[NX3;H2][CX4][CX3](=O)[OX2H]"), ("smiles", "c1ccncc1"), ("smarts", "[#6]S(=O)(=O)[#7,#8]"), ("smarts", "[Fe,Pt,Na]")):
        response = client.post("/v1/compounds/search/substructure", json={"query": {"format": fmt, "data": text}, "limit": 500})
        body = contract.check("POST", "/v1/compounds/search/substructure", response)
        query = Chem.MolFromSmarts(text) if fmt == "smarts" else Chem.MolFromSmiles(text)
        expected = {row["name"] for row in catalogue if row["mol"].HasSubstructMatch(query)}
        assert expected, f"the test query {text} should hit something"
        assert names([m["compound"] for m in body["matches"]]) == expected, text
        assert body["total"] == len(expected) and body["scope"]["records_searched"] == len(catalogue)
        assert "science service" in body["scope"]["method"] and "PostgreSQL" in body["scope"]["method"]
        by_name = {row["name"]: row["mol"] for row in catalogue}
        for match in body["matches"]:
            atoms = match["matched_atom_indices"]
            assert len(atoms) == query.GetNumAtoms()
            assert tuple(atoms) in by_name[match["compound"]["name"]].GetSubstructMatches(query, uniquify=False, maxMatches=100000)


def test_substructure_search_known_molecules(client: TestClient) -> None:
    acids = client.post("/v1/compounds/search/substructure", json={"query": {"format": "smarts", "data": "c1ccccc1C(=O)[OH]"}, "limit": 500}).json()
    found = names([m["compound"] for m in acids["matches"]])
    assert {"Aspirin", "Benzoic Acid", "Salicylic Acid"} <= found
    assert not {"Ethanol", "Benzene", "Water", "Acetic Acid"} & found
    aspirin = next(m for m in acids["matches"] if m["compound"]["name"] == "Aspirin")
    mol = Chem.MolFromSmiles(aspirin["compound"]["canonical_smiles"])
    ring = aspirin["matched_atom_indices"][:6]
    assert all(mol.GetAtomWithIdx(i).GetIsAromatic() for i in ring)

    first = client.post("/v1/compounds/search/substructure", json={"query": {"format": "smiles", "data": "c1ccccc1"}, "limit": 5}).json()
    rest = client.post("/v1/compounds/search/substructure", json={"query": {"format": "smiles", "data": "c1ccccc1"}, "limit": 5, "offset": 5}).json()
    assert len(first["matches"]) == 5 and first["total"] == rest["total"] > 10
    assert not {m["compound"]["id"] for m in first["matches"]} & {m["compound"]["id"] for m in rest["matches"]}


def test_substructure_search_rejects_bad_queries(client: TestClient, contract: Contract) -> None:
    response = client.post("/v1/compounds/search/substructure", json={"query": {"format": "smarts", "data": "[#6"}})
    body = contract.check("POST", "/v1/compounds/search/substructure", response)
    assert response.status_code == 422 and is_error_shape(body) and body["error"]["code"] == "invalid_query"
    assert body["error"]["details"]["errors"], "RDKit's own parse message is passed on"
    assert client.post("/v1/compounds/search/substructure", json={"query": {"format": "inchi", "data": "x"}}).status_code == 422


# ---------------------------------------------------------------------------------------------
# Similarity search
# ---------------------------------------------------------------------------------------------


def test_similarity_search_agrees_with_rdkit(client: TestClient, contract: Contract, catalogue: list[dict]) -> None:
    response = client.post("/v1/compounds/search/similarity", json={"structure": smiles(ASPIRIN), "threshold": 0.25, "limit": 500})
    body = contract.check("POST", "/v1/compounds/search/similarity", response)
    query = fingerprints.morgan(Chem.MolFromSmiles(ASPIRIN))
    expected = {}
    for row in catalogue:
        score = DataStructs.TanimotoSimilarity(query, fingerprints.morgan(row["mol"]))
        if score >= 0.25:
            expected[row["name"]] = score
    hits = {h["compound"]["name"]: h["similarity"] for h in body["hits"]}
    assert set(hits) == set(expected)
    for name, score in expected.items():
        assert hits[name] == pytest.approx(score, abs=1e-12), name
    scores = [h["similarity"] for h in body["hits"]]
    assert scores == sorted(scores, reverse=True)
    assert body["hits"][0]["compound"]["name"] == "Aspirin" and body["hits"][0]["similarity"] == 1.0
    assert "Salicylic Acid" in hits and 0.25 <= hits["Salicylic Acid"] < 1.0
    assert body["total_at_or_above_threshold"] == len(expected) and body["scope"]["records_searched"] == len(catalogue)
    assert "Tanimoto" in body["scope"]["method"] and "science service" in body["scope"]["method"]


def test_similarity_threshold_and_limit(client: TestClient, contract: Contract) -> None:
    identical = client.post("/v1/compounds/search/similarity", json={"structure": smiles(ASPIRIN), "threshold": 1.0}).json()
    assert [h["compound"]["name"] for h in identical["hits"]] == ["Aspirin"]
    limited = client.post("/v1/compounds/search/similarity", json={"structure": smiles(ASPIRIN), "threshold": 0.1, "limit": 3}).json()
    assert len(limited["hits"]) == 3 and limited["total_at_or_above_threshold"] > 3 and limited["limit"] == 3
    everything = client.post("/v1/compounds/search/similarity", json={"structure": smiles("CCO"), "threshold": 0.0, "limit": 500}).json()
    assert everything["total_at_or_above_threshold"] == everything["scope"]["records_searched"]
    nothing = client.post("/v1/compounds/search/similarity", json={"structure": smiles("[Og]"), "threshold": 0.9}).json()
    assert nothing["hits"] == [] and nothing["total_at_or_above_threshold"] == 0

    for bad in ({"structure": smiles("CCO"), "threshold": 1.5}, {"structure": smiles("CCO"), "limit": 0}, {"structure": smiles("C(C")}):
        response = client.post("/v1/compounds/search/similarity", json=bad)
        assert response.status_code == 422 and is_error_shape(contract.check("POST", "/v1/compounds/search/similarity", response))


def test_search_index_follows_the_database(client: TestClient, db: Database, ctx: object) -> None:
    """The in-service index is only a view of PostgreSQL: a new row is searchable at once."""
    from matterlab_science.catalogue.records import compound_fields, parse_or_reject, upsert_compound

    probe = smiles("OC(=O)C1CC1c1ccncc1")
    before = client.post("/v1/compounds/search/exact", json={"structure": probe}).json()
    assert before["matches"] == []
    with db.connection() as conn:
        compound_id, outcome = upsert_compound(
            conn,
            name="Temporary test compound",
            fields=compound_fields(parse_or_reject("smiles", probe["data"]).mol),
            source_id=ctx.user_source_id,  # type: ignore[attr-defined]
            synonyms=[("Temporary test compound", "preferred")],
        )
    assert outcome == "inserted"
    try:
        after = client.post("/v1/compounds/search/exact", json={"structure": probe}).json()
        assert [m["name"] for m in after["matches"]] == ["Temporary test compound"]
        assert after["scope"]["records_searched"] == before["scope"]["records_searched"] + 1
        similar = client.post("/v1/compounds/search/similarity", json={"structure": probe, "threshold": 1.0}).json()
        assert [h["compound"]["name"] for h in similar["hits"]] == ["Temporary test compound"]
        sub = client.post("/v1/compounds/search/substructure", json={"query": {"format": "smiles", "data": "C1CC1c1ccncc1"}}).json()
        assert "Temporary test compound" in names([m["compound"] for m in sub["matches"]])
    finally:
        db.execute("DELETE FROM compounds WHERE id = %s", (compound_id,))
    gone = client.post("/v1/compounds/search/similarity", json={"structure": probe, "threshold": 1.0}).json()
    assert gone["hits"] == [] and gone["scope"]["records_searched"] == before["scope"]["records_searched"]
