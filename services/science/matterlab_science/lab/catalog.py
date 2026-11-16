"""Read release artifacts generated from the browser's apparatus and science registries."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

from .problems import LabProblem
from .validation import canonical_bytes, decode_json

FILES = {
    "equipment": ("equipment-definitions.json", "equipment"),
    "reagents": ("reagent-definitions.json", "reagents"),
    "sources": ("source-references.json", "sources"),
}


def read_catalog(directory: Path, kind: str) -> list[dict[str, Any]]:
    filename, field = FILES[kind]
    path = directory / filename
    try:
        if path.stat().st_size > 8 * 1024 * 1024:
            raise ValueError("release artifact exceeds limit")
        document = decode_json(path.read_bytes())
        records = document[field]
        if document["schemaVersion"] != 1 or not isinstance(records, list) or len(records) > 2000:
            raise ValueError("incompatible release artifact")
        ids = [record["id"] for record in records]
        if len(set(ids)) != len(ids) or any(not isinstance(identifier, str) or not identifier for identifier in ids):
            raise ValueError("invalid catalog IDs")
        return records
    except (OSError, KeyError, TypeError, ValueError, LabProblem) as exc:
        raise LabProblem(503, "CATALOG_UNAVAILABLE", f"The shared {kind} catalogue release is unavailable. Build its authoritative TypeScript package.") from exc


def source_ids(value: Any) -> set[str]:
    result: set[str] = set()
    if isinstance(value, dict):
        for key, item in value.items():
            if key == "sourceIds" and isinstance(item, list):
                result.update(entry for entry in item if isinstance(entry, str))
            elif key == "sourceId" and isinstance(item, str):
                result.add(item)
            else:
                result.update(source_ids(item))
    elif isinstance(value, list):
        for item in value:
            result.update(source_ids(item))
    return result


def snapshot_for_scene(scene: dict[str, Any], directory: Path) -> dict[str, Any]:
    snapshot: dict[str, Any] = {"schemaVersion": 1, "catalogStatus": "CURATED", "equipment": [], "reagents": [], "sources": [], "warnings": []}
    definitions = {instance["definitionId"] for instance in scene["apparatus"]}
    used_species = {item["speciesId"] for contents in scene["containerStates"].values() for item in contents["species"]}
    for kind in ("equipment", "reagents", "sources"):
        try:
            records = read_catalog(directory, kind)
        except LabProblem as exc:
            snapshot["warnings"].append(exc.detail)
            continue
        if kind == "equipment":
            records = [record for record in records if record["id"] in definitions]
        elif kind == "reagents":
            records = [record for record in records if any(component["speciesId"] in used_species for component in record.get("components", []))]
        else:
            relevant = source_ids(scene) | source_ids(snapshot)
            records = [record for record in records if record["id"] in relevant]
        snapshot[kind] = records
    known = {record["id"] for record in snapshot["equipment"]}
    for identifier in sorted(definitions - known):
        snapshot["warnings"].append(f"Equipment definition {identifier} is not present in this release; no calibration was invented.")
    return snapshot


def retain_pinned_catalog(previous: dict[str, Any], current: dict[str, Any]) -> dict[str, Any]:
    """A scene edit must not silently replace the calibration/source release it already saved."""
    result = {**current}
    for kind in ("equipment", "reagents", "sources"):
        indexed = {record["id"]: record for record in current.get(kind, [])}
        indexed.update({record["id"]: record for record in previous.get(kind, [])})
        result[kind] = list(indexed.values())
    return result


def require_installed_calibrations(snapshot: dict[str, Any], directory: Path) -> None:
    pinned = snapshot.get("equipment", [])
    if not pinned:
        return
    current = {record["id"]: record for record in read_catalog(directory, "equipment")}
    for record in pinned:
        if record["id"] not in current or canonical_bytes(record) != canonical_bytes(current[record["id"]]):
            raise LabProblem(409, "CATALOG_VERSION_UNAVAILABLE", "The saved apparatus release differs from the installed runtime catalogue. Re-author a fresh draft or restore the matching release; no calibration was silently changed.")


def catalogue_links(reagent: dict[str, Any]) -> dict[str, Any]:
    formula = reagent.get("formula")
    if not isinstance(formula, str):
        return {"elements": [], "compoundSearch": None, "relationship": "No verified structural identifier supplied"}
    elements = sorted(set(re.findall(r"[A-Z][a-z]?", formula)))
    return {
        "elements": [f"/v1/elements/{symbol}" for symbol in elements],
        "compoundSearch": "/v1/compounds?" + urlencode({"formula": formula}),
        "relationship": "Related analytical formula only; matching formula is not proof of identical structure or phase.",
    }
