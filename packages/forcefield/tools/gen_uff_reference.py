"""Generate the RDKit reference data that @matterlab/forcefield is validated against.

Run with the project's virtual environment from the repository root:

    .venv\\Scripts\\python.exe packages\\forcefield\\tools\\gen_uff_reference.py

Output: packages/forcefield/test/fixtures/uff_reference.json

For every molecule (built from SMILES, hydrogens added, embedded with ETKDGv3 and a fixed random
seed) the fixture records what RDKit's Universal Force Field does with it:

  * the molecule exactly as the TypeScript package receives it: atomic numbers, formal charges,
    coordinates and bonds with ``GetBondTypeAsDouble()`` (1.5 = aromatic);
  * RDKit's perception that UFF typing depends on (hybridisation, conjugation, valence, radicals,
    three- and four-membered ring membership, fragments);
  * the UFF energy and gradient at the embedded geometry and at a randomly perturbed geometry;
  * per-term parameters from ``rdForceFieldHelpers.GetUFF*Params``;
  * the geometry and energy after ``UFFOptimizeMolecule`` has converged, and the nearby minimum of
    RDKit's own energy function located to tight tolerance ("polished");
  * anything RDKit's atom typer wrote to its log.

Molecules RDKit's UFF cannot type are recorded separately with the labels RDKit rejected.
Nothing in the fixture is typed by hand: every number comes out of RDKit.
"""

from __future__ import annotations

import argparse
import datetime
import json
import logging
import math
import pathlib
import platform
import re
import sys

import numpy as np
import rdkit
from rdkit import Chem, rdBase
from rdkit.Chem import AllChem, rdMolDescriptors
from rdkit.Chem import rdForceFieldHelpers as rdFF

HERE = pathlib.Path(__file__).resolve().parent
DEFAULT_OUT = HERE.parent / "test" / "fixtures" / "uff_reference.json"

EMBED_SEED = 1992  # the year the UFF paper appeared; any fixed value would do
PERTURBATION = 0.2  # angstrom, uniform in [-PERTURBATION, PERTURBATION] per coordinate
VDW_THRESH = 10.0  # RDKit's default for UFFOptimizeMolecule / UFFGetMoleculeForceField
MAX_VDW_PAIRS = 400  # per molecule; larger pair lists are sampled evenly

