"""Validate against Agent07's published schema, not a parallel Python scene model."""

from __future__ import annotations

import copy
import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
from functools import lru_cache
from pathlib import Path
from typing import Any
from uuid import uuid4

import rfc8785
from jsonschema import Draft202012Validator, FormatChecker, SchemaError

from ..config import _REPO_ROOT, load_settings
from .problems import LabProblem

_SEMANTIC_SLOTS = threading.BoundedSemaphore(2)

UNITS_POLICY = {
    "schemaVersion": 1,
    "position": "m",
    "volume": "L",
    "amount": "mol",
    "concentration": "mol/L",
    "temperature": "K",
    "time": "s",
    "geometryIsChemicalCalibration": False,
    "calibration": "Use each versioned apparatus definition's calibration; visual geometry is not experimental evidence.",
}


def canonical_bytes(value: Any) -> bytes:
    try:
        return rfc8785.dumps(value)
    except (rfc8785.CanonicalizationError, ValueError, TypeError, RecursionError) as exc:
        raise LabProblem(422, "INVALID_JSON_VALUE", "Only finite, interoperable JSON values and valid Unicode are accepted.") from exc


def request_hash(value: Any) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def run_input_hash(request: dict[str, Any]) -> str:
    return request_hash({key: value for key, value in request.items() if key != "runId"})


def decode_json(content: str | bytes) -> Any:
    def pairs(items: list[tuple[str, Any]]) -> dict[str, Any]:
        record: dict[str, Any] = {}
        for key, value in items:
            if key in record or key in ("__proto__", "prototype", "constructor"):
                raise ValueError("duplicate or unsafe object key")
            record[key] = value
        return record

    def constant(_: str) -> None:
        raise ValueError("nonfinite JSON number")

    try:
        value = json.loads(content, object_pairs_hook=pairs, parse_constant=constant)
        canonical_bytes(value)
        return value
    except (ValueError, TypeError, RecursionError, UnicodeError) as exc:
        raise LabProblem(422, "INVALID_JSON", "JSON must have unique safe keys, valid Unicode, bounded nesting and finite numbers.") from exc


