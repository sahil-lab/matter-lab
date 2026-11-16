"""Expose the same shared scene/runtime schemas in this service's existing OpenAPI document."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from fastapi import FastAPI


def install_lab_openapi(app: FastAPI, path: Path, learning_path: Path | None = None, editor_path: Path | None = None) -> None:
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
        for name, metadata_path in (("LearningState", learning_path), ("EditorState", editor_path)):
            if metadata_path is not None and metadata_path.is_file():
                metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
                for definition_name, definition in metadata["$defs"].items():
                    schemas.setdefault("Lab" + definition_name, rewrite(definition))
                schemas["Lab" + name] = rewrite({key: value for key, value in metadata.items() if key not in ("$defs", "$schema", "$id")})
            else:
                schemas["Lab" + name] = {"type": "object", "description": "Shared metadata schema is not installed; nonnull metadata writes fail closed."}
        return rewrite(document)

    app.openapi = openapi