# (name, SMILES, classes[, source]). Drug-like SMILES were retrieved from PubChem PUG REST
# (property SMILES) on 2026-11-13; the CID is given as the source.
MOLECULES: list[tuple] = [
    # --- alkanes
    ("methane", "C", ["alkane"]),
    ("ethane", "CC", ["alkane"]),
    ("propane", "CCC", ["alkane"]),
    ("butane", "CCCC", ["alkane"]),
    ("isobutane", "CC(C)C", ["alkane"]),
    ("neopentane", "CC(C)(C)C", ["alkane"]),
    ("cyclopentane", "C1CCCC1", ["alkane", "ring"]),
    ("cyclohexane", "C1CCCCC1", ["alkane", "ring"]),
    # --- alkenes, alkynes, cumulenes
    ("ethene", "C=C", ["alkene"]),
    ("propene", "CC=C", ["alkene"]),
    ("trans-2-butene", "C/C=C/C", ["alkene"]),
    ("isobutene", "CC(C)=C", ["alkene"]),
    ("1,3-butadiene", "C=CC=C", ["alkene", "conjugated"]),
    ("cyclohexene", "C1CCC=CC1", ["alkene", "ring"]),
    ("ethyne", "C#C", ["alkyne"]),
    ("propyne", "CC#C", ["alkyne"]),
    ("2-butyne", "CC#CC", ["alkyne"]),
    ("allene", "C=C=C", ["allene"]),
    ("ketene", "C=C=O", ["allene"]),
    # --- aromatics and heteroaromatics
    ("benzene", "c1ccccc1", ["aromatic"]),
    ("toluene", "Cc1ccccc1", ["aromatic"]),
    ("styrene", "C=Cc1ccccc1", ["aromatic", "conjugated"]),
    ("biphenyl", "c1ccc(cc1)-c1ccccc1", ["aromatic"]),
    ("naphthalene", "c1ccc2ccccc2c1", ["aromatic"]),
    ("pyridine", "c1ccncc1", ["aromatic", "heteroaromatic"]),
    ("pyrrole", "c1cc[nH]c1", ["aromatic", "heteroaromatic"]),
    ("furan", "c1ccoc1", ["aromatic", "heteroaromatic"]),
    ("thiophene", "c1ccsc1", ["aromatic", "heteroaromatic"]),
    ("imidazole", "c1c[nH]cn1", ["aromatic", "heteroaromatic"]),
    ("indole", "c1ccc2[nH]ccc2c1", ["aromatic", "heteroaromatic"]),
    # --- alcohols, ethers
    ("methanol", "CO", ["alcohol"]),
    ("ethanol", "CCO", ["alcohol"]),
    ("isopropanol", "CC(C)O", ["alcohol"]),
    ("phenol", "Oc1ccccc1", ["alcohol", "aromatic"]),
    ("dimethyl ether", "COC", ["ether"]),
    ("diethyl ether", "CCOCC", ["ether"]),
    ("tetrahydrofuran", "C1CCOC1", ["ether", "ring"]),
    ("anisole", "COc1ccccc1", ["ether", "aromatic"]),
    ("methyl vinyl ether", "COC=C", ["ether", "conjugated"]),
    # --- amines
    ("methylamine", "CN", ["amine"]),
    ("dimethylamine", "CNC", ["amine"]),
    ("trimethylamine", "CN(C)C", ["amine"]),
    ("aniline", "Nc1ccccc1", ["amine", "aromatic"]),
    ("hydrazine", "NN", ["amine", "inorganic"]),
    ("hydroxylamine", "NO", ["amine", "inorganic"]),
    ("N-methylethanimine", "CC=NC", ["imine"]),
    # --- carbonyl compounds
    ("formaldehyde", "C=O", ["aldehyde"]),
    ("acetaldehyde", "CC=O", ["aldehyde"]),
    ("benzaldehyde", "O=Cc1ccccc1", ["aldehyde", "aromatic"]),
    ("acetone", "CC(C)=O", ["ketone"]),
    ("cyclohexanone", "O=C1CCCCC1", ["ketone", "ring"]),
    ("formic acid", "OC=O", ["carboxylic acid"]),
    ("acetic acid", "CC(O)=O", ["carboxylic acid"]),
    ("methyl acetate", "COC(C)=O", ["ester"]),
    ("formamide", "NC=O", ["amide"]),
    ("acetamide", "CC(N)=O", ["amide"]),
    ("N-methylacetamide", "CC(=O)NC", ["amide"]),
    ("urea", "NC(N)=O", ["amide"]),
    # --- nitriles, nitro and other N/O functional groups
    ("acetonitrile", "CC#N", ["nitrile"]),
    ("nitromethane", "C[N+](=O)[O-]", ["nitro", "charged"]),
    ("nitrobenzene", "[O-][N+](=O)c1ccccc1", ["nitro", "charged", "aromatic"]),
    ("nitric acid", "O[N+](=O)[O-]", ["nitro", "charged", "inorganic"]),
    ("trimethylamine N-oxide", "C[N+](C)(C)[O-]", ["charged"]),
    ("diazomethane", "C=[N+]=[N-]", ["charged"]),
    ("methyl azide", "CN=[N+]=[N-]", ["charged"]),
    ("methyl isocyanide", "C[N+]#[C-]", ["charged"]),
    # --- halides
    ("fluoromethane", "CF", ["halide"]),
    ("chloromethane", "CCl", ["halide"]),
    ("bromomethane", "CBr", ["halide"]),
    ("iodomethane", "CI", ["halide"]),
    ("chloroform", "ClC(Cl)Cl", ["halide"]),
    ("tetrafluoromethane", "FC(F)(F)F", ["halide"]),
    ("chlorobenzene", "Clc1ccccc1", ["halide", "aromatic"]),
    ("1-bromo-2-chloro-1-fluoro-2-iodoethane", "FC(Br)C(Cl)I", ["halide"]),
    # --- sulfur
    ("methanethiol", "CS", ["thiol"]),
    ("thiophenol", "Sc1ccccc1", ["thiol", "aromatic"]),
    ("dimethyl sulfide", "CSC", ["sulfide"]),
    ("thioanisole", "CSc1ccccc1", ["sulfide", "aromatic"]),
    ("dimethyl disulfide", "CSSC", ["sulfide"]),
    ("dimethyl sulfoxide", "CS(C)=O", ["sulfoxide"]),
    ("dimethyl sulfone", "CS(C)(=O)=O", ["sulfone"]),
    ("methanesulfonic acid", "CS(O)(=O)=O", ["sulfone"]),
    ("thioacetone", "CC(C)=S", ["thiocarbonyl"]),
    ("thiourea", "NC(N)=S", ["thiocarbonyl"]),
    # --- phosphorus, silicon, boron and other main-group elements
    ("trimethylphosphine", "CP(C)C", ["phosphine"]),
    ("trimethyl phosphate", "COP(=O)(OC)OC", ["phosphate"]),
    ("phosphoric acid", "OP(O)(O)=O", ["phosphate", "inorganic"]),
    ("trimethylphosphine oxide", "CP(C)(C)=O", ["phosphine"]),
    ("tetramethylsilane", "C[Si](C)(C)C", ["silane"]),
    ("disilane", "[SiH3][SiH3]", ["silane"]),
    ("borane", "B", ["boron"]),
    ("trimethylborane", "CB(C)C", ["boron"]),
    ("boric acid", "OB(O)O", ["boron"]),
    ("boron trifluoride", "FB(F)F", ["boron"]),
    ("tetrahydroborate", "[BH4-]", ["boron", "ion"]),
    ("ammonia borane", "[NH3+][BH3-]", ["boron", "charged"]),
    ("dimethyl selenide", "C[Se]C", ["main group"]),
    ("dimethyl telluride", "C[Te]C", ["main group"]),
    ("trimethylarsine", "C[As](C)C", ["main group"]),
    ("stibine", "[SbH3]", ["main group"]),
    ("germane", "[GeH4]", ["main group"]),
    ("tetramethyltin", "C[Sn](C)(C)C", ["main group"]),
    ("trimethylaluminium", "C[Al](C)C", ["main group"]),
    ("aluminium chloride", "Cl[Al](Cl)Cl", ["main group"]),
    ("phosphorus pentafluoride", "FP(F)(F)(F)F", ["hypervalent"]),
    ("hexafluorophosphate", "F[P-](F)(F)(F)(F)F", ["hypervalent", "ion"]),
    ("hexafluorosilicate", "F[Si-2](F)(F)(F)(F)F", ["hypervalent", "ion"]),
    ("iodine trifluoride", "FI(F)F", ["hypervalent"]),
    ("iodine pentafluoride", "FI(F)(F)(F)F", ["hypervalent"]),
    # --- metals RDKit's UFF can type
    ("methyllithium", "[Li]C", ["metal"]),
    ("dimethylmercury", "C[Hg]C", ["metal"]),
    ("titanium tetrachloride", "Cl[Ti](Cl)(Cl)Cl", ["metal"]),
    # --- small inorganics
    ("water", "O", ["inorganic"]),
    ("ammonia", "N", ["inorganic"]),
    ("hydrogen peroxide", "OO", ["inorganic"]),
    ("carbon dioxide", "O=C=O", ["inorganic"]),
    ("sulfur dioxide", "O=S=O", ["inorganic"]),
    ("sulfur trioxide", "O=S(=O)=O", ["inorganic"]),
    ("sulfuric acid", "OS(O)(=O)=O", ["inorganic"]),
    ("hydrogen cyanide", "C#N", ["inorganic", "nitrile"]),
    ("hydrogen sulfide", "S", ["inorganic"]),
    ("phosphine", "P", ["inorganic", "phosphine"]),
    ("silane", "[SiH4]", ["inorganic", "silane"]),
    ("hydrogen chloride", "Cl", ["inorganic", "halide"]),
    ("hydrogen fluoride", "F", ["inorganic", "halide"]),
    ("dihydrogen", "[H][H]", ["inorganic"]),
    ("dinitrogen", "N#N", ["inorganic"]),
    ("dioxygen", "O=O", ["inorganic"]),
    ("carbon monoxide", "[C-]#[O+]", ["inorganic", "charged"]),
    ("ozone", "[O-][O+]=O", ["inorganic", "charged"]),
    # --- ions
    ("ammonium", "[NH4+]", ["ion"]),
    ("methylammonium", "C[NH3+]", ["ion"]),
    ("tetramethylammonium", "C[N+](C)(C)C", ["ion"]),
    ("pyridinium", "c1cc[nH+]cc1", ["ion", "aromatic"]),
    ("guanidinium", "NC(N)=[NH2+]", ["ion"]),
    ("acetate", "CC([O-])=O", ["ion"]),
    ("hydroxide", "[OH-]", ["ion"]),
    ("hydronium", "[OH3+]", ["ion"]),
    ("glycine zwitterion", "[NH3+]CC([O-])=O", ["ion", "zwitterion"]),
    ("methoxide", "C[O-]", ["ion"]),
    ("trimethyl(vinyl)oxonium", "C=C[O+](C)C", ["ion"]),
    ("sodium chloride ion pair", "[Na+].[Cl-]", ["ion", "multi-fragment"]),
    ("ammonium chloride ion pair", "[NH4+].[Cl-]", ["ion", "multi-fragment"]),
    # --- several fragments (no interactions between fragments by default)
    ("water dimer", "O.O", ["multi-fragment"]),
    ("methane and ethane", "C.CC", ["multi-fragment"]),
    # --- open-shell species written with explicit radical centres
    ("methyl radical", "[CH3]", ["radical"]),
    ("hydroxyl radical", "[OH]", ["radical"]),
    ("methylene", "[CH2]", ["radical"]),
    ("nitric oxide", "[N]=O", ["radical", "inorganic"]),
    ("amino radical", "[NH2]", ["radical"]),
    ("ethyl radical", "C[CH2]", ["radical"]),
    ("phenyl radical", "[c]1ccccc1", ["radical", "aromatic"]),
    # --- strained rings, including sp2 atoms in three- and four-membered rings
    ("cyclopropane", "C1CC1", ["strained ring"]),
    ("cyclobutane", "C1CCC1", ["strained ring"]),
    ("cubane", "C12C3C4C1C5C2C3C45", ["strained ring"]),
    ("cyclopropene", "C1=CC1", ["strained ring", "alkene"]),
    ("cyclobutene", "C1=CCC1", ["strained ring", "alkene"]),
    ("methylenecyclopropane", "C=C1CC1", ["strained ring", "alkene"]),
    ("methylenecyclobutane", "C=C1CCC1", ["strained ring", "alkene"]),
    ("cyclopropanone", "O=C1CC1", ["strained ring", "ketone"]),
    ("cyclobutanone", "O=C1CCC1", ["strained ring", "ketone"]),
    ("azetidin-2-one", "O=C1CCN1", ["strained ring", "amide"]),
    ("bicyclo[1.1.0]butane", "C1C2C1C2", ["strained ring"]),
    ("spiropentane", "C1CC12CC2", ["strained ring"]),
    ("tetrahedrane", "C12C3C1C23", ["strained ring"]),
    ("prismane", "C12C3C1C1C2C31", ["strained ring"]),
    ("[1.1.1]propellane", "C1C23CC12C3", ["strained ring"]),
    ("bicyclo[2.2.0]hexane", "C1CC2CCC12", ["strained ring"]),
    ("benzocyclobutene", "c1ccc2CCc2c1", ["strained ring", "aromatic"]),
    ("cyclobutadiene", "C1=CC=C1", ["strained ring", "alkene"]),
    ("oxirane", "C1CO1", ["strained ring", "ether"]),
    ("2H-azirine", "C1C=N1", ["strained ring", "imine"]),
    # --- drug-like molecules
    ("aspirin", "CC(=O)OC1=CC=CC=C1C(=O)O", ["drug-like"], "PubChem CID 2244"),
    ("caffeine", "CN1C=NC2=C1C(=O)N(C(=O)N2C)C", ["drug-like"], "PubChem CID 2519"),
    ("ibuprofen", "CC(C)CC1=CC=C(C=C1)C(C)C(=O)O", ["drug-like"], "PubChem CID 3672"),
    ("paracetamol", "CC(=O)NC1=CC=C(C=C1)O", ["drug-like"], "PubChem CID 1983"),
    ("nicotine", "CN1CCC[C@H]1C2=CN=CC=C2", ["drug-like"], "PubChem CID 89594"),
    ("penicillin G", "CC1([C@@H](N2[C@H](S1)[C@@H](C2=O)NC(=O)CC3=CC=CC=C3)C(=O)O)C", ["drug-like", "strained ring"], "PubChem CID 5904"),
    ("testosterone", "C[C@]12CC[C@H]3[C@H]([C@@H]1CC[C@@H]2O)CCC4=CC(=O)CC[C@]34C", ["drug-like", "benchmark-50"], "PubChem CID 6013"),
    ("cholesterol", "C[C@H](CCCC(C)C)[C@H]1CC[C@@H]2[C@@]1(CC[C@H]3[C@H]2CC=C4[C@@]3(CC[C@@H](C4)O)C)C", ["drug-like"], "PubChem CID 5997"),
    ("atorvastatin", "CC(C)C1=C(C(=C(N1CC[C@H](C[C@H](CC(=O)O)O)O)C2=CC=C(C=C2)F)C3=CC=CC=C3)C(=O)NC4=CC=CC=C4", ["drug-like"], "PubChem CID 60823"),
    (
        "paclitaxel",
        "CC1=C2[C@H](C(=O)[C@@]3([C@H](C[C@@H]4[C@]([C@H]3[C@@H]([C@@](C2(C)C)(C[C@@H]1OC(=O)[C@@H]([C@H](C5=CC=CC=C5)NC(=O)C6=CC=CC=C6)O)O)OC(=O)C7=CC=CC=C7)(CO4)OC(=O)C)O)C)OC(=O)C",
        ["drug-like", "benchmark-100"],
        "PubChem CID 36314",
    ),
    # --- a system above 400 atoms: exercises the limited-memory branch of the TypeScript minimiser.
    #     ETKDG does not embed it in reasonable time, so its coordinates are built directly
    #     (see CUSTOM_COORDINATES).
    ("C140 alkane", "C" * 140, ["alkane", "large"]),
    # --- candidates RDKit's UFF is not expected to type (RDKit decides; see "unsupported" in the output)
    ("helium", "[He]", ["noble gas"]),
    ("neon", "[Ne]", ["noble gas"]),
    ("argon", "[Ar]", ["noble gas"]),
    ("xenon tetrafluoride", "F[Xe](F)(F)F", ["hypervalent", "noble gas"]),
    ("sulfur hexafluoride", "FS(F)(F)(F)(F)F", ["hypervalent"]),
    ("sulfur tetrafluoride", "FS(F)(F)F", ["hypervalent"]),
    ("selenophene", "c1cc[se]c1", ["heteroaromatic"]),
    ("2-methylselenophene", "Cc1ccc[se]1", ["heteroaromatic"]),
    ("zinc chloride", "Cl[Zn]Cl", ["metal"]),
    ("dimethylzinc", "C[Zn]C", ["metal"]),
    ("tetramethyllead", "C[Pb](C)(C)C", ["metal"]),
    ("tungsten hexafluoride", "F[W](F)(F)(F)(F)F", ["metal"]),
    ("zirconium tetrachloride", "Cl[Zr](Cl)(Cl)Cl", ["metal"]),
]

