"""Small facts about the installed RDKit that the tests of @matterlab/forcefield pin down.

Run with the project's virtual environment from the repository root (a few seconds):

    .venv\\Scripts\\python.exe packages\\forcefield\\tools\\gen_rdkit_checks.py

Output: packages/forcefield/test/fixtures/rdkit_checks.json, with three sections.

periodicTable
    Element symbols, outer-shell electron counts and valence lists as the installed RDKit reports
    them. The TypeScript port takes these from a table generated out of RDKit's source file
    ``Code/GraphMol/atomic_data.cpp``; ``test/generated.test.ts`` compares the two.

kekuleBenzene
    Benzene with alternating double and single bonds and RDKit's aromaticity perception switched
    off: what RDKit's UFF does with a Kekule structure taken as written. The package does no
    aromaticity perception of its own, so this is how it treats such input; ``test/typing.test.ts``
    checks that it agrees with RDKit here too.

untypeable
    What RDKit does when asked to optimise a molecule its UFF atom typer cannot type: it logs
    "Unrecognized atom type", ``UFFHasAllMoleculeParams`` is False, and ``UFFOptimizeMolecule``
    still returns 0 after minimising a force field that lacks every term of the untyped atom.
    The package refuses such molecules instead (``UnsupportedForceFieldError``).
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import rdkit
from rdkit import Chem, rdBase
from rdkit.Chem import AllChem
from rdkit.Chem import rdForceFieldHelpers as rdFF

FIXTURE = Path(__file__).resolve().parent.parent / "test" / "fixtures" / "rdkit_checks.json"
MAX_ATOMIC_NUMBER = 118
EMBED_SEED = 1992


def periodic_table() -> list[dict]:
    table = Chem.GetPeriodicTable()
    return [
        {
            "z": z,
            "symbol": table.GetElementSymbol(z),
            "outerElectrons": int(table.GetNOuterElecs(z)),
            "valenceList": [int(v) for v in table.GetValenceList(z)],
            "defaultValence": int(table.GetDefaultValence(z)),
        }
        for z in range(MAX_ATOMIC_NUMBER + 1)
    ]


def energy_and_gradient(ff, coords) -> tuple[float, list[float]]:
    # CalcEnergy(pos) first: CalcGrad(pos) on its own reuses the distances of the last energy call.
    pos = [float(v) for v in coords]
    energy = float(ff.CalcEnergy(pos))
    return energy, [float(v) for v in ff.CalcGrad(pos)]


def kekule_benzene() -> dict:
    mol = Chem.MolFromSmiles("C1=CC=CC=C1", sanitize=False)
    # everything RDKit's sanitisation does except perceiving aromaticity (and re-kekulising)
    Chem.SanitizeMol(mol, Chem.SANITIZE_ALL ^ Chem.SANITIZE_SETAROMATICITY ^ Chem.SANITIZE_KEKULIZE)
    mol = Chem.AddHs(mol)
    params = AllChem.ETKDGv3()
    params.randomSeed = EMBED_SEED
    if AllChem.EmbedMolecule(mol, params) != 0:
        raise RuntimeError("embedding failed")
    if any(a.GetIsAromatic() for a in mol.GetAtoms()) or any(b.GetIsAromatic() for b in mol.GetBonds()):
        raise RuntimeError("aromaticity was perceived after all")
    coords = mol.GetConformer().GetPositions().flatten().tolist()
    ff = rdFF.UFFGetMoleculeForceField(mol)
    energy, gradient = energy_and_gradient(ff, coords)

    work = Chem.Mol(mol)
    status = rdFF.UFFOptimizeMolecule(work, maxIters=2000)
    if status != 0:
        raise RuntimeError("UFFOptimizeMolecule did not converge")
    optimized_coords = work.GetConformer().GetPositions().flatten().tolist()
    optimized_energy = float(rdFF.UFFGetMoleculeForceField(work).CalcEnergy())
    positions = np.asarray(optimized_coords).reshape(-1, 3)
    cc = [
        float(np.linalg.norm(positions[b.GetBeginAtomIdx()] - positions[b.GetEndAtomIdx()]))
        for b in work.GetBonds()
        if b.GetBeginAtom().GetAtomicNum() == 6 and b.GetEndAtom().GetAtomicNum() == 6
    ]
    return {
        "smiles": "C1=CC=CC=C1",
        "sanitization": "SANITIZE_ALL without SANITIZE_SETAROMATICITY and SANITIZE_KEKULIZE",
        "z": [a.GetAtomicNum() for a in mol.GetAtoms()],
        "formalCharge": [a.GetFormalCharge() for a in mol.GetAtoms()],
        "bonds": [[b.GetBeginAtomIdx(), b.GetEndAtomIdx(), b.GetBondTypeAsDouble()] for b in mol.GetBonds()],
        "hybridization": [str(a.GetHybridization()) for a in mol.GetAtoms()],
        "conjugatedBonds": [int(b.GetIsConjugated()) for b in mol.GetBonds()],
        "coords": coords,
        "energy": energy,
        "gradient": gradient,
        "optimized": {"energy": optimized_energy, "coords": optimized_coords, "ccBondLengths": cc},
    }


def untypeable() -> list[dict]:
    records = []
    for name, smiles in (("sulfur hexafluoride", "FS(F)(F)(F)(F)F"), ("selenophene", "c1cc[se]c1"), ("zinc chloride", "Cl[Zn]Cl")):
        mol = Chem.AddHs(Chem.MolFromSmiles(smiles))
        params = AllChem.ETKDGv3()
        params.randomSeed = EMBED_SEED
        if AllChem.EmbedMolecule(mol, params) != 0:
            raise RuntimeError(f"{name}: embedding failed")
        with rdBase.BlockLogs():
            has_all = bool(rdFF.UFFHasAllMoleculeParams(mol))
            status = int(rdFF.UFFOptimizeMolecule(mol, maxIters=2000))
            energy = float(rdFF.UFFGetMoleculeForceField(mol).CalcEnergy())
        records.append(
            {
                "name": name,
                "smiles": smiles,
                "hasAllMoleculeParams": has_all,
                "optimizeMoleculeReturned": status,
                "energyOfTheForceFieldRdkitBuilt": energy,
            }
        )
    return records


def main() -> None:
    payload = {
        "meta": {
            "generator": "packages/forcefield/tools/gen_rdkit_checks.py",
            "rdkitVersion": rdkit.__version__,
            "units": {"energy": "kcal/mol", "gradient": "kcal/mol/angstrom", "coordinates": "angstrom"},
        },
        "periodicTable": periodic_table(),
        "kekuleBenzene": kekule_benzene(),
        "untypeable": untypeable(),
    }
    FIXTURE.write_text(json.dumps(payload, separators=(",", ":"), allow_nan=False) + "\n", encoding="utf-8")
    kb = payload["kekuleBenzene"]
    print(f"RDKit {rdkit.__version__}")
    print(f"  periodic table: {len(payload['periodicTable'])} elements")
    print(f"  Kekule benzene: E = {kb['energy']:.6f}, optimised {kb['optimized']['energy']:.6f}, C-C " + " ".join(f"{d:.4f}" for d in kb["optimized"]["ccBondLengths"]))
    for rec in payload["untypeable"]:
        print(
            f"  {rec['name']}: UFFHasAllMoleculeParams = {rec['hasAllMoleculeParams']}, UFFOptimizeMolecule returned "
            f"{rec['optimizeMoleculeReturned']}, energy of the partial force field {rec['energyOfTheForceFieldRdkitBuilt']:.6f}"
        )
    print(f"wrote {FIXTURE}")


if __name__ == "__main__":
    main()
