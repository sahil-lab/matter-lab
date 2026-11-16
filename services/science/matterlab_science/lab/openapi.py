"""Expose the same shared scene/runtime schemas in this service's existing OpenAPI document."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import FastAPI


def install_lab_openapi(app: FastAPI, path: Path, learning_path: Path | None = None) -> None:
    original = app.openapi

    def rewrite(value: Any) -> Any:
        if isinstance(value, list):
            return [rewrite(item) for item in value]
        if isinstance(value, dict):
            if "x-matterlab-shared-schema" in value:
                return {"$ref": "#/components/schemas/Lab" + value["x-matterlab-shared-schema"],
                        **{key: item for key, item in value.items() if key in ("description", "title")}}
            return {key: (item.replace("#/$defs/", "#/components/schemas/Lab") if key == "$ref" and isinstance(item, str) else rewrite(item))
                    for key, item in value.items()}
        return value

    def openapi() -> dict[str, Any]:
        document = original()
        schemas = document.setdefault("components", {}).setdefault("schemas", {})
        if path.is_file():
            contract = json.loads(path.read_text(encoding="utf-8"))
            for name, definition in contract["$defs"].items():
                schemas["Lab" + name] = rewrite(definition)
        else:
            for name in ("ExperimentScene", "RuntimeCheckpoint", "NodeRunRequest", "RunResult"):
                schemas["Lab" + name] = {"type": "object", "description": "Shared contract artifact is not installed; lab validation endpoints return CONTRACT_UNAVAILABLE."}
        if learning_path is not None and learning_path.is_file():
            learning = json.loads(learning_path.read_text(encoding="utf-8"))
            for name, definition in learning["$defs"].items():
                schemas.setdefault("Lab" + name, rewrite(definition))
            schemas["LabLearningState"] = rewrite({key: value for key, value in learning.items() if key not in ("$defs", "$schema", "$id")})
        else:
            schemas["LabLearningState"] = {"type": "object", "description": "Agent08 client-draft schema is not installed; nonnull learning-state writes fail closed."}
        return rewrite(document)

    app.openapi = openapi