# Molecular formulas the SMILES above must produce, where a slip would be easy to make.
EXPECTED_FORMULAS = {
    "aspirin": "C9H8O4",
    "caffeine": "C8H10N4O2",
    "ibuprofen": "C13H18O2",
    "paracetamol": "C8H9NO2",
    "nicotine": "C10H14N2",
    "penicillin G": "C16H18N2O4S",
    "testosterone": "C19H28O2",
    "cholesterol": "C27H46O",
    "atorvastatin": "C33H35FN2O5",
    "paclitaxel": "C47H51NO14",
    "cubane": "C8H8",
    "tetrahedrane": "C4H4",
    "prismane": "C6H6",
    "[1.1.1]propellane": "C5H6",
    "bicyclo[1.1.0]butane": "C4H6",
    "spiropentane": "C5H8",
    "bicyclo[2.2.0]hexane": "C6H10",
    "benzocyclobutene": "C8H8",
    "naphthalene": "C10H8",
    "indole": "C8H7N",
    "imidazole": "C3H4N2",
    "C140 alkane": "C140H282",
}


RDKIT_SRC = HERE / "rdkit-src"


def rdkit_typer_test_expectations() -> dict[str, dict[int, str]]:
    """Atom labels that RDKit's own unit tests assert, read from the vendored test source.

    Code/GraphMol/ForceFieldHelpers/UFF/testUFFHelpers.cpp builds molecules with SmilesToMol and
    then checks ``UFF::Tools::getAtomLabel(mol->getAtomWithIdx(i))`` against a literal label.
    Returns {SMILES: {atom index: label}}.
    """
    path = RDKIT_SRC / "Code" / "GraphMol" / "ForceFieldHelpers" / "UFF" / "testUFFHelpers.cpp"
    expectations: dict[str, dict[int, str]] = {}
    smiles = None
    index = None
    for line in path.read_text(encoding="utf-8").splitlines():
        m = re.search(r'=\s*SmilesToMol\("([^"]+)"\)', line)
        if m:
            smiles, index = m.group(1), None
            continue
        m = re.search(r"getAtomLabel\(mol->getAtomWithIdx\((\d+)\)\)", line)
        if m:
            index = int(m.group(1))
            continue
        m = re.search(r'TEST_ASSERT\(key == "([^"]+)"\)', line)
        if m and smiles is not None and index is not None:
            expectations.setdefault(smiles, {})[index] = m.group(1)
            index = None
    if len(expectations) < 8:
        raise RuntimeError("could not read the label expectations from RDKit's testUFFHelpers.cpp")
    return expectations


def read_uff_table() -> tuple[dict[str, dict[str, float]], float]:
    """RDKit's UFF parameter table (label -> r1, theta0 in degrees, GMP electronegativity) and Params::lambda."""
    text = (RDKIT_SRC / "Code" / "ForceField" / "UFF" / "Params.cpp").read_text(encoding="utf-8")
    start = text.index("const std::string defaultParamData =")
    end = text.index(";", start)
    data = "".join(re.findall(r'"((?:[^"\\]|\\.)*)"', text[start:end])).replace("\\n", "\n")
    table: dict[str, dict[str, float]] = {}
    for line in data.split("\n"):
        if not line or line.startswith("#"):
            continue
        cols = line.split("\t")
        if len(cols) != 12:
            raise RuntimeError(f"unexpected parameter line {line!r}")
        table[cols[0]] = {"r1": float(cols[1]), "theta0": float(cols[2]), "xi": float(cols[9])}
    header = (RDKIT_SRC / "Code" / "ForceField" / "UFF" / "Params.h").read_text(encoding="utf-8")
    lam = float(re.search(r"const\s+double\s+lambda\s*=\s*([0-9.eE+-]+)\s*;", header).group(1))
    return table, lam


