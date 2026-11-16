"""Evidence for one documented difference between RDKit's UFF and @matterlab/forcefield.

RDKit finds the bonds that carry torsion terms with a substructure search
(``[!$(*#*)&!D1]~[!$(*#*)&!D1]``), and ``SubstructMatch`` returns at most 1000 matches by default
(``maxMatches = 1000``). A molecule with more than 1000 such bonds therefore silently loses the
torsion terms of the bonds beyond the first 1000. The TypeScript port enumerates the bonds directly
and keeps every torsion.

This script shows the effect on unbranched alkanes. Every CH2 unit is given the same (periodic)
distortion, so the UFF energy must grow by the same amount for every carbon that is added. With
RDKit it does up to 1000 C-C bonds, and by a smaller amount beyond: the difference is the torsional
energy of one C-C bond.

Run with the project's virtual environment from the repository root:

    .venv\\Scripts\\python.exe packages\\forcefield\\tools\\check_rdkit_torsion_limit.py

Besides printing the table, the script writes ``test/fixtures/rdkit_torsion_limit.json`` (RDKit's
energies and everything needed to rebuild the same geometries), which ``test/api.test.ts`` uses to
show that the port agrees with RDKit up to 1000 torsion bonds and exceeds it beyond by exactly the
torsional energy of the bonds RDKit dropped.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import rdkit
from rdkit import Chem
from rdkit.Chem import rdForceFieldHelpers as rdFF

CC_BOND = 1.53
CCC_ANGLE_DEG = 111.0
DISPLACEMENT = 0.15
SEED = 7
SIZES = (400, 600, 800, 1000, 1001, 1002, 1003, 1100, 1200, 1400)
FIXTURE = Path(__file__).resolve().parent.parent / "test" / "fixtures" / "rdkit_torsion_limit.json"


def displacement_pattern(seed: int = SEED) -> np.ndarray:
    """One displacement for even carbons, one for odd carbons, and one for each of their two hydrogens."""
    return np.random.RandomState(seed).uniform(-DISPLACEMENT, DISPLACEMENT, size=(6, 3))


def distorted_alkane(n_carbons: int, seed: int = SEED) -> Chem.Mol:
    """An all-trans alkane in which every CH2 unit carries the same displacement pattern."""
    mol = Chem.AddHs(Chem.MolFromSmiles("C" * n_carbons))
    n = mol.GetNumAtoms()
    coords = np.zeros((n, 3))
    half = math.radians(CCC_ANGLE_DEG / 2.0)
    for i in range(n_carbons):
        coords[i] = (i * CC_BOND * math.sin(half), (i % 2) * CC_BOND * math.cos(half), 0.0)
    placed: dict[int, int] = {}
    for atom in mol.GetAtoms():
        if atom.GetAtomicNum() != 1:
            continue
        parent = atom.GetNeighbors()[0].GetIdx()
        k = placed.get(parent, 0)
        placed[parent] = k + 1
        up = 1.0 if parent % 2 == 1 else -1.0
        if k < 2:
            offset = (0.0, up * 0.63, (1.0 if k == 0 else -1.0) * 0.89)
        else:
            offset = ((-1.0 if parent == 0 else 1.0) * 1.03, -up * 0.36, 0.0)
        coords[atom.GetIdx()] = coords[parent] + np.asarray(offset)
    pattern = displacement_pattern(seed)
    for atom in mol.GetAtoms():
        idx = atom.GetIdx()
        if atom.GetAtomicNum() == 6:
            coords[idx] += pattern[(idx % 2) * 3]
        else:
            parent = atom.GetNeighbors()[0].GetIdx()
            hydrogens = sorted(x.GetIdx() for x in mol.GetAtomWithIdx(parent).GetNeighbors() if x.GetAtomicNum() == 1)
            coords[idx] += pattern[(parent % 2) * 3 + 1 + min(hydrogens.index(idx), 1)]
    mol.AddConformer(Chem.Conformer(n), assignId=True)
    conformer = mol.GetConformer()
    for i in range(n):
        conformer.SetAtomPosition(i, coords[i].tolist())
    return mol


def check_atom_order(mol: Chem.Mol, n_carbons: int) -> None:
    """The fixture relies on this numbering: carbons first, then the hydrogens carbon by carbon."""
    expected_parent = []
    for c in range(n_carbons):
        expected_parent += [c] * (3 if c in (0, n_carbons - 1) else 2)
    for offset, parent in enumerate(expected_parent):
        atom = mol.GetAtomWithIdx(n_carbons + offset)
        if atom.GetAtomicNum() != 1 or atom.GetNeighbors()[0].GetIdx() != parent:
            raise RuntimeError("unexpected atom numbering after AddHs")
    for c in range(n_carbons - 1):
        if mol.GetBondBetweenAtoms(c, c + 1) is None:
            raise RuntimeError("unexpected carbon numbering")


def main() -> None:
    print(f"RDKit {rdkit.__version__}: UFF energy of distorted n-alkanes (kcal/mol)")
    previous: tuple[int, float] | None = None
    records = []
    for n_carbons in SIZES:
        mol = distorted_alkane(n_carbons)
        check_atom_order(mol, n_carbons)
        energy = rdFF.UFFGetMoleculeForceField(mol).CalcEnergy()
        line = f"  C{n_carbons:<5d} {mol.GetNumAtoms():5d} atoms  {n_carbons - 1:5d} torsion bonds  E = {energy:14.6f}"
        if previous is not None:
            line += f"   increment per carbon = {(energy - previous[1]) / (n_carbons - previous[0]):.6f}"
        print(line)
        previous = (n_carbons, energy)
        positions = mol.GetConformer().GetPositions()
        records.append(
            {
                "nCarbons": n_carbons,
                "nAtoms": mol.GetNumAtoms(),
                "torsionBonds": n_carbons - 1,
                "energy": energy,
                # enough to detect a geometry that was rebuilt differently
                "firstAtoms": positions[:2].tolist(),
                "lastAtom": positions[-1].tolist(),
            }
        )
    print("The increment per carbon is constant up to 1000 torsion bonds and smaller beyond:")
    print("RDKit has dropped the torsion terms of the bonds after the first 1000.")

    fixture = {
        "meta": {
            "generator": "packages/forcefield/tools/check_rdkit_torsion_limit.py",
            "rdkitVersion": rdkit.__version__,
            "units": {"energy": "kcal/mol", "coordinates": "angstrom"},
            "note": "UFF energies (UFFGetMoleculeForceField(mol).CalcEnergy()) of unbranched alkanes in a periodic, distorted "
            "all-trans geometry. Atom order: carbons 0..n-1 along the chain, then the hydrogens carbon by carbon "
            "(three on each terminal carbon, two on the others), as Chem.AddHs numbers them.",
        },
        "construction": {
            "ccBond": CC_BOND,
            "cccAngleDeg": CCC_ANGLE_DEG,
            "hydrogenOffsets": {"inPlane": 0.63, "outOfPlane": 0.89, "terminalAlongChain": 1.03, "terminalInPlane": 0.36},
            "displacementPattern": displacement_pattern().tolist(),
        },
        "alkanes": records,
    }
    FIXTURE.write_text(json.dumps(fixture, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {FIXTURE}")


if __name__ == "__main__":
    main()
