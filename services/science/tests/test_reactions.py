"""Reactions: RDKit-validated reaction SMILES with a balance check."""

from __future__ import annotations

from fastapi.testclient import TestClient
from rdkit import rdBase

from .helpers import Contract, is_error_shape


def test_reaction_lifecycle(client: TestClient, contract: Contract) -> None:
    response = client.post(
        "/v1/reactions",
        json={"name": "Hydrogen combustion", "reaction_smiles": " [H][H].[H][H].O=O>>O.O ", "temperature_k": 298.15, "conditions": {"phase": "gas"}},
    )
    created = contract.check("POST", "/v1/reactions", response)
    assert response.status_code == 201
    assert created["reaction_smiles"] == "[H][H].[H][H].O=O>>O.O" and created["balanced"] is True
    assert created["element_imbalance"] == {} and created["charge_imbalance"] == 0
    assert created["evidence"] == "user-input", "the service checks the chemistry of a reaction, not whether it occurs"
    assert created["temperature_k"] == 298.15 and created["pressure_pa"] is None and created["conditions"] == {"phase": "gas"}
    assert created["derived_by"]["version"] == rdBase.rdkitVersion and created["provenance"]["source_key"] == "matterlab-user"
    participants = [(p["role"], p["canonical_smiles"], p["stoichiometric_coefficient"], p["molecular_formula"]) for p in created["participants"]]
    assert participants == [("reactant", "[H][H]", 2, "H2"), ("reactant", "O=O", 1, "O2"), ("product", "O", 2, "H2O")]
    # Species that are in the catalogue are linked to it.
    for participant in created["participants"]:
        linked = client.get(f"/v1/compounds/{participant['compound_id']}").json()
        assert linked["inchikey"] == participant["inchikey"]

    fetched = contract.check("GET", "/v1/reactions/{reaction_id}", client.get(f"/v1/reactions/{created['id']}"))
    assert fetched == created
    listing = contract.check("GET", "/v1/reactions", client.get("/v1/reactions"))
    assert created["id"] in {r["id"] for r in listing["items"]} and listing["total"] >= 1

    deleted = client.delete(f"/v1/reactions/{created['id']}")
    contract.check("DELETE", "/v1/reactions/{reaction_id}", deleted)
    assert deleted.status_code == 204 and deleted.content == b""
    for method in ("GET", "DELETE"):
        gone = client.request(method, f"/v1/reactions/{created['id']}")
        assert gone.status_code == 404 and is_error_shape(contract.check(method, "/v1/reactions/{reaction_id}", gone))


def test_unbalanced_reaction_is_flagged_not_rejected(client: TestClient) -> None:
    response = client.post("/v1/reactions", json={"name": "Methane combustion (unbalanced)", "reaction_smiles": "C.O=O>>O=C=O.O"})
    body = response.json()
    assert response.status_code == 201 and body["balanced"] is False
    assert body["element_imbalance"] == {"H": -2, "O": 1}
    esterification = client.post("/v1/reactions", json={"name": "Fischer esterification", "reaction_smiles": "CC(=O)O.OCC>OS(=O)(=O)O>CC(=O)OCC.O"}).json()
    assert esterification["balanced"] is True, "agents are not part of the balance"
    assert [p["role"] for p in esterification["participants"]] == ["reactant", "reactant", "agent", "product", "product"]
    assert esterification["reaction_smiles"] == "CC(=O)O.CCO>O=S(=O)(O)O>CCOC(C)=O.O"
    charged = client.post("/v1/reactions", json={"name": "Autoprotolysis written one-sided", "reaction_smiles": "O>>[OH-]"}).json()
    assert charged["balanced"] is False and charged["charge_imbalance"] == -1 and charged["element_imbalance"] == {"H": -1}
    for reaction in (body, esterification, charged):
        assert client.delete(f"/v1/reactions/{reaction['id']}").status_code == 204


def test_invalid_reactions_are_rejected_with_reasons(client: TestClient, contract: Contract) -> None:
    cases = {
        "CC>>C(C": "SMILES Parse Error",
        "CC(C)(C)(C)C>>CC": "Explicit valence for atom # 1 C, 5, is greater than permitted",
        "CC>CC": "reactants>agents>products",
        ">>CC": "at least one reactant",
    }
    for text, fragment in cases.items():
        response = client.post("/v1/reactions", json={"name": "bad", "reaction_smiles": text})
        body = contract.check("POST", "/v1/reactions", response)
        assert response.status_code == 422 and is_error_shape(body) and body["error"]["code"] == "invalid_reaction", text
        assert fragment in body["error"]["message"], text
    unknown = client.post("/v1/reactions", json={"name": "x", "reaction_smiles": "C>>C", "solvent_id": "00000000-0000-4000-8000-000000000000"})
    assert unknown.status_code == 422 and unknown.json()["error"]["code"] == "unknown_reference"
    assert client.post("/v1/reactions", json={"name": "x", "reaction_smiles": "C>>C", "temperature_k": -5}).status_code == 422
    assert client.post("/v1/reactions", json={"name": "x", "reaction_smiles": "C>>C", "surprise": 1}).status_code == 422


def test_reaction_with_solvent_and_catalyst(client: TestClient) -> None:
    solvent = client.get("/v1/solvents", params={"limit": 1}).json()["items"][0]
    catalyst = client.get("/v1/catalysts", params={"limit": 1}).json()["items"][0]
    created = client.post(
        "/v1/reactions",
        json={"name": "With conditions", "reaction_smiles": "C=C.[H][H]>>CC", "solvent_id": solvent["id"], "catalyst_id": catalyst["id"], "pressure_pa": 101325},
    ).json()
    assert created["solvent_id"] == solvent["id"] and created["catalyst_id"] == catalyst["id"] and created["pressure_pa"] == 101325
    assert created["balanced"] is True
    assert client.delete(f"/v1/reactions/{created['id']}").status_code == 204