UFF_TABLE, UFF_LAMBDA = read_uff_table()


def infer_uff_labels(mol: Chem.Mol) -> list[list[str]]:
    """The UFF atom types RDKit must have assigned, deduced from the parameters it reports.

    RDKit's Python API does not expose atom-type labels. They can be recovered, though: the rest
    length of a bond depends on the valence radii r1 and electronegativities of the two atom types
    (UFF paper, eq. 2-4), and the natural angle at a vertex is its type's theta0. For each atom the
    candidates are the table's types of that element; they are narrowed down until every reported
    bond length and angle is reproduced to 1e-9. The result is, per atom, the list of labels that
    survive: normally exactly one (types with identical parameters cannot be told apart).
    """

    def rest_length(order: float, a: dict[str, float], b: dict[str, float]) -> float:
        ri, rj = a["r1"], b["r1"]
        r_bo = -UFF_LAMBDA * (ri + rj) * math.log(order)
        r_en = ri * rj * (math.sqrt(a["xi"]) - math.sqrt(b["xi"])) ** 2 / (a["xi"] * ri + b["xi"] * rj)
        return ri + rj + r_bo - r_en

    candidates: list[set[str]] = []
    for atom in mol.GetAtoms():
        symbol = atom.GetSymbol()
        key = symbol if len(symbol) > 1 else symbol + "_"
        candidates.append({label for label in UFF_TABLE if label.startswith(key)})
    nbrs = [[x.GetIdx() for x in a.GetNeighbors()] for a in mol.GetAtoms()]
    for j, around in enumerate(nbrs):
        if len(around) >= 2:
            theta0 = rdFF.GetUFFAngleBendParams(mol, around[0], j, around[1])[1]
            candidates[j] = {label for label in candidates[j] if abs(UFF_TABLE[label]["theta0"] - theta0) < 1e-9}
    bonds = []
    for b in mol.GetBonds():
        i, j = b.GetBeginAtomIdx(), b.GetEndAtomIdx()
        bonds.append((i, j, b.GetBondTypeAsDouble(), rdFF.GetUFFBondStretchParams(mol, i, j)[1]))
    changed = True
    while changed:
        changed = False
        for i, j, order, r0 in bonds:
            keep_i = {li for li in candidates[i] if any(abs(rest_length(order, UFF_TABLE[li], UFF_TABLE[lj]) - r0) < 1e-9 for lj in candidates[j])}
            keep_j = {lj for lj in candidates[j] if any(abs(rest_length(order, UFF_TABLE[li], UFF_TABLE[lj]) - r0) < 1e-9 for li in candidates[i])}
            if keep_i != candidates[i] or keep_j != candidates[j]:
                candidates[i], candidates[j] = keep_i, keep_j
                changed = True
    if any(not c for c in candidates):
        raise RuntimeError("no UFF label reproduces RDKit's parameters for some atom")
    return [sorted(c) for c in candidates]


class LogCapture(logging.Handler):
    """Collects what RDKit writes to its C++ logs."""

    def __init__(self) -> None:
        super().__init__(level=logging.DEBUG)
        self.lines: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        # RDKit prefixes each line with the wall-clock time, e.g. "[22:07:08] UFFTYPER: ..."
        self.lines.append(re.sub(r"^\[\d\d:\d\d:\d\d\]\s*", "", record.getMessage().strip()))

    def take(self) -> list[str]:
        lines, self.lines = self.lines, []
        return lines


rdBase.LogToPythonLogger()
LOG = LogCapture()
_rdkit_logger = logging.getLogger("rdkit")
_rdkit_logger.handlers = [LOG]
_rdkit_logger.propagate = False
_rdkit_logger.setLevel(logging.DEBUG)


def flat(values) -> list[float]:
    out = [float(v) for v in values]
    if not all(math.isfinite(v) for v in out):
        raise ValueError("non-finite number in RDKit output")
    return out


def coords_of(mol: Chem.Mol) -> list[float]:
    return flat(np.asarray(mol.GetConformer().GetPositions(), dtype=float).reshape(-1))


def set_coords(mol: Chem.Mol, coords) -> None:
    conf = mol.GetConformer()
    arr = np.asarray(coords, dtype=float).reshape(-1, 3)
    for i, (x, y, z) in enumerate(arr):
        conf.SetAtomPosition(i, (float(x), float(y), float(z)))


def gradient_stats(grad: list[float]) -> tuple[float, float]:
    if not grad:
        return 0.0, 0.0
    g = np.asarray(grad, dtype=float)
    return float(np.sqrt(np.mean(g * g))), float(np.max(np.abs(g)))


def build(smiles: str) -> Chem.Mol:
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        raise ValueError(f"RDKit could not parse {smiles!r}")
    return Chem.AddHs(mol)


def alkane_chain_coordinates(mol: Chem.Mol) -> list[float]:
    """All-trans zig-zag coordinates for an unbranched alkane, slightly and reproducibly perturbed.

    Idealised values (C-C 1.53, C-H 1.09 angstrom, tetrahedral angles) are good enough: this is only
    a starting geometry, and the perturbation removes its exact symmetry.
    """
    n = mol.GetNumAtoms()
    coords = np.zeros((n, 3))
    carbons = [a.GetIdx() for a in mol.GetAtoms() if a.GetAtomicNum() == 6]
    half = math.radians(111.0 / 2.0)
    for order, idx in enumerate(carbons):
        if idx != order:
            raise ValueError("expected the chain carbons to come first, in chain order")
        coords[idx] = (order * 1.53 * math.sin(half), (order % 2) * 1.53 * math.cos(half), 0.0)
    placed: dict[int, int] = {}
    for a in mol.GetAtoms():
        if a.GetAtomicNum() != 1:
            continue
        parent = a.GetNeighbors()[0].GetIdx()
        k = placed.get(parent, 0)
        placed[parent] = k + 1
        up = 1.0 if parent % 2 == 1 else -1.0  # away from the neighbouring carbons
        if k < 2:
            offset = (0.0, up * 0.63, (1.0 if k == 0 else -1.0) * 0.89)
        else:  # the third hydrogen of a chain end points along the chain
            along = -1.0 if parent == carbons[0] else 1.0
            offset = (along * 1.03, -up * 0.36, 0.0)
        coords[a.GetIdx()] = coords[parent] + np.asarray(offset)
    rng = np.random.RandomState(EMBED_SEED)
    coords += rng.uniform(-0.05, 0.05, size=coords.shape)
    return flat(coords.reshape(-1))


# Molecules whose starting coordinates are constructed instead of embedded.
CUSTOM_COORDINATES = {"C140 alkane": ("all-trans chain built directly, perturbed by up to 0.05 angstrom", alkane_chain_coordinates)}


def embed(mol: Chem.Mol, name: str = "") -> str:
    """ETKDGv3 with a fixed seed; falls back to random starting coordinates. Returns the method used."""
    if name in CUSTOM_COORDINATES:
        description, builder = CUSTOM_COORDINATES[name]
        mol.AddConformer(Chem.Conformer(mol.GetNumAtoms()), assignId=True)
        set_coords(mol, builder(mol))
        return description
    params = AllChem.ETKDGv3()
    params.randomSeed = EMBED_SEED
    if AllChem.EmbedMolecule(mol, params) >= 0:
        return "ETKDGv3"
    params.useRandomCoords = True
    if AllChem.EmbedMolecule(mol, params) >= 0:
        return "ETKDGv3 (useRandomCoords)"
    raise RuntimeError("embedding failed")


