"""Tier 2: RDKit chemistry endpoints (validation, 3D coordinates, descriptors, functional groups)."""

from __future__ import annotations

import math

import pytest
from fastapi.testclient import TestClient
from rdkit import Chem, rdBase
from rdkit.Chem import Crippen, Descriptors, rdMolDescriptors

from .helpers import ASPIRIN, ASPIRIN_INCHIKEY, BENZENE_INCHIKEY, PENTAVALENT_CARBON, Contract, is_error_shape, smiles

METHYL_MOLBLOCK = """
     RDKit          3D

  4  3  0  0  0  0  0  0  0  0999 V2000
    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0
    1.0900    0.0000    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0
   -0.3600    1.0300    0.0000 H   0  0  0  0  0  0  0  0  0  0  0  0
   -0.3600   -0.5100    0.8900 H   0  0  0  0  0  0  0  0  0  0  0  0
  1  2  1  0
  1  3  1  0
  1  4  1  0
M  END
"""


def validate(client: TestClient, structure: dict, **extra: object) -> dict:
    response = client.post("/v1/chem/validate", json={"structure": structure, **extra})
    assert response.status_code == 200, response.text
    return response.json()


# ---------------------------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------------------------


def test_benzene_is_valid_and_fully_described(client: TestClient, contract: Contract) -> None:
    response = client.post("/v1/chem/validate", json={"structure": smiles("C1=CC=CC=C1")})
    body = contract.check("POST", "/v1/chem/validate", response)
    assert body["valid"] is True and body["stage"] == "complete"
    assert body["sanitization"] == {"status": "ok", "failed_operation": None, "hydrogen_model": "implicit"}
    assert body["errors"] == []
    assert body["engine"] == {"engine": "RDKit", "version": rdBase.rdkitVersion, "inchi_software_version": Chem.inchi.GetInchiVersion()}
    structure = body["structure"]
    assert structure["canonical_smiles"] == "c1ccccc1"
    assert structure["inchi"] == "InChI=1S/C6H6/c1-2-4-6-5-3-1/h1-6H"
    assert structure["inchikey"] == BENZENE_INCHIKEY
    assert structure["molecular_formula"] == "C6H6"
    reference = Chem.MolFromSmiles("c1ccccc1")
    assert structure["monoisotopic_mass_u"] == pytest.approx(Descriptors.ExactMolWt(reference), abs=1e-9)
    assert structure["molecular_weight_g_per_mol"] == pytest.approx(Descriptors.MolWt(reference), abs=1e-9)
    assert structure["formal_charge"] == 0 and structure["radical_electrons"] == 0
    assert structure["atom_count"] == 6 and structure["implicit_hydrogen_count"] == 6 and structure["heavy_atom_count"] == 6
    assert structure["rings"]["ring_count"] == 1 and structure["rings"]["aromatic_ring_count"] == 1 and structure["rings"]["aromatic_atom_count"] == 6
    assert structure["rings"]["rings"][0] == {"size": 6, "atom_indices": [0, 1, 2, 3, 4, 5], "aromatic": True}
    assert all(atom["aromatic"] and atom["in_ring"] and atom["hybridization"] == "SP2" for atom in structure["atoms"])
    assert structure["stereo"]["unspecified_count"] == 0


def test_pentavalent_carbon_reports_rdkits_valence_error(client: TestClient, contract: Contract) -> None:
    response = client.post("/v1/chem/validate", json={"structure": smiles(PENTAVALENT_CARBON)})
    body = contract.check("POST", "/v1/chem/validate", response)
    assert body["valid"] is False
    assert body["stage"] == "sanitization"
    assert body["sanitization"]["status"] == "failed" and body["sanitization"]["failed_operation"] == "SANITIZE_PROPERTIES"
    assert body["structure"] is None
    assert body["errors"] == [
        {"type": "AtomValenceException", "message": "Explicit valence for atom # 1 C, 5, is greater than permitted", "atom_indices": [1]}
    ]
    # The message is RDKit's, not ours: RDKit raises the very same text.
    with pytest.raises(Chem.AtomValenceException, match="Explicit valence for atom # 1 C, 5, is greater than permitted"):
        Chem.SanitizeMol(Chem.MolFromSmiles(PENTAVALENT_CARBON, sanitize=False))


