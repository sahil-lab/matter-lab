"""Reference data endpoints: sources, elements, isotopes, functional groups, solvents, catalysts."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from rdkit import Chem, rdBase

from matterlab_science.config import Settings

from .helpers import Contract, is_error_shape


def test_elements_endpoint(client: TestClient, contract: Contract, settings: Settings) -> None:
    body = contract.check("GET", "/v1/elements", client.get("/v1/elements"))
    assert body["total"] == 118 and [e["atomic_number"] for e in body["items"]] == list(range(1, 119))
    generated = {e["z"]: e for e in json.loads((settings.generated_data_dir / "elements.json").read_text(encoding="utf-8"))["elements"]}
    for element in body["items"]:
        source = generated[element["atomic_number"]]
        assert element["symbol"] == source["symbol"]
        assert element["standard_atomic_weight_u"] == source["atomicWeight"]
        assert element["ionization_energy_ev"] == source["ionizationEnergyEv"]
        assert element["vdw_radius_angstrom"] == source["vdwRadius"] and element["vdw_radius_source"] == source["vdwRadiusSource"]
        assert element["group_number"] == source["group"] and element["block"] == source["block"]
        assert element["evidence"] == "reference"
        provenance = body["sources"][element["source"]]
        assert provenance["source"] == "PubChem Periodic Table" and provenance["url"] and provenance["retrieved"] and provenance["license"]


def test_single_element_with_field_provenance(client: TestClient, contract: Contract) -> None:
    by_symbol = contract.check("GET", "/v1/elements/{element}", client.get("/v1/elements/er"))
    by_number = client.get("/v1/elements/68").json()
    assert by_symbol == by_number and by_symbol["name"] == "Erbium" and by_symbol["color_source"] == "jmol"
    fields = {p["provenance"]["source_key"]: set(p["fields"]) for p in by_symbol["field_provenance"]}
    assert fields["jmol-element-colors"] == {"cpk_color_hex"}
    assert "density_g_per_cm3" in fields["pubchem-periodic-table"] and "covalent_radius_angstrom" in fields["rdkit-periodic-table"]
    assert not fields["pubchem-periodic-table"] & fields["rdkit-periodic-table"], "a field has one source"
    rdkit_source = next(p["provenance"] for p in by_symbol["field_provenance"] if p["provenance"]["source_key"] == "rdkit-periodic-table")
    assert rdkit_source["version"] and rdkit_source["license"]

    for missing in ("119", "0", "Xx"):
        response = client.get(f"/v1/elements/{missing}")
        assert response.status_code == 404 and is_error_shape(contract.check("GET", "/v1/elements/{element}", response))


def test_isotopes_endpoint(client: TestClient, contract: Contract, settings: Settings) -> None:
    doc = json.loads((settings.generated_data_dir / "isotopes.json").read_text(encoding="utf-8"))
    hydrogen = [r for r in doc["rows"] if r[0] == 1]
    body = contract.check("GET", "/v1/isotopes", client.get("/v1/isotopes", params={"symbol": "h"}))
    assert body["total"] == len(hydrogen) == len(body["items"])
    protium = body["items"][0]
    assert (protium["atomic_number"], protium["neutron_number"], protium["mass_number"], protium["symbol"]) == (1, 0, 1, "H")
    assert protium["atomic_mass_u"] == hydrogen[0][2] and protium["natural_abundance_percent"] == hydrogen[0][4]
    assert protium["stability"] == "S" and protium["half_life_seconds"] is None and protium["evidence"] == "reference"
    tritium = body["items"][2]
    assert tritium["stability"] == "R" and tritium["half_life_seconds"] == hydrogen[2][5] and tritium["decay_mode"] == hydrogen[2][8]
    provenance = body["sources"][protium["source"]]
    assert provenance["source"] == doc["source"]["source"] and provenance["version"] == doc["source"]["version"]
    assert provenance["retrieved"] == doc["source"]["retrieved"] and len(provenance["citations"]) == len(doc["source"]["citations"])

    everything = client.get("/v1/isotopes", params={"limit": 5000}).json()
    assert everything["total"] == len(doc["rows"]) == len(everything["items"]) and everything["total"] > 3000
    stable = client.get("/v1/isotopes", params={"stability": "S", "limit": 5000}).json()
    assert stable["total"] == sum(1 for r in doc["rows"] if r[6] == "S")
    carbon14 = client.get("/v1/isotopes", params={"atomic_number": 6, "mass_number": 14}).json()
    assert carbon14["total"] == 1 and carbon14["items"][0]["neutron_number"] == 8
    paged = client.get("/v1/isotopes", params={"limit": 3, "offset": 2}).json()
    assert [(i["atomic_number"], i["neutron_number"]) for i in paged["items"]] == [(r[0], r[1]) for r in doc["rows"][2:5]]
    assert client.get("/v1/isotopes", params={"atomic_number": 119}).status_code == 422


def test_data_sources_endpoint(client: TestClient, contract: Contract) -> None:
    body = contract.check("GET", "/v1/data-sources", client.get("/v1/data-sources"))
    keys = {s["key"] for s in body["items"]}
    assert {
        "pubchem-periodic-table",
        "rdkit-periodic-table",
        "jmol-element-colors",
        "iaea-livechart-ground-states",
        "rdkit-data-files",
        "pubchem-compound",
        "rdkit",
        "matterlab-user",
        "matterlab-science",
    } <= keys
    rdkit = next(s for s in body["items"] if s["key"] == "rdkit")
    assert rdkit["version"] == rdBase.rdkitVersion and rdkit["kind"] == "software" and rdkit["license"]
    assert all(s["version"] and s["title"] for s in body["items"])


def test_functional_group_definitions(client: TestClient, contract: Contract) -> None:
    sets = contract.check("GET", "/v1/functional-groups/sets", client.get("/v1/functional-groups/sets"))["sets"]
    by_name = {s["group_set"]: s for s in sets}
    assert set(by_name) == {"rdkit-fragment-descriptors", "rdkit-functional-group-hierarchy", "rdkit-functional-groups"}
    assert by_name["rdkit-functional-groups"]["first_atom_is_attachment_point"] is True
    assert by_name["rdkit-fragment-descriptors"]["first_atom_is_attachment_point"] is False
    assert by_name["rdkit-fragment-descriptors"]["source_file"] == "FragmentDescriptors.csv"

    page = contract.check("GET", "/v1/functional-groups", client.get("/v1/functional-groups", params={"limit": 2000}))
    assert page["total"] == sum(s["definition_count"] for s in sets) == len(page["items"])
    for group in page["items"]:
        assert Chem.MolFromSmarts(group["smarts"]) is not None, group["key"]
        provenance = page["sources"][group["source"]]
        assert provenance["source_key"] == "rdkit-data-files" and provenance["version"] == rdBase.rdkitVersion and provenance["license"]
    hierarchy = client.get("/v1/functional-groups", params={"group_set": "rdkit-functional-group-hierarchy"}).json()
    assert hierarchy["total"] == by_name["rdkit-functional-group-hierarchy"]["definition_count"]
    keys = {g["key"] for g in hierarchy["items"]}
    assert all(g["parent_key"] is None or g["parent_key"] in keys for g in hierarchy["items"])
    assert any(g["parent_key"] for g in hierarchy["items"])


@pytest.mark.parametrize(("path", "template", "what"), [("/v1/solvents", "/v1/solvents/{solvent_id}", "solvent"), ("/v1/catalysts", "/v1/catalysts/{catalyst_id}", "catalyst")])
def test_solvents_and_catalysts(client: TestClient, contract: Contract, settings: Settings, path: str, template: str, what: str) -> None:
    names = json.loads((settings.seed_dir / "pubchem" / "names.json").read_text(encoding="utf-8"))[f"{what}s"]
    snapshot = json.loads((settings.seed_dir / "pubchem" / "snapshot.json").read_text(encoding="utf-8"))
    resolved = {e["name"]: e["chosen_cid"] for e in snapshot["name_resolution"]}
    page = contract.check("GET", path, client.get(path, params={"limit": 1000}))
    assert {i["name"] for i in page["items"]} == {n for n in names if resolved[n] is not None}
    for item in page["items"]:
        record = snapshot["records"][str(resolved[item["name"]])]["properties"]
        assert item["external_ids"]["pubchem_cid"] == resolved[item["name"]]
        assert item["structure_status"] == "rdkit-validated" and item["inchikey"] == record["InChIKey"]
        assert Chem.MolToInchiKey(Chem.MolFromSmiles(item["canonical_smiles"])) == item["inchikey"]
        # The only stored property is the one that was fetched, with its source, unit and retrieval date.
        assert [p["name"] for p in item["properties"]] == ["molecular_weight"]
        prop = item["properties"][0]
        assert prop["value"] == float(record["MolecularWeight"]) and prop["unit"] == "g/mol" and "PubChem" in prop["source"]
        assert prop["retrieved"] == snapshot["retrieved_on"] and prop["evidence"] == "reference"
        assert page["sources"][item["source"]]["source_key"] == "pubchem-compound"

    first = page["items"][0]
    detail = contract.check("GET", template, client.get(f"{path}/{first['id']}"))
    assert detail["name"] == first["name"] and detail["provenance"]["retrieved"] == snapshot["retrieved_on"]
    assert Chem.MolToInchiKey(Chem.MolFromMolBlock(detail["molblock"])) == detail["inchikey"]
    assert detail["derived_by"]["version"] == rdBase.rdkitVersion
    missing = client.get(f"{path}/00000000-0000-4000-8000-000000000000")
    assert missing.status_code == 404 and is_error_shape(contract.check("GET", template, missing))