def bond_table(mol: Chem.Mol) -> list[list]:
    table = []
    for b in mol.GetBonds():
        order = b.GetBondTypeAsDouble()
        if order not in (1.0, 1.5, 2.0, 3.0):
            raise ValueError(f"bond order {order} ({b.GetBondType()}) cannot be expressed in the FfBond contract")
        if (order == 1.5) != b.GetIsAromatic():
            raise ValueError("bond order 1.5 and the aromatic flag disagree")
        table.append([b.GetBeginAtomIdx(), b.GetEndAtomIdx(), order])
    return table


def perception(mol: Chem.Mol) -> dict:
    ri = mol.GetRingInfo()
    n = mol.GetNumAtoms()
    fragment = [0] * n
    for f, atoms in enumerate(Chem.GetMolFrags(mol)):
        for i in atoms:
            fragment[i] = f
    for a in mol.GetAtoms():
        if a.GetTotalNumHs() != 0:
            raise ValueError("atom still carries implicit or counted hydrogens after AddHs")
        if a.GetIsAromatic() != any(b.GetIsAromatic() for b in a.GetBonds()):
            raise ValueError("aromatic atom flag and aromatic bonds disagree")
    return {
        "hybridization": [str(a.GetHybridization()) for a in mol.GetAtoms()],
        "totalValence": [a.GetTotalValence() for a in mol.GetAtoms()],
        "radicalElectrons": [a.GetNumRadicalElectrons() for a in mol.GetAtoms()],
        "aromaticAtoms": [int(a.GetIsAromatic()) for a in mol.GetAtoms()],
        "conjugatedBonds": [int(b.GetIsConjugated()) for b in mol.GetBonds()],
        "inRing3": [int(ri.IsAtomInRingOfSize(i, 3)) for i in range(n)],
        "inRing4": [int(ri.IsAtomInRingOfSize(i, 4)) for i in range(n)],
        "fragments": fragment,
    }


def term_parameters(mol: Chem.Mol) -> dict:
    nbrs = [[x.GetIdx() for x in a.GetNeighbors()] for a in mol.GetAtoms()]
    n = mol.GetNumAtoms()

    bond_stretch = []
    for b in mol.GetBonds():
        i, j = b.GetBeginAtomIdx(), b.GetEndAtomIdx()
        kb, r0 = rdFF.GetUFFBondStretchParams(mol, i, j)
        bond_stretch.append([i, j, kb, r0])

    angle_bend = []
    for j in range(n):
        for a in range(len(nbrs[j])):
            for b in range(a + 1, len(nbrs[j])):
                i, k = nbrs[j][a], nbrs[j][b]
                ka, theta0 = rdFF.GetUFFAngleBendParams(mol, i, j, k)
                angle_bend.append([i, j, k, ka, theta0])

    torsion = []
    for b in mol.GetBonds():
        j, k = b.GetBeginAtomIdx(), b.GetEndAtomIdx()
        for i in nbrs[j]:
            if i == k:
                continue
            for l in nbrs[k]:
                if l == j or l == i:
                    continue
                res = rdFF.GetUFFTorsionParams(mol, i, j, k, l)
                torsion.append([i, j, k, l, None if res is None else float(res)])

    inversion = []
    for j in range(n):
        if len(nbrs[j]) != 3:
            continue
        a, b, c = nbrs[j]
        for i, k, l in ((a, b, c), (a, c, b), (b, c, a)):
            res = rdFF.GetUFFInversionParams(mol, i, j, k, l)
            inversion.append([i, j, k, l, None if res is None else float(res)])

    # van der Waals: every pair that is neither bonded nor shares a neighbour
    close = [set(nbrs[i]) | {x for j in nbrs[i] for x in nbrs[j]} for i in range(n)]
    pairs = [(i, j) for i in range(n) for j in range(i + 1, n) if j not in close[i]]
    sampled = len(pairs) > MAX_VDW_PAIRS
    if sampled:
        step = len(pairs) / MAX_VDW_PAIRS
        pairs = [pairs[int(s * step)] for s in range(MAX_VDW_PAIRS)]
    vdw = []
    for i, j in pairs:
        x_ij, d_ij = rdFF.GetUFFVdWParams(mol, i, j)
        vdw.append([i, j, x_ij, d_ij])

    return {
        "bondStretch": bond_stretch,
        "angleBend": angle_bend,
        "torsion": torsion,
        "inversion": inversion,
        "vdw": vdw,
        "vdwSampled": sampled,
    }


def force_field(mol: Chem.Mol):
    ff = rdFF.UFFGetMoleculeForceField(mol, vdwThresh=VDW_THRESH, ignoreInterfragInteractions=True)
    if ff is None:
        raise RuntimeError("UFFGetMoleculeForceField returned None")
    return ff


def energy_and_gradient(ff, coords) -> tuple[float, np.ndarray]:
    """RDKit's energy and gradient at the given coordinates.

    ``ForceField.CalcGrad(pos)`` must not be called on its own: RDKit caches interatomic distances
    and only ``CalcEnergy(pos)`` resets that cache, so a gradient requested at coordinates that
    differ from those of the last energy evaluation is silently wrong (it mixes old distances with
    new directions). RDKit's own minimiser always evaluates the energy first, and so does this.
    """
    pos = [float(v) for v in coords]
    energy = float(ff.CalcEnergy(pos))
    return energy, np.asarray(ff.CalcGrad(pos), dtype=float)


def polish(ff, start: list[float], gradient_tolerance: float = 1e-6, max_iterations: int = 5000) -> dict:
    """Tightly minimises RDKit's own energy function, starting from RDKit's optimised geometry.

    RDKit's minimiser stops at a loose, relative criterion (RMS gradients of 1e-4 to 1e-3
    kcal/mol/angstrom). To know where the minimum of RDKit's UFF energy really is, this runs a plain
    BFGS with a backtracking line search in NumPy, using RDKit only as the oracle for the energy
    (``CalcEnergy``) and the gradient (``CalcGrad``). Steps are capped at 0.05 angstrom per coordinate
    so the search stays in the basin RDKit found. It stops at the gradient tolerance, or when the
    energy has stopped improving at double-precision resolution (the cosine-series angle terms cancel
    to rounding noise near their minimum, which limits how far an energy-based line search can go).
    """
    x = np.asarray(start, dtype=float).copy()
    n = x.size
    energy, grad = energy_and_gradient(ff, x)
    inv_hessian = np.eye(n)
    iterations = 0
    resets = 0
    stalled = 0
    reason = "gradient tolerance"
    while float(np.sqrt(np.mean(grad * grad))) > gradient_tolerance:
        if iterations >= max_iterations:
            reason = "iteration limit"
            break
        direction = -inv_hessian @ grad
        slope = float(direction @ grad)
        if slope >= 0.0:
            inv_hessian = np.eye(n)
            direction = -grad
            slope = float(direction @ grad)
        biggest = float(np.max(np.abs(direction)))
        if biggest > 0.05:
            direction *= 0.05 / biggest
            slope = float(direction @ grad)
        step = 1.0
        accepted = False
        while step > 1e-14:
            trial = x + step * direction
            trial_energy = float(ff.CalcEnergy(trial.tolist()))
            if trial_energy <= energy + 1e-4 * step * slope:
                accepted = True
                break
            step *= 0.5
        if not accepted:
            # No decrease along this direction at floating-point resolution: retry from steepest
            # descent, then accept that this is as far as double precision goes.
            if resets >= 2:
                reason = "no further decrease at double precision"
                break
            resets += 1
            inv_hessian = np.eye(n)
            continue
        # (energy_and_gradient re-evaluates the energy so that RDKit's distance cache matches `trial`)
        trial_energy, trial_grad = energy_and_gradient(ff, trial)
        s = trial - x
        y = trial_grad - grad
        sy = float(s @ y)
        if sy > 1e-14 * float(np.linalg.norm(s) * np.linalg.norm(y)):
            rho = 1.0 / sy
            hy = inv_hessian @ y
            inv_hessian += (rho * rho * float(y @ hy) + rho) * np.outer(s, s) - rho * (np.outer(s, hy) + np.outer(hy, s))
        stalled = stalled + 1 if energy - trial_energy <= 1e-13 * max(1.0, abs(energy)) else 0
        x, energy, grad = trial, trial_energy, trial_grad
        iterations += 1
        if stalled >= 25:
            reason = "no further decrease at double precision"
            break
    rms, mx = gradient_stats(grad.tolist())
    return {
        "method": "NumPy BFGS on RDKit CalcEnergy/CalcGrad, started from the UFFOptimizeMolecule result",
        "iterations": iterations,
        "stopped": reason,
        "energy": energy,
        "coords": flat(x),
        "rmsGradient": rms,
        "maxGradient": mx,
    }