@pytest.mark.parametrize(
    ("text", "stage", "problem_type", "fragment"),
    [
        ("c1cccc1", "sanitization", "KekulizeException", "Can't kekulize mol"),
        ("C(C", "parse", "ParseError", "SMILES Parse Error"),
        ("c1ccccc", "parse", "ParseError", "unclosed ring"),
        ("not a molecule", "parse", "ParseError", "SMILES Parse Error"),
    ],
)
def test_invalid_smiles_carry_rdkit_messages(client: TestClient, text: str, stage: str, problem_type: str, fragment: str) -> None:
    body = validate(client, smiles(text))
    assert body["valid"] is False and body["stage"] == stage and body["structure"] is None
    assert body["errors"], "an invalid structure must say why"
    assert body["errors"][0]["type"] == problem_type
    assert any(fragment in error["message"] for error in body["errors"])


def test_kekulization_error_names_the_atoms(client: TestClient) -> None:
    body = validate(client, smiles("c1cccc1"))
    assert body["errors"][0]["atom_indices"] == [0, 1, 2, 3, 4]
    assert body["sanitization"]["failed_operation"] == "SANITIZE_KEKULIZE"


def test_invalid_molblock_is_reported(client: TestClient) -> None:
    garbage = validate(client, {"format": "molblock", "data": "this is not a molfile"})
    assert garbage["valid"] is False and garbage["stage"] == "parse" and garbage["errors"][0]["type"] == "ParseError"
    pentavalent = Chem.MolToMolBlock(Chem.MolFromSmiles(PENTAVALENT_CARBON, sanitize=False))
    body = validate(client, {"format": "molblock", "data": pentavalent})
    assert body["valid"] is False
    assert body["errors"][0]["message"] == "Explicit valence for atom # 1 C, 5, is greater than permitted"


def test_stereo_information(client: TestClient) -> None:
    alanine = validate(client, smiles("C[C@H](N)C(=O)O"))["structure"]
    assert alanine["stereo"]["tetrahedral_centers"] == [{"atom_index": 1, "specified": True, "cip_label": "S"}]
    assert alanine["atoms"][1]["cip_label"] == "S"
    assert alanine["inchi"].endswith("/t2-/m0/s1")

    butene = validate(client, smiles("C/C=C/C"))["structure"]
    assert butene["stereo"]["double_bonds"] == [{"bond_index": 1, "begin_atom_index": 1, "end_atom_index": 2, "specified": True, "cip_label": "E"}]

    unspecified = validate(client, smiles("CC(F)Cl"))
    assert unspecified["structure"]["stereo"]["unspecified_count"] == 1
    assert unspecified["structure"]["stereo"]["tetrahedral_centers"] == [{"atom_index": 1, "specified": False, "cip_label": None}]
    assert any("unspecified" in warning for warning in unspecified["warnings"])


def test_charges_radicals_and_fragments(client: TestClient) -> None:
    ammonium = validate(client, smiles("C[N+](C)(C)C"))["structure"]
    assert ammonium["formal_charge"] == 1 and ammonium["atoms"][1]["formal_charge"] == 1
    methyl = validate(client, smiles("[CH3]"))["structure"]
    assert methyl["radical_electrons"] == 1 and methyl["atoms"][0]["radical_electrons"] == 1
    salt = validate(client, smiles("[Na+].[Cl-]"))["structure"]
    assert salt["fragment_count"] == 2 and salt["formal_charge"] == 0
    labelled = validate(client, smiles("[13CH4]"))["structure"]
    assert labelled["atoms"][0]["isotope"] == 13


def test_molblock_keeps_explicit_atoms_and_reports_implied_hydrogens(client: TestClient) -> None:
    implicit = validate(client, {"format": "molblock", "data": METHYL_MOLBLOCK})
    assert implicit["valid"] is True
    assert implicit["structure"]["atom_count"] == 4, "explicit hydrogens of the input stay atoms"
    assert implicit["structure"]["canonical_smiles"] == "C" and implicit["structure"]["molecular_formula"] == "CH4"
    assert implicit["structure"]["implicit_hydrogen_count"] == 1 and implicit["structure"]["atoms"][0]["implicit_hydrogens"] == 1
    assert implicit["structure"]["has_3d_coordinates"] is True

    explicit = validate(client, {"format": "molblock", "data": METHYL_MOLBLOCK.replace("\n", "\r\n")}, implicit_hydrogens=False)
    assert explicit["valid"] is True and explicit["sanitization"]["hydrogen_model"] == "explicit-only"
    assert explicit["structure"]["canonical_smiles"] == "[CH3]" and explicit["structure"]["molecular_formula"] == "CH3"
    assert explicit["structure"]["radical_electrons"] == 1 and explicit["structure"]["implicit_hydrogen_count"] == 0