@lru_cache(maxsize=8)
def _schema(path: str, stamp: int) -> dict[str, Any]:
    document = json.loads(Path(path).read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(document)
    return document


def validate_contract(value: Any, definition: str, schema_path: Path, validator_path: Path | None = None, node_binary: str = "node", timeout_seconds: float | None = None) -> None:
    encoded = canonical_bytes(value)
    try:
        document = _schema(str(schema_path), schema_path.stat().st_mtime_ns)
        if definition not in ("LearningState", "EditorState") and definition not in document["$defs"]:
            raise KeyError(definition)
        validator = Draft202012Validator(
            document if definition in ("LearningState", "EditorState") else
            {"$schema": "https://json-schema.org/draft/2020-12/schema", "$defs": document["$defs"], "$ref": f"#/$defs/{definition}"},
            format_checker=FormatChecker(),
        )
    except (OSError, ValueError, KeyError, SchemaError) as exc:
        raise LabProblem(503, "CONTRACT_UNAVAILABLE", "The shared laboratory contract schema is unavailable or incompatible.") from exc
    # The shared Node parser validates BOTH structure and semantics for every payload. Repeating
    # generic oneOf traversal on a large observation ledger can block the API for minutes.
    if len(encoded) <= 64 * 1024:
        errors = []
        for error in validator.iter_errors(value):
            errors.append({"path": "/".join(str(part) for part in error.absolute_path), "rule": error.validator, "message": error.message[:500]})
            if len(errors) == 20:
                break
        if errors:
            raise LabProblem(422, "CONTRACT_VALIDATION_FAILED", f"The request does not match the shared {definition} contract.", errors)
    validator_path = validator_path or _REPO_ROOT / "services" / "science" / "node" / "dist" / "validate.mjs"
    executable = shutil.which(node_binary)
    if executable is None or not validator_path.is_file():
        raise LabProblem(503, "CONTRACT_VALIDATOR_UNAVAILABLE", "Build and install the shared TypeScript semantic validator before saving laboratory data.")
    environment = {key: item for key, item in os.environ.items() if key.upper() in {"PATH", "SYSTEMROOT", "WINDIR", "HOME", "LANG", "LC_ALL"}}
    if not _SEMANTIC_SLOTS.acquire(timeout=0.05):
        raise LabProblem(429, "VALIDATION_BUSY", "The bounded shared-contract validators are busy. Retry shortly.")
    try:
        result = subprocess.run(
            [executable, "--max-old-space-size=128", "--disable-proto=throw", "--permission", f"--allow-fs-read={validator_path.resolve().parent}", str(validator_path.resolve())],
            input=canonical_bytes({"contract": definition, "value": value}), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=timeout_seconds if timeout_seconds is not None else load_settings().lab_validation_timeout_seconds,
            check=False, env=environment, shell=False,
        )
        if result.returncode != 0 or len(result.stdout) > 1024 * 1024:
            raise ValueError("validator failed")
        report = decode_json(result.stdout)
        if not report["ok"]:
            raise LabProblem(422, "CONTRACT_VALIDATION_FAILED", f"Shared {definition} semantic validation failed.", report["errors"])
    except (OSError, subprocess.TimeoutExpired, ValueError, KeyError, TypeError) as exc:
        raise LabProblem(503, "CONTRACT_VALIDATOR_UNAVAILABLE", "Shared semantic validation could not complete; the scene was not saved.") from exc
    finally:
        _SEMANTIC_SLOTS.release()


def validate_scene(scene: dict[str, Any], schema_path: Path, validator_path: Path | None = None, node_binary: str = "node", timeout_seconds: float | None = None) -> None:
    validate_contract(scene, "ExperimentScene", schema_path, validator_path, node_binary, timeout_seconds)


def validate_learning_state(value: dict[str, Any] | None, settings: Any) -> None:
    if value is None:
        return
    if len(canonical_bytes(value)) > 4 * 1024 * 1024:
        raise LabProblem(413, "LEARNING_STATE_TOO_LARGE", "Learning metadata exceeds 4 MiB; no evidence was silently truncated.")
    validate_contract(value, "LearningState", settings.lab_learning_schema_path, settings.lab_validator_path,
                      settings.lab_node_binary, settings.lab_validation_timeout_seconds)


def validate_editor_state(value: dict[str, Any] | None, scene_id: str, settings: Any) -> None:
    if value is None:
        return
    if len(canonical_bytes(value)) > 262_144:
        raise LabProblem(413, "EDITOR_STATE_TOO_LARGE", "Editor metadata exceeds 256 KiB.")
    if value.get("sceneId") != scene_id:
        raise LabProblem(422, "EDITOR_SCENE_MISMATCH", "Editor metadata must belong to this scene.")
    validate_contract(value, "EditorState", settings.lab_editor_schema_path, settings.lab_validator_path,
                      settings.lab_node_binary, settings.lab_validation_timeout_seconds)


def remap_identifiers(value: Any, ids: dict[str, str]) -> Any:
    if isinstance(value, str):
        return ids.get(value, value)
    if isinstance(value, dict):
        return {ids.get(key, key): remap_identifiers(item, ids) for key, item in value.items()}
    if isinstance(value, list):
        return [remap_identifiers(item, ids) for item in value]
    return value


def scene_identifiers(scene: dict[str, Any]) -> list[str]:
    return [scene["id"], *(s["id"] for s in scene["stations"]), *(a["id"] for a in scene["apparatus"]), *(c["id"] for c in scene["connections"])]


def duplicated_scene(scene: dict[str, Any]) -> dict[str, Any]:
    ids = {identifier: str(uuid4()) for identifier in scene_identifiers(scene)}
    result = remap_identifiers(copy.deepcopy(scene), ids)
    result["revision"] = 1
    return result


def validate_checkpoint(checkpoint: dict[str, Any] | None, scene: dict[str, Any], schema_path: Path, validator_path: Path | None = None, node_binary: str = "node", timeout_seconds: float | None = None) -> None:
    if checkpoint is None:
        return
    validate_contract(checkpoint, "RuntimeCheckpoint", schema_path, validator_path, node_binary, timeout_seconds)
    current = checkpoint["snapshot"]["scene"]
    if checkpoint["initialScene"]["id"] != scene["id"] or {key: value for key, value in current.items() if key != "revision"} != {
        key: value for key, value in scene.items() if key != "revision"
    }:
        raise LabProblem(422, "CHECKPOINT_SCENE_MISMATCH", "The checkpoint must describe exactly the submitted current scene (apart from its durable revision).")


def parse_etag(value: str | None) -> int:
    if value is None:
        raise LabProblem(428, "REVISION_REQUIRED", "If-Match must contain the revision returned by the last remote save.")
    if not re.fullmatch(r'"[1-9][0-9]{0,9}"', value):
        raise LabProblem(400, "INVALID_REVISION", 'If-Match must be one strong ETag, for example "1"; wildcards are not allowed.')
    return int(value[1:-1])


def idempotency_key(value: str | None) -> str:
    if value is None:
        raise LabProblem(400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key is required for creates and run submissions.")
    if not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", value):
        raise LabProblem(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must contain 1–128 letters, digits, dots, underscores, colons or hyphens.")
    return value