def hessian_summary(ff, coords: list[float], step: float = 1e-4) -> dict:
    """Lowest eigenvalue of the Hessian of RDKit's energy, by central differences of RDKit's gradient.

    A clearly negative eigenvalue means the geometry is a saddle point, not a minimum. The six (or
    five) rigid-body modes of each fragment give eigenvalues near zero.
    """
    x = np.asarray(coords, dtype=float)
    n = x.size
    hessian = np.zeros((n, n))
    for i in range(n):
        plus = x.copy()
        minus = x.copy()
        plus[i] += step
        minus[i] -= step
        hessian[i] = (energy_and_gradient(ff, plus)[1] - energy_and_gradient(ff, minus)[1]) / (2.0 * step)
    hessian = 0.5 * (hessian + hessian.T)
    if not np.all(np.isfinite(hessian)):
        return {"finite": False}
    eigenvalues = np.linalg.eigvalsh(hessian)
    return {
        "finite": True,
        "step": step,
        "lowestEigenvalue": float(eigenvalues[0]),
        "highestEigenvalue": float(eigenvalues[-1]),
        "numBelowMinus0p01": int(np.sum(eigenvalues < -0.01)),
    }


def optimize(mol: Chem.Mol) -> tuple[dict, dict]:
    """UFFOptimizeMolecule until it reports convergence, then a tight polish of RDKit's energy function."""
    work = Chem.Mol(mol)
    status = 1
    calls = 0
    while status != 0 and calls < 500:
        status = rdFF.UFFOptimizeMolecule(work, maxIters=1000, vdwThresh=VDW_THRESH, ignoreInterfragInteractions=True)
        calls += 1
    ff = force_field(work)
    optimized_energy = float(ff.CalcEnergy())
    grad = flat(ff.CalcGrad())
    rms, mx = gradient_stats(grad)
    default = {
        "converged": status == 0,
        "calls": calls,
        "energy": optimized_energy,
        "coords": coords_of(work),
        "rmsGradient": rms,
        "maxGradient": mx,
    }
    default["hessian"] = hessian_summary(ff, default["coords"])
    polished = polish(ff, default["coords"])
    polished["hessian"] = hessian_summary(ff, polished["coords"])
    return default, polished


def contract_round_trip(mol: Chem.Mol, energy: float) -> dict:
    """Rebuild the molecule from exactly what the TypeScript package is given and ask RDKit again.

    The rebuilt molecule has only explicit atoms (no implicit hydrogens allowed), integer formal
    charges and bonds that are single, double, triple or aromatic. If RDKit perceives it identically,
    the input contract loses nothing that UFF needs.
    """
    try:
        rw = Chem.RWMol()
        for a in mol.GetAtoms():
            na = Chem.Atom(a.GetAtomicNum())
            na.SetFormalCharge(a.GetFormalCharge())
            na.SetNoImplicit(True)
            rw.AddAtom(na)
        kinds = {1.0: Chem.BondType.SINGLE, 1.5: Chem.BondType.AROMATIC, 2.0: Chem.BondType.DOUBLE, 3.0: Chem.BondType.TRIPLE}
        for b in mol.GetBonds():
            order = b.GetBondTypeAsDouble()
            rw.AddBond(b.GetBeginAtomIdx(), b.GetEndAtomIdx(), kinds[order])
            if order == 1.5:
                nb = rw.GetBondBetweenAtoms(b.GetBeginAtomIdx(), b.GetEndAtomIdx())
                nb.SetIsAromatic(True)
                rw.GetAtomWithIdx(b.GetBeginAtomIdx()).SetIsAromatic(True)
                rw.GetAtomWithIdx(b.GetEndAtomIdx()).SetIsAromatic(True)
        Chem.SanitizeMol(rw)
        rebuilt = rw.GetMol()
        conf = Chem.Conformer(mol.GetConformer())
        rebuilt.AddConformer(conf, assignId=True)
        problems = []
        if bond_table(rebuilt) != bond_table(mol):
            problems.append("bond orders differ after sanitisation")
        heavy = [a.GetIdx() for a in mol.GetAtoms() if a.GetAtomicNum() > 1]
        hyb_a = [str(mol.GetAtomWithIdx(i).GetHybridization()) for i in heavy]
        hyb_b = [str(rebuilt.GetAtomWithIdx(i).GetHybridization()) for i in heavy]
        if hyb_a != hyb_b:
            problems.append("heavy-atom hybridisation differs")
        if [int(b.GetIsConjugated()) for b in mol.GetBonds()] != [int(b.GetIsConjugated()) for b in rebuilt.GetBonds()]:
            problems.append("bond conjugation differs")
        if [a.GetNumRadicalElectrons() for a in mol.GetAtoms()] != [a.GetNumRadicalElectrons() for a in rebuilt.GetAtoms()]:
            problems.append("radical counts differ")
        if not rdFF.UFFHasAllMoleculeParams(rebuilt):
            problems.append("rebuilt molecule cannot be typed")
            return {"ok": False, "reason": "; ".join(problems)}
        e2 = float(force_field(rebuilt).CalcEnergy())
        diff = e2 - energy
        if abs(diff) > 1e-9 * max(1.0, abs(energy)):
            problems.append(f"UFF energy differs by {diff:.3e} kcal/mol")
        if problems:
            return {"ok": False, "reason": "; ".join(problems), "energyDifference": diff}
        return {"ok": True, "energyDifference": diff}
    except Exception as exc:  # noqa: BLE001 - the reason is recorded in the fixture
        return {"ok": False, "reason": f"{type(exc).__name__}: {str(exc).strip().splitlines()[0] if str(exc).strip() else ''}"}
    finally:
        LOG.take()


def set_angle(coords: list[float], i: int, j: int, k: int, degrees: float) -> list[float]:
    """Moves atom k, keeping its distance from j, so that the angle i-j-k has the given value."""
    c = np.asarray(coords, dtype=float).reshape(-1, 3).copy()
    u = c[i] - c[j]
    u /= np.linalg.norm(u)
    w = c[k] - c[j]
    length = np.linalg.norm(w)
    v = w - np.dot(w, u) * u
    if np.linalg.norm(v) < 1e-8:
        # i, j, k are collinear: pick any perpendicular direction
        helper = np.array([1.0, 0.0, 0.0]) if abs(u[0]) < 0.9 else np.array([0.0, 1.0, 0.0])
        v = np.cross(u, helper)
    v /= np.linalg.norm(v)
    a = math.radians(degrees)
    c[k] = c[j] + length * (math.cos(a) * u + math.sin(a) * v)
    return flat(c.reshape(-1))


