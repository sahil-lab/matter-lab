"""Parse, sanitise and describe a structure with RDKit.

`parse_structure` never raises for bad chemistry: it returns a `ParsedStructure` whose `errors`
carry RDKit's own messages (and the atoms they refer to) so callers can show them unchanged.
Atom indices always refer to the atoms of the input, in input order; hydrogens that are explicit
atoms in the input stay explicit atoms.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

import numpy as np
from rdkit import Chem, rdBase
from rdkit.Chem import Descriptors, inchi, rdCIPLabeler, rdMolDescriptors
from rdkit.Chem.inchi import rdinchi

from . import rdlog

RDKIT_VERSION: str = rdBase.rdkitVersion
INCHI_VERSION: str | None = inchi.GetInchiVersion() if inchi.INCHI_AVAILABLE else None

StructureFormat = Literal["smiles", "molblock"]

# Text of the largest structure the service will try to parse (a 5,000-atom molfile is ~0.5 MB).
MAX_STRUCTURE_CHARS = 2_000_000


def derived_by() -> dict[str, Any]:
    """Engine record stored next to every structure-derived value."""
    return {"engine": "RDKit", "version": RDKIT_VERSION, "inchi_software_version": INCHI_VERSION}


@dataclass(frozen=True)
class Problem:
    type: str
    message: str
    atom_indices: tuple[int, ...] = ()

    def as_dict(self) -> dict[str, Any]:
        return {"type": self.type, "message": self.message, "atom_indices": list(self.atom_indices)}


@dataclass
class ParsedStructure:
    input_format: str
    stage: Literal["parse", "sanitization", "complete"]
    mol: Chem.Mol | None = None
    errors: list[Problem] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    failed_operation: str | None = None
    implicit_hydrogens: bool = True

    @property
    def valid(self) -> bool:
        return self.mol is not None and not self.errors

    def error_summary(self) -> str:
        return "; ".join(p.message for p in self.errors) or "the structure could not be interpreted"


def _chemistry_problems(mol: Chem.Mol) -> list[Problem]:
    problems: list[Problem] = []
    for issue in Chem.DetectChemistryProblems(mol):
        indices: tuple[int, ...] = ()
        for getter in ("GetAtomIndices", "GetAtomIdx"):
            if hasattr(issue, getter):
                try:
                    value = getattr(issue, getter)()
                except Exception:  # RDKit raises when the problem has no atom attached
                    continue
                indices = tuple(int(i) for i in value) if getter == "GetAtomIndices" else (int(value),)
                break
        problems.append(Problem(issue.GetType(), issue.Message(), indices))
    return problems


def _assign_cip_labels(mol: Chem.Mol) -> None:
    try:
        rdCIPLabeler.AssignCIPLabels(mol)
    except Exception:
        # The new labeller gives up on very large or very symmetric molecules; the legacy
        # assignment done during sanitisation is kept in that case.
        pass


def parse_structure(fmt: str, data: str, *, implicit_hydrogens: bool = True) -> ParsedStructure:
    """Parses and sanitises. `implicit_hydrogens=False` (molblock only) treats the drawn atoms as
    the complete structure: no hydrogens are implied, so open valences are radicals."""
    if fmt not in ("smiles", "molblock"):
        raise ValueError(f"unknown structure format: {fmt}")
    label = "SMILES" if fmt == "smiles" else "molblock"
    result = ParsedStructure(input_format=fmt, stage="parse", implicit_hydrogens=implicit_hydrogens)

    text = data.strip() if fmt == "smiles" else data.replace("\r\n", "\n").replace("\r", "\n")
    if not text.strip():
        result.errors.append(Problem("ParseError", f"The {label} is empty."))
        return result
    if fmt == "smiles" and not implicit_hydrogens:
        raise ValueError("implicit_hydrogens=False is only meaningful for molblock input")

    with rdlog.capture() as log:
        try:
            if fmt == "smiles":
                raw = Chem.MolFromSmiles(text, sanitize=False)
            else:
                raw = Chem.MolFromMolBlock(text, sanitize=False, removeHs=False)
        except Exception as exc:  # defensive: RDKit normally returns None instead of raising
            raw = None
            log.append(("ERROR", f"[00:00:00] {exc}"))
    if raw is None:
        said = rdlog.messages(log)
        if not said:
            said = [f"RDKit could not parse the {label} and reported no further detail."]
        result.errors.extend(Problem("ParseError", message) for message in said)
        return result
    if raw.GetNumAtoms() == 0:
        result.errors.append(Problem("ParseError", f"The {label} contains no atoms."))
        return result

    result.stage = "sanitization"
    if not implicit_hydrogens:
        for atom in raw.GetAtoms():
            atom.SetNoImplicit(True)

    with rdlog.capture():
        problems = _chemistry_problems(raw)
        if problems:
            flag = Chem.SanitizeMol(Chem.Mol(raw), catchErrors=True)
            result.failed_operation = None if flag == Chem.SanitizeFlags.SANITIZE_NONE else str(flag)
            result.errors.extend(problems)
            return result

    with rdlog.capture() as log:
        mol: Chem.Mol | None
        try:
            if not implicit_hydrogens:
                flag = Chem.SanitizeMol(raw, catchErrors=True)
                if flag != Chem.SanitizeFlags.SANITIZE_NONE:
                    result.failed_operation = str(flag)
                    mol = None
                else:
                    mol = raw
                    if mol.GetNumConformers() and mol.GetConformer().Is3D():
                        Chem.AssignStereochemistryFrom3D(mol)
                    else:
                        Chem.AssignChiralTypesFromBondDirs(mol)
                        Chem.AssignStereochemistry(mol, cleanIt=True, force=True)
            elif fmt == "smiles":
                params = Chem.SmilesParserParams()
                params.removeHs = False
                mol = Chem.MolFromSmiles(text, params)
            else:
                mol = Chem.MolFromMolBlock(text, sanitize=True, removeHs=False)
        except Exception as exc:
            mol = None
            log.append(("ERROR", f"[00:00:00] {exc}"))
    if mol is None:
        said = rdlog.messages(log) or ["RDKit sanitisation failed and reported no further detail."]
        result.errors.extend(Problem("SanitizeError", message) for message in said)
        return result

    _assign_cip_labels(mol)
    result.mol = mol
    result.stage = "complete"
    result.warnings.extend(rdlog.messages(log, levels=("WARNING",)))
    return result


def strip_hydrogens(mol: Chem.Mol) -> Chem.Mol:
    """Hydrogens folded back into their heavy atoms where RDKit allows it (H2, H+ and the like stay)."""
    try:
        return Chem.RemoveHs(mol)
    except Exception:
        return Chem.Mol(mol)


def canonical_smiles(mol: Chem.Mol) -> str:
    return Chem.MolToSmiles(strip_hydrogens(mol))


def standard_mol(mol: Chem.Mol) -> Chem.Mol:
    """The molecule rebuilt from its canonical SMILES: the single form used for fingerprints and
    substructure matching, so queries and catalogue entries are always compared like with like."""
    rebuilt = Chem.MolFromSmiles(canonical_smiles(mol))
    return rebuilt if rebuilt is not None else strip_hydrogens(mol)


def inchi_for(mol: Chem.Mol) -> tuple[str | None, str | None, list[str]]:
    """(InChI, InChIKey, messages). InChI is None when the InChI software rejects the structure."""
    if not inchi.INCHI_AVAILABLE:
        return None, None, ["This RDKit build has no InChI support."]
    try:
        text, code, message, _log, _aux = rdinchi.MolToInchi(mol, "")
    except Exception as exc:
        return None, None, [f"InChI generation failed: {exc}"]
    notes = [f"InChI: {part.strip()}" for part in message.split(";") if part.strip()] if message else []
    if code not in (0, 1) or not text:
        return None, None, notes or ["InChI generation failed."]
    return text, rdinchi.InchiToInchiKey(text), notes


def has_usable_3d(mol: Chem.Mol) -> bool:
    """True when the molecule carries 3D coordinates in which no two atoms coincide."""
    if mol.GetNumConformers() == 0:
        return False
    conformer = mol.GetConformer()
    if not conformer.Is3D():
        return False
    positions = np.asarray(conformer.GetPositions(), dtype=float)
    if not np.all(np.isfinite(positions)):
        return False
    if len(positions) < 2:
        return True
    deltas = positions[:, None, :] - positions[None, :, :]
    distances = np.sqrt((deltas**2).sum(axis=-1))
    distances[np.diag_indices(len(positions))] = np.inf
    return bool(distances.min() > 1e-3)


def _stereo(mol: Chem.Mol) -> dict[str, Any]:
    centers: list[dict[str, Any]] = []
    bonds: list[dict[str, Any]] = []
    other: list[dict[str, Any]] = []
    try:
        elements = list(Chem.FindPotentialStereo(mol))
    except Exception:
        elements = []
    for element in elements:
        specified = element.specified == Chem.StereoSpecified.Specified
        if element.type == Chem.StereoType.Atom_Tetrahedral:
            atom = mol.GetAtomWithIdx(int(element.centeredOn))
            centers.append(
                {
                    "atom_index": atom.GetIdx(),
                    "specified": specified,
                    "cip_label": atom.GetProp("_CIPCode") if specified and atom.HasProp("_CIPCode") else None,
                }
            )
        elif element.type == Chem.StereoType.Bond_Double:
            bond = mol.GetBondWithIdx(int(element.centeredOn))
            label = bond.GetProp("_CIPCode") if specified and bond.HasProp("_CIPCode") else None
            bonds.append(
                {
                    "bond_index": bond.GetIdx(),
                    "begin_atom_index": bond.GetBeginAtomIdx(),
                    "end_atom_index": bond.GetEndAtomIdx(),
                    "specified": specified,
                    "cip_label": label,
                }
            )
        else:
            other.append({"type": str(element.type), "centered_on": int(element.centeredOn), "specified": specified})
    unspecified = sum(not c["specified"] for c in centers) + sum(not b["specified"] for b in bonds)
    return {
        "tetrahedral_centers": centers,
        "double_bonds": bonds,
        "other_elements": other,
        "unspecified_count": unspecified,
    }


def _rings(mol: Chem.Mol) -> dict[str, Any]:
    info = mol.GetRingInfo()
    rings = []
    for atom_ring, bond_ring in zip(info.AtomRings(), info.BondRings()):
        rings.append(
            {
                "size": len(atom_ring),
                "atom_indices": [int(i) for i in atom_ring],
                "aromatic": all(mol.GetBondWithIdx(int(b)).GetIsAromatic() for b in bond_ring),
            }
        )
    return {
        "ring_count": len(rings),
        "aromatic_ring_count": sum(r["aromatic"] for r in rings),
        "aromatic_atom_count": sum(1 for a in mol.GetAtoms() if a.GetIsAromatic()),
        "rings": rings,
    }


def _atoms(mol: Chem.Mol) -> list[dict[str, Any]]:
    atoms = []
    for atom in mol.GetAtoms():
        atoms.append(
            {
                "index": atom.GetIdx(),
                "element": atom.GetSymbol(),
                "atomic_number": atom.GetAtomicNum(),
                "formal_charge": atom.GetFormalCharge(),
                "isotope": atom.GetIsotope() or None,
                "implicit_hydrogens": atom.GetTotalNumHs(includeNeighbors=False),
                "total_hydrogens": atom.GetTotalNumHs(includeNeighbors=True),
                "radical_electrons": atom.GetNumRadicalElectrons(),
                "aromatic": atom.GetIsAromatic(),
                "in_ring": atom.IsInRing(),
                "hybridization": str(atom.GetHybridization()),
                "cip_label": atom.GetProp("_CIPCode") if atom.HasProp("_CIPCode") else None,
            }
        )
    return atoms


def identity(mol: Chem.Mol) -> dict[str, Any]:
    """Identifiers and whole-molecule properties of a sanitised molecule."""
    inchi_text, inchikey, inchi_notes = inchi_for(mol)
    return {
        "canonical_smiles": canonical_smiles(mol),
        "inchi": inchi_text,
        "inchikey": inchikey,
        "inchi_messages": inchi_notes,
        "molecular_formula": rdMolDescriptors.CalcMolFormula(mol),
        "molecular_weight_g_per_mol": float(Descriptors.MolWt(mol)),
        "monoisotopic_mass_u": float(Descriptors.ExactMolWt(mol)),
        "formal_charge": int(Chem.GetFormalCharge(mol)),
        "radical_electrons": int(Descriptors.NumRadicalElectrons(mol)),
        "heavy_atom_count": int(mol.GetNumHeavyAtoms()),
        "fragment_count": len(Chem.GetMolFrags(mol)),
    }


def validation_report(parsed: ParsedStructure) -> dict[str, Any]:
    """The full validation document served by POST /v1/chem/validate."""
    report: dict[str, Any] = {
        "valid": parsed.valid,
        "input_format": parsed.input_format,
        "stage": parsed.stage,
        "sanitization": {
            "status": "ok" if parsed.valid else ("not-run" if parsed.stage == "parse" else "failed"),
            "failed_operation": parsed.failed_operation,
            "hydrogen_model": "implicit" if parsed.implicit_hydrogens else "explicit-only",
        },
        "errors": [p.as_dict() for p in parsed.errors],
        "warnings": list(parsed.warnings),
        "engine": derived_by(),
        "evidence": "computed",
        "structure": None,
    }
    if not parsed.valid or parsed.mol is None:
        return report

    mol = parsed.mol
    ident = identity(mol)
    stereo = _stereo(mol)
    atoms = _atoms(mol)
    warnings = report["warnings"]
    warnings.extend(m for m in ident.pop("inchi_messages") if m not in warnings)
    if stereo["unspecified_count"]:
        warnings.append(
            f"{stereo['unspecified_count']} stereo element(s) are unspecified; identifiers describe the structure without that stereochemistry."
        )
    implied = sum(a["implicit_hydrogens"] for a in atoms)
    report["structure"] = {
        **ident,
        "atom_count": mol.GetNumAtoms(),
        "bond_count": mol.GetNumBonds(),
        "implicit_hydrogen_count": implied,
        "has_3d_coordinates": has_usable_3d(mol),
        "atoms": atoms,
        "stereo": stereo,
        "rings": _rings(mol),
    }
    return report