def test_explicit_hydrogen_model_is_refused_for_smiles(client: TestClient, contract: Contract) -> None:
    response = client.post("/v1/chem/validate", json={"structure": smiles("CC"), "implicit_hydrogens": False})
    body = contract.check("POST", "/v1/chem/validate", response)
    assert response.status_code == 422 and is_error_shape(body) and body["error"]["code"] == "validation_error"


# ---------------------------------------------------------------------------------------------
# 3D coordinates
# ---------------------------------------------------------------------------------------------


def embed(client: TestClient, text: str, **extra: object) -> dict:
    response = client.post("/v1/chem/3d", json={"structure": smiles(text), **extra})
    assert response.status_code == 200, response.text
    return response.json()


def _distance(a: dict, b: dict) -> float:
    return math.dist((a["x"], a["y"], a["z"]), (b["x"], b["y"], b["z"]))


def test_3d_generation_for_ethanol(client: TestClient, contract: Contract) -> None:
    response = client.post("/v1/chem/3d", json={"structure": smiles("CCO")})
    body = contract.check("POST", "/v1/chem/3d", response)
    assert body["succeeded"] is True
    assert body["embedding"]["method"] == "ETKDGv3" and body["embedding"]["succeeded"] is True
    assert body["embedding"]["explicit_hydrogens_added"] == 6
    assert body["force_field"]["used"] == "MMFF94" and body["force_field"]["applied"] is True and body["force_field"]["converged"] is True
    assert body["force_field"]["energy_final_kcal_per_mol"] <= body["force_field"]["energy_initial_kcal_per_mol"]
    assert body["coordinate_unit"] == "angstrom" and body["energy_unit"] == "kcal/mol"
    assert body["evidence"] == "computed"

    atoms, bonds = body["atoms"], body["bonds"]
    assert [a["element"] for a in atoms] == ["C", "C", "O", "H", "H", "H", "H", "H", "H"]
    assert [a["added_hydrogen"] for a in atoms] == [False] * 3 + [True] * 6
    assert all(a["formal_charge"] == 0 and a["isotope"] is None for a in atoms)
    assert len(bonds) == 8 and all(b["order"] == 1.0 and not b["aromatic"] for b in bonds)
    # Chemically sensible geometry: every bond length is that of a covalent bond.
    for bond in bonds:
        length = _distance(atoms[bond["begin_atom_index"]], atoms[bond["end_atom_index"]])
        assert 0.9 < length < 1.6, f"bond {bond['index']} has length {length:.3f} angstrom"
    assert 1.45 < _distance(atoms[0], atoms[1]) < 1.60
    # The molblock is the same geometry.
    parsed = Chem.MolFromMolBlock(body["molblock"], removeHs=False)
    assert parsed.GetNumAtoms() == 9 and parsed.GetConformer().Is3D()
    assert parsed.GetConformer().GetAtomPosition(2).x == pytest.approx(atoms[2]["x"], abs=1e-3)


def test_3d_generation_is_reproducible_and_seed_dependent(client: TestClient) -> None:
    first = embed(client, "CC(C)Cc1ccc(cc1)C(C)C(=O)O", random_seed=7)
    again = embed(client, "CC(C)Cc1ccc(cc1)C(C)C(=O)O", random_seed=7)
    other = embed(client, "CC(C)Cc1ccc(cc1)C(C)C(=O)O", random_seed=8)
    coords = lambda body: [(a["x"], a["y"], a["z"]) for a in body["atoms"]]  # noqa: E731
    assert coords(first) == coords(again)
    assert coords(first) != coords(other)
    assert first["embedding"]["random_seed"] == 7