def first_angle(mol: Chem.Mol, centre_z: int, end_z: tuple[int, int]) -> tuple[int, int, int]:
    """Finds an angle i-j-k whose vertex has atomic number centre_z and whose ends have the given numbers."""
    for a in mol.GetAtoms():
        if a.GetAtomicNum() != centre_z:
            continue
        nb = [x.GetIdx() for x in a.GetNeighbors()]
        for p in range(len(nb)):
            for q in range(len(nb)):
                if p == q:
                    continue
                zi = mol.GetAtomWithIdx(nb[p]).GetAtomicNum()
                zk = mol.GetAtomWithIdx(nb[q]).GetAtomicNum()
                if (zi, zk) == end_z:
                    return nb[p], a.GetIdx(), nb[q]
    raise ValueError("angle not found")


# (name, base molecule, description, function(mol, coords) -> coords)
def _distortions():
    def bend(centre_z, end_z, degrees):
        def apply(mol, coords):
            i, j, k = first_angle(mol, centre_z, end_z)
            return set_angle(coords, i, j, k, degrees)

        return apply

    def coincide_14_hydrogens(mol, coords):
        c = np.asarray(coords, dtype=float).reshape(-1, 3).copy()
        h_on = {}
        for a in mol.GetAtoms():
            if a.GetAtomicNum() == 1:
                h_on.setdefault(a.GetNeighbors()[0].GetIdx(), []).append(a.GetIdx())
        (c0, hs0), (c1, hs1) = sorted(h_on.items())[:2]
        del c0, c1
        c[hs1[0]] = c[hs0[0]]
        return flat(c.reshape(-1))

    def scale(factor):
        def apply(mol, coords):
            del mol
            return flat(np.asarray(coords, dtype=float) * factor)

        return apply

    return [
        ("formaldehyde H-C-H 25 deg", "formaldehyde", "sp2 vertex below the 30 degree threshold of RDKit's small-angle penalty", bend(6, (1, 1), 25.0)),
        ("ethene H-C-H 15 deg", "ethene", "sp2 vertex far below the small-angle threshold", bend(6, (1, 1), 15.0)),
        ("carbon dioxide O-C-O 28 deg", "carbon dioxide", "sp vertex below the small-angle threshold", bend(6, (8, 8), 28.0)),
        ("ethyne H-C-C 29 deg", "ethyne", "sp vertex just below the small-angle threshold", bend(6, (1, 6), 29.0)),
        ("ethyne H-C-C 31 deg", "ethyne", "sp vertex just above the small-angle threshold", bend(6, (1, 6), 31.0)),
        ("hexafluorophosphate F-P-F 20 deg", "hexafluorophosphate", "octahedral (order 4) vertex below the small-angle threshold", bend(15, (9, 9), 20.0)),
        ("water H-O-H 10 deg", "water", "sp3 vertex at a very small angle (no penalty term for the general cosine form)", bend(8, (1, 1), 10.0)),
        ("water H-O-H 180 deg", "water", "exactly linear water", bend(8, (1, 1), 180.0)),
        ("butane C-C-C 180 deg", "butane", "three consecutive carbons exactly collinear: torsions about a degenerate axis", bend(6, (6, 6), 180.0)),
        ("butane C-C-C 179.9 deg", "butane", "three consecutive carbons almost collinear", bend(6, (6, 6), 179.9)),
        ("formaldehyde H-C-O 180 deg", "formaldehyde", "sp2 centre with two neighbours collinear: inversion plane undefined", bend(6, (8, 1), 180.0)),
        ("ethane coincident 1-4 hydrogens", "ethane", "two non-bonded hydrogens at exactly the same position", coincide_14_hydrogens),
        ("benzene compressed x0.6", "benzene", "uniformly shrunk: strongly repulsive van der Waals contacts and compressed bonds", scale(0.6)),
        ("ethanol expanded x3", "ethanol", "uniformly expanded: very long bonds", scale(3.0)),
        ("aspirin compressed x0.7", "aspirin", "uniformly shrunk drug-like molecule", scale(0.7)),
    ]


