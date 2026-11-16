"""Functional-group definitions shipped with RDKit, and detection of groups in a molecule.

The definitions are read from RDKit's own data directory (RDConfig.RDDataDir); nothing here is
typed in by hand. Three sets are available:

  rdkit-fragment-descriptors        FragmentDescriptors.csv, the patterns behind the fr_* descriptors
  rdkit-functional-group-hierarchy  Functional_Group_Hierarchy.txt, a parent/child hierarchy
  rdkit-functional-groups           FunctionalGroups.txt, substituent patterns whose first SMARTS
                                    atom is the attachment point and not part of the group
"""

from __future__ import annotations

import csv
import hashlib
import threading
from pathlib import Path
from typing import Any

from rdkit import Chem, RDConfig
from rdkit.Chem import FunctionalGroups

SET_FRAGMENTS = "rdkit-fragment-descriptors"
SET_HIERARCHY = "rdkit-functional-group-hierarchy"
SET_SUBSTITUENTS = "rdkit-functional-groups"

SET_INFO: dict[str, dict[str, Any]] = {
    SET_FRAGMENTS: {
        "title": "RDKit fragment descriptor patterns",
        "source_file": "FragmentDescriptors.csv",
        "first_atom_is_attachment_point": False,
    },
    SET_HIERARCHY: {
        "title": "RDKit functional group hierarchy",
        "source_file": "Functional_Group_Hierarchy.txt",
        "first_atom_is_attachment_point": False,
    },
    SET_SUBSTITUENTS: {
        "title": "RDKit substituent functional groups",
        "source_file": "FunctionalGroups.txt",
        "first_atom_is_attachment_point": True,
    },
}

_MAX_MATCHES = 2000
_INPUT_INDEX = "_matterlab_input_index"


def data_file(name: str) -> Path:
    return Path(RDConfig.RDDataDir) / name


def _read(name: str) -> str:
    return data_file(name).read_text(encoding="utf-8", errors="replace")


def _fragment_descriptors() -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    section: str | None = None
    after_rule = False
    for line in _read("FragmentDescriptors.csv").splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("#"):
            # Section titles are comment lines framed by lines made only of '#'.
            if set(stripped) == {"#"}:
                after_rule = True
            else:
                if after_rule:
                    section = stripped.lstrip("#").strip() or section
                after_rule = False
            continue
        after_rule = False
        row = next(csv.reader([line], delimiter="\t", quotechar='"'))
        if len(row) < 3 or not row[2].strip():
            continue
        code, description, smarts = row[0].strip(), row[1].strip(), row[2].strip()
        notes = row[4].strip() if len(row) > 4 else ""
        name = description[len("Number of ") :] if description.startswith("Number of ") else description
        text = description if not notes else f"{description}. Notes: {notes}"
        if section:
            text = f"{text} [section: {section}]"
        records.append(
            {
                "group_set": SET_FRAGMENTS,
                "key": code,
                "name": name,
                "smarts": smarts,
                "description": text,
                "parent_key": None,
            }
        )
    return records


def _hierarchy() -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []

    def walk(nodes: list[Any], parent: Any | None, parent_name: str | None) -> None:
        for node in nodes:
            name = node.name.strip()
            full_name = f"{parent_name}: {name}" if parent_name else name
            description = None
            if getattr(node, "rxnSmarts", None):
                description = f"Removal reaction defined by RDKit: {node.rxnSmarts}"
            records.append(
                {
                    "group_set": SET_HIERARCHY,
                    "key": node.label.strip(),
                    "name": full_name,
                    "smarts": node.smarts.strip(),
                    "description": description,
                    "parent_key": parent.label.strip() if parent is not None else None,
                }
            )
            walk(list(node.children), node, full_name)

    walk(list(FunctionalGroups.BuildFuncGroupHierarchy(data=_read("Functional_Group_Hierarchy.txt"), force=True)), None, None)
    return records


def _substituents() -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for line in _read("FunctionalGroups.txt").splitlines():
        if not line.strip() or line.lstrip().startswith("//"):
            continue
        parts = [part.strip() for part in line.split("\t") if part.strip()]
        if len(parts) < 2:
            continue
        label, smarts = parts[0], parts[1]
        notes = parts[2] if len(parts) > 2 else ""
        records.append(
            {
                "group_set": SET_SUBSTITUENTS,
                "key": label,
                "name": notes if notes and notes != "???" else label,
                "smarts": smarts,
                "description": "Substituent pattern: the first SMARTS atom is the attachment point and is not part of the group.",
                "parent_key": None,
            }
        )
    return records


def rdkit_definitions() -> tuple[list[dict[str, Any]], list[dict[str, Any]], str]:
    """(usable definitions, rejected definitions with reasons, SHA-256 over the three source files)."""
    digest = hashlib.sha256()
    for info in SET_INFO.values():
        digest.update(data_file(info["source_file"]).read_bytes())
    usable: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for record in _fragment_descriptors() + _hierarchy() + _substituents():
        identity = (record["group_set"], record["key"])
        if identity in seen:
            rejected.append({**record, "reason": "duplicate key within its set"})
            continue
        if Chem.MolFromSmarts(record["smarts"]) is None:
            rejected.append({**record, "reason": "RDKit could not parse the SMARTS"})
            continue
        seen.add(identity)
        record["source_file"] = SET_INFO[record["group_set"]]["source_file"]
        record["position"] = sum(1 for r in usable if r["group_set"] == record["group_set"])
        usable.append(record)
    return usable, rejected, digest.hexdigest()


_pattern_cache: dict[str, Chem.Mol | None] = {}
_pattern_lock = threading.Lock()


def compile_smarts(smarts: str) -> Chem.Mol | None:
    with _pattern_lock:
        if smarts not in _pattern_cache:
            if len(_pattern_cache) > 5000:
                _pattern_cache.clear()
            _pattern_cache[smarts] = Chem.MolFromSmarts(smarts)
        return _pattern_cache[smarts]


def heavy_atom_view(mol: Chem.Mol) -> tuple[Chem.Mol, list[int]]:
    """Hydrogen-suppressed copy for pattern matching, with the map back to input atom indices.

    SMARTS primitives such as D (degree) count explicit neighbours, so patterns are matched on the
    hydrogen-suppressed graph they were written for; reported indices are those of the input.
    """
    tagged = Chem.Mol(mol)
    for atom in tagged.GetAtoms():
        atom.SetIntProp(_INPUT_INDEX, atom.GetIdx())
    try:
        view = Chem.RemoveHs(tagged)
    except Exception:
        view = tagged
    return view, [atom.GetIntProp(_INPUT_INDEX) for atom in view.GetAtoms()]


def detect(mol: Chem.Mol, definitions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Definitions that match, each with every match as input atom indices."""
    view, index_map = heavy_atom_view(mol)
    found: list[dict[str, Any]] = []
    for definition in definitions:
        query = compile_smarts(definition["smarts"])
        if query is None:
            continue
        raw_matches = view.GetSubstructMatches(query, uniquify=True, maxMatches=_MAX_MATCHES)
        if not raw_matches:
            continue
        attachment = bool(SET_INFO.get(definition["group_set"], {}).get("first_atom_is_attachment_point", False))
        matches = []
        for match in raw_matches:
            atoms = [index_map[i] for i in match]
            matches.append(
                {
                    "atom_indices": atoms[1:] if attachment else atoms,
                    "attachment_atom_index": atoms[0] if attachment else None,
                }
            )
        found.append({**definition, "match_count": len(matches), "matches": matches})
    return found
