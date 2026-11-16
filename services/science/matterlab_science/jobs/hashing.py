"""Deterministic identity of a job request.

input_hash = SHA-256 over the canonical JSON of {"kind", "input", "settings"}, where input and
settings are the validated documents with every default filled in. Canonical JSON means: keys
sorted, no insignificant whitespace, UTF-8, shortest round-trip float notation, and -0.0 written
as 0.0. Two requests that mean the same calculation therefore hash identically regardless of key
order or of which defaults were spelled out. The execution limit (timeout) is not part of the hash.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any


def _normalise(value: Any) -> Any:
    if isinstance(value, bool) or value is None or isinstance(value, (int, str)):
        return value
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            raise ValueError("non-finite numbers cannot be part of a job request")
        return 0.0 if value == 0 else value
    if isinstance(value, dict):
        return {str(key): _normalise(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_normalise(item) for item in value]
    raise TypeError(f"value of type {type(value).__name__} cannot be part of a job request")


def canonical_json(document: Any) -> str:
    return json.dumps(_normalise(document), sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def input_hash(kind: str, job_input: dict[str, Any], settings: dict[str, Any]) -> str:
    canonical = canonical_json({"kind": kind, "input": job_input, "settings": settings})
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