def process(index: int, name: str, smiles: str, classes: list[str], source: str | None, test_labels: dict[int, str] | None = None) -> tuple[str, dict]:
    LOG.take()
    mol = build(smiles)
    formula = rdMolDescriptors.CalcMolFormula(mol)
    if name in EXPECTED_FORMULAS and formula != EXPECTED_FORMULAS[name]:
        raise ValueError(f"{name}: formula {formula} != expected {EXPECTED_FORMULAS[name]}")
    method = embed(mol, name)
    LOG.take()

    has_all = rdFF.UFFHasAllMoleculeParams(mol)
    typer_log = LOG.take()

    record: dict = {
        "name": name,
        "smiles": smiles,
        "classes": classes,
        "formula": formula,
        "nAtoms": mol.GetNumAtoms(),
        "z": [a.GetAtomicNum() for a in mol.GetAtoms()],
        "formalCharge": [a.GetFormalCharge() for a in mol.GetAtoms()],
        "bonds": bond_table(mol),
        "embedMethod": method,
        "coords": coords_of(mol),
        "perception": perception(mol),
        "typerLog": typer_log,
    }
    if source:
        record["source"] = source

    if not has_all:
        unrecognized = []
        for line in typer_log:
            m = re.search(r"Unrecognized atom type: (\S+) \((\d+)\)", line)
            if m:
                unrecognized.append({"atomIndex": int(m.group(2)), "label": m.group(1)})
        if not unrecognized:
            raise RuntimeError(f"{name}: RDKit reports missing parameters but logged no atom type")
        record["unrecognized"] = unrecognized
        return "unsupported", record

    record["numRotatableBonds"] = int(rdMolDescriptors.CalcNumRotatableBonds(mol))
    record["rigid"] = record["numRotatableBonds"] == 0

    ff = force_field(mol)
    record["energy"] = float(ff.CalcEnergy())
    record["gradient"] = flat(ff.CalcGrad())
    if not math.isfinite(record["energy"]):
        raise ValueError(f"{name}: non-finite energy")

    rng = np.random.RandomState(EMBED_SEED + 1000 + index)
    moved = (np.asarray(record["coords"]) + rng.uniform(-PERTURBATION, PERTURBATION, size=len(record["coords"]))).tolist()
    moved_energy, moved_gradient = energy_and_gradient(ff, moved)
    record["perturbed"] = {
        "coords": flat(moved),
        "energy": moved_energy,
        "gradient": flat(moved_gradient),
    }

    record["params"] = term_parameters(mol)
    record["uffLabelCandidates"] = infer_uff_labels(mol)
    if test_labels:
        for idx, label in sorted(test_labels.items()):
            if label not in record["uffLabelCandidates"][idx]:
                raise RuntimeError(f"{name}: RDKit's unit test expects {label} on atom {idx}, parameters imply {record['uffLabelCandidates'][idx]}")
        record["rdkitTestLabels"] = [[idx, label] for idx, label in sorted(test_labels.items())]
    record["optimized"], record["polished"] = optimize(mol)
    record["contractRoundTrip"] = contract_round_trip(mol, record["energy"])
    LOG.take()
    return "supported", record


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=pathlib.Path, default=DEFAULT_OUT)
    parser.add_argument(
        "--only",
        default="",
        help="comma-separated name fragments: process only matching molecules (for debugging; writes an incomplete fixture)",
    )
    args = parser.parse_args()
    only = [fragment.strip().lower() for fragment in args.only.split(",") if fragment.strip()]

    supported: list[dict] = []
    unsupported: list[dict] = []
    molecules_by_name: dict[str, Chem.Mol] = {}
    # The molecules of RDKit's own atom-typer unit tests, with the labels those tests assert.
    typer_tests = rdkit_typer_test_expectations()
    entries: list[tuple] = list(MOLECULES)
    test_labels_by_name: dict[str, dict[int, str]] = {}
    for test_smiles, labels in typer_tests.items():
        test_name = f"RDKit unit test {test_smiles}"
        entries.append((test_name, test_smiles, ["rdkit-unit-test"], "RDKit Code/GraphMol/ForceFieldHelpers/UFF/testUFFHelpers.cpp"))
        test_labels_by_name[test_name] = labels
    names = [m[0] for m in entries]
    if len(set(names)) != len(names):
        raise ValueError("duplicate molecule names")

    for index, entry in enumerate(entries):
        name, smiles, classes = entry[0], entry[1], entry[2]
        if only and not any(fragment in name.lower() for fragment in only):
            continue
        source = entry[3] if len(entry) > 3 else None
        kind, record = process(index, name, smiles, classes, source, test_labels_by_name.get(name))
        (supported if kind == "supported" else unsupported).append(record)
        if kind == "supported":
            mol = build(smiles)
            mol.AddConformer(Chem.Conformer(mol.GetNumAtoms()), assignId=True)
            set_coords(mol, record["coords"])
            molecules_by_name[name] = mol
            opt = record["optimized"]
            pol = record["polished"]
            low_opt = opt["hessian"].get("lowestEigenvalue", float("nan"))
            low_pol = pol["hessian"].get("lowestEigenvalue", float("nan"))
            print(
                f"  {name:42s} {record['nAtoms']:4d} atoms  E={record['energy']:14.6f}  "
                f"opt={opt['energy']:14.6f} ({'ok' if opt['converged'] else 'NOT CONVERGED'}, {opt['calls']} call(s), "
                f"rms|g|={opt['rmsGradient']:.1e}, lowest curvature {low_opt:+.3f})  polished={pol['energy']:16.9f} (rms|g|={pol['rmsGradient']:.1e}, "
                f"dE={pol['energy'] - opt['energy']:+.1e}, {pol['iterations']} it, {pol['stopped']}, lowest curvature {low_pol:+.3f})"
                f"{'' if record['contractRoundTrip']['ok'] else '  ROUND-TRIP: ' + record['contractRoundTrip']['reason']}"
                f"{'  LOG: ' + ' | '.join(record['typerLog']) if record['typerLog'] else ''}"
            )
        else:
            labels = ", ".join(f"{u['label']} (atom {u['atomIndex']})" for u in record["unrecognized"])
            print(f"  {name:42s} {record['nAtoms']:4d} atoms  UNSUPPORTED by RDKit: {labels}")

    distorted: list[dict] = []
    for name, base, description, transform in _distortions():
        if base not in molecules_by_name:
            continue  # only possible with --only
        mol = Chem.Mol(molecules_by_name[base])
        base_record = next(r for r in supported if r["name"] == base)
        coords = transform(mol, base_record["coords"])
        set_coords(mol, coords)
        LOG.take()
        ff = force_field(mol)
        energy = float(ff.CalcEnergy())
        if not math.isfinite(energy):
            raise ValueError(f"{name}: non-finite energy")
        raw_grad = [float(v) for v in ff.CalcGrad()]
        entry = {"name": name, "molecule": base, "description": description, "coords": coords, "energy": energy}
        if all(math.isfinite(v) for v in raw_grad):
            entry["gradient"] = raw_grad
            print(f"  distorted: {name:40s} E={energy:.6e}  max|g|={gradient_stats(raw_grad)[1]:.3e}")
        else:
            # RDKit itself divides by zero here. JSON cannot hold NaN, so only the fact is recorded.
            bad = sorted({i // 3 for i, v in enumerate(raw_grad) if not math.isfinite(v)})
            entry["gradient"] = None
            entry["rdkitGradientNonFiniteAtoms"] = bad
            print(f"  distorted: {name:40s} E={energy:.6e}  RDKit gradient is NaN/inf on atoms {bad}")
        distorted.append(entry)
    LOG.take()

    payload_meta = {
        "generator": "packages/forcefield/tools/gen_uff_reference.py",
        "rdkitVersion": rdkit.__version__,
        "numpyVersion": np.__version__,
        "pythonVersion": platform.python_version(),
        "platform": platform.platform(),
        "generated": datetime.date.today().isoformat(),
        "embedding": {"method": "ETKDGv3", "randomSeed": EMBED_SEED},
        "uffSettings": {"vdwThresh": VDW_THRESH, "ignoreInterfragInteractions": True},
        "perturbation": {"amplitudeAngstrom": PERTURBATION, "distribution": "uniform per Cartesian coordinate"},
        "units": {"energy": "kcal/mol", "gradient": "kcal/mol/angstrom", "coordinates": "angstrom", "theta0": "degrees"},
        "counts": {"supported": len(supported), "unsupported": len(unsupported), "distorted": len(distorted)},
        "notes": [
            "coords/energy/gradient: the embedded geometry; perturbed: the same force field evaluated at randomly displaced coordinates.",
            "optimized: UFFOptimizeMolecule(maxIters=1000) repeated until it returns 0.",
            "polished: RDKit's energy function (CalcEnergy/CalcGrad) minimised tightly with a NumPy BFGS, started from 'optimized'.",
            "hessian: eigenvalues of the Hessian of RDKit's energy (central differences of CalcGrad, numpy.linalg.eigvalsh); a clearly negative lowestEigenvalue marks a saddle point.",
            "uffLabelCandidates: per atom, the UFF atom types consistent with every bond length and angle RDKit reports (see infer_uff_labels); RDKit's Python API has no label getter.",
            "rdkitTestLabels: [atom index, label] pairs asserted by RDKit's own unit test testUFFHelpers.cpp for that SMILES.",
            "params.torsion V is the barrier before RDKit divides it by the number of torsions about the bond.",
            "params.angleBend is what GetUFFAngleBendParams returns; it does not include the small-ring adjustments of the force field.",
            "distorted: geometries built to reach special cases; the force field is constructed at the listed coordinates.",
        ],
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    dumps = lambda obj: json.dumps(obj, separators=(",", ":"), allow_nan=False)  # noqa: E731
    with args.out.open("w", encoding="utf-8", newline="\n") as fh:
        fh.write('{\n"meta":' + json.dumps(payload_meta, indent=1, allow_nan=False) + ",\n")
        for key, items in (("molecules", supported), ("distorted", distorted), ("unsupported", unsupported)):
            fh.write(f'"{key}":[\n')
            fh.write(",\n".join(dumps(item) for item in items))
            fh.write("\n]" + ("\n" if key == "unsupported" else ",\n"))
        fh.write("}\n")

    not_converged = [r["name"] for r in supported if not r["optimized"]["converged"]]
    round_trip_failures = [r["name"] for r in supported if not r["contractRoundTrip"]["ok"]]
    saddles = [r["name"] for r in supported if r["optimized"]["hessian"].get("lowestEigenvalue", 0.0) < -0.01]
    n_atoms = sum(r["nAtoms"] for r in supported)
    n_unique = sum(1 for r in supported for c in r["uffLabelCandidates"] if len(c) == 1)
    print(f"\nRDKit {rdkit.__version__}: {len(supported)} supported molecules, {len(unsupported)} unsupported, {len(distorted)} distorted geometries")
    print(f"UFFOptimizeMolecule did not converge for: {not_converged or 'none'}")
    print(f"UFFOptimizeMolecule stopped on a geometry with a Hessian eigenvalue below -0.01 for: {saddles or 'none'}")
    print(f"contract round trip differs for: {round_trip_failures or 'none'}")
    print(f"UFF atom types deduced from RDKit's parameters: unique for {n_unique} of {n_atoms} atoms")
    print(f"wrote {args.out} ({args.out.stat().st_size / 1e6:.2f} MB)")
    if only:
        print("NOTE: --only was given; this fixture is incomplete.")
        return 0
    if len(supported) < 45:
        print("ERROR: fewer than 45 supported molecules", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