def test_aromatic_bonds_have_order_one_and_a_half(client: TestClient) -> None:
    body = embed(client, "c1ccccc1")
    ring = [b for b in body["bonds"] if b["aromatic"]]
    assert len(ring) == 6 and all(b["order"] == 1.5 and b["rdkit_bond_type"] == "AROMATIC" for b in ring)
    assert len(body["atoms"]) == 12
    carbons = body["atoms"][:6]
    centre = [sum(a[k] for a in carbons) / 6 for k in ("x", "y", "z")]
    radii = [math.dist((a["x"], a["y"], a["z"]), centre) for a in carbons]
    assert max(radii) - min(radii) < 0.02, "the ring must be a regular hexagon"
    multiple = embed(client, "C=CC#N")
    assert sorted(b["order"] for b in multiple["bonds"] if b["order"] > 1) == [2.0, 3.0]


def test_uff_fallback_is_stated(client: TestClient) -> None:
    body = embed(client, "CB(O)O")
    assert body["force_field"]["requested"] == "auto" and body["force_field"]["used"] == "UFF"
    assert "MMFF94" in body["force_field"]["fallback_reason"]
    assert any("UFF was used instead of MMFF94" in w for w in body["warnings"])
    strict = embed(client, "CB(O)O", force_field="mmff94")
    assert strict["succeeded"] is True and strict["force_field"]["applied"] is False and strict["force_field"]["used"] is None
    assert strict["force_field"]["unavailable_reasons"]


def test_no_force_field_parameters_is_reported_not_hidden(client: TestClient) -> None:
    body = embed(client, "F[Xe]F")
    assert body["succeeded"] is True and len(body["atoms"]) == 3
    assert body["force_field"]["applied"] is False and body["force_field"]["used"] is None
    assert any("Xe" in reason for reason in body["force_field"]["unavailable_reasons"])
    assert any("raw ETKDG" in w for w in body["warnings"])
    raw = embed(client, "CCO", force_field="none")
    assert raw["force_field"]["applied"] is False and raw["force_field"]["unavailable_reasons"] == []


def test_3d_warns_about_unspecified_stereo(client: TestClient) -> None:
    body = embed(client, "CC(F)Cl")
    assert any("arbitrary configuration" in w for w in body["warnings"])


def test_3d_rejects_invalid_and_oversized_structures(client: TestClient, contract: Contract) -> None:
    response = client.post("/v1/chem/3d", json={"structure": smiles(PENTAVALENT_CARBON)})
    body = contract.check("POST", "/v1/chem/3d", response)
    assert response.status_code == 422 and is_error_shape(body)
    assert body["error"]["code"] == "invalid_structure"
    assert "Explicit valence for atom # 1 C, 5, is greater than permitted" in body["error"]["message"]
    assert body["error"]["details"]["errors"][0]["atom_indices"] == [1]

    response = client.post("/v1/chem/3d", json={"structure": smiles("C" * 400)})
    body = response.json()
    assert response.status_code == 422 and body["error"]["code"] == "structure_too_large"
    assert body["error"]["details"]["atom_count"] == 1202


# ---------------------------------------------------------------------------------------------
# Descriptors
# ---------------------------------------------------------------------------------------------


def test_descriptors_match_rdkit_and_are_labelled(client: TestClient, contract: Contract) -> None:
    response = client.post("/v1/chem/descriptors", json={"structure": smiles(ASPIRIN)})
    body = contract.check("POST", "/v1/chem/descriptors", response)
    assert body["inchikey"] == ASPIRIN_INCHIKEY and body["molecular_formula"] == "C9H8O4"
    values = body["descriptors"]
    mol = Chem.MolFromSmiles(ASPIRIN)
    assert values["molecular_weight"]["value"] == pytest.approx(Descriptors.MolWt(mol)) and values["molecular_weight"]["unit"] == "g/mol"
    assert values["monoisotopic_mass"]["value"] == pytest.approx(Descriptors.ExactMolWt(mol)) and values["monoisotopic_mass"]["unit"] == "u"
    assert values["logp"]["value"] == pytest.approx(Crippen.MolLogP(mol))
    assert values["tpsa"]["value"] == pytest.approx(rdMolDescriptors.CalcTPSA(mol)) and values["tpsa"]["unit"] == "angstrom^2"
    assert values["h_bond_donors"]["value"] == rdMolDescriptors.CalcNumHBD(mol) == 1
    assert values["h_bond_acceptors"]["value"] == rdMolDescriptors.CalcNumHBA(mol)
    assert values["rotatable_bonds"]["value"] == rdMolDescriptors.CalcNumRotatableBonds(mol)
    assert values["heavy_atoms"]["value"] == 13 and values["rings"]["value"] == 1 and values["aromatic_rings"]["value"] == 1

    # The log P is an estimate and must say so; exact quantities must not be called estimates.
    assert values["logp"]["is_estimate"] is True and values["logp"]["evidence"] == "rule-based"
    assert "estimate" in values["logp"]["method"] and "not a measurement" in values["logp"]["method"]
    assert values["tpsa"]["is_estimate"] is True
    assert values["molecular_weight"]["is_estimate"] is False and values["molecular_weight"]["evidence"] == "computed"
    assert all(v["method"] for v in values.values())


def test_descriptors_reject_invalid_structure(client: TestClient, contract: Contract) -> None:
    response = client.post("/v1/chem/descriptors", json={"structure": smiles("C(C")})
    body = contract.check("POST", "/v1/chem/descriptors", response)
    assert response.status_code == 422 and body["error"]["code"] == "invalid_structure"


# ---------------------------------------------------------------------------------------------
# Functional groups
# ---------------------------------------------------------------------------------------------


def test_functional_groups_of_aspirin(client: TestClient, contract: Contract) -> None:
    response = client.post("/v1/chem/functional-groups", json={"structure": smiles(ASPIRIN), "sets": ["rdkit-fragment-descriptors"]})
    body = contract.check("POST", "/v1/chem/functional-groups", response)
    assert body["sets_searched"] == ["rdkit-fragment-descriptors"] and body["evidence"] == "rule-based"
    found = {g["key"]: g for g in body["groups"]}
    assert {"fr_ester", "fr_COO", "fr_Ar_COO", "fr_benzene", "fr_C=O"} <= set(found)
    assert "fr_NH2" not in found and "fr_Al_OH" not in found
    assert found["fr_C=O"]["match_count"] == 2
    assert found["fr_benzene"]["matches"][0]["atom_indices"] == [4, 5, 6, 7, 8, 9]
    # Each match is exactly what RDKit finds with the stored SMARTS.
    mol = Chem.MolFromSmiles(ASPIRIN)
    for group in body["groups"]:
        expected = mol.GetSubstructMatches(Chem.MolFromSmarts(group["smarts"]))
        assert [m["atom_indices"] for m in group["matches"]] == [list(m) for m in expected]
        assert group["provenance"]["source_key"] == "rdkit-data-files" and group["provenance"]["version"] == rdBase.rdkitVersion


def test_functional_groups_ignore_how_hydrogens_are_written(client: TestClient) -> None:
    plain = client.post("/v1/chem/functional-groups", json={"structure": smiles("CCO")}).json()
    molblock = Chem.MolToMolBlock(Chem.AddHs(Chem.MolFromSmiles("CCO")))
    explicit = client.post("/v1/chem/functional-groups", json={"structure": {"format": "molblock", "data": molblock}}).json()
    summary = lambda body: [(g["group_set"], g["key"], [m["atom_indices"] for m in g["matches"]]) for g in body["groups"]]  # noqa: E731
    assert summary(plain) == summary(explicit)
    assert any(g["key"] == "fr_Al_OH" for g in plain["groups"])
    assert len(plain["sets_searched"]) == 3
    attachment = [g for g in plain["groups"] if g["group_set"] == "rdkit-functional-groups"]
    assert attachment and all(m["attachment_atom_index"] is not None for g in attachment for m in g["matches"])


def test_unknown_functional_group_set(client: TestClient, contract: Contract) -> None:
    response = client.post("/v1/chem/functional-groups", json={"structure": smiles("CCO"), "sets": ["nope"]})
    body = contract.check("POST", "/v1/chem/functional-groups", response)
    assert response.status_code == 422 and body["error"]["code"] == "unknown_functional_group_set"
    assert "rdkit-fragment-descriptors" in body["error"]["details"]["available"]
