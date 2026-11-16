"""HTTP metadata envelopes around canonical Agent07 JSON-schema definitions."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

RunStatus = Literal["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "UNSUPPORTED"]


def shared_ref(name: str) -> dict[str, str]:
    return {"x-matterlab-shared-schema": name}


class StrictBody(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class SceneCreate(StrictBody):
    title: str = Field(min_length=1, max_length=300)
    scene: dict[str, Any] = Field(json_schema_extra=shared_ref("ExperimentScene"))
    runtimeCheckpoint: dict[str, Any] | None = Field(default=None, json_schema_extra={"anyOf": [shared_ref("RuntimeCheckpoint"), {"type": "null"}]})
    learningState: dict[str, Any] | None = Field(default=None, json_schema_extra={"anyOf": [shared_ref("LearningState"), {"type": "null"}]})


class ScenePatch(StrictBody):
    title: str | None = Field(default=None, min_length=1, max_length=300)
    scene: dict[str, Any] | None = Field(default=None, json_schema_extra={"anyOf": [shared_ref("ExperimentScene"), {"type": "null"}]})
    runtimeCheckpoint: dict[str, Any] | None = Field(default=None, json_schema_extra={"anyOf": [shared_ref("RuntimeCheckpoint"), {"type": "null"}]})
    learningState: dict[str, Any] | None = Field(default=None, json_schema_extra={"anyOf": [shared_ref("LearningState"), {"type": "null"}]})


class SceneResource(BaseModel):
    scene: dict[str, Any] = Field(json_schema_extra=shared_ref("ExperimentScene"))
    runtimeCheckpoint: dict[str, Any] | None = Field(json_schema_extra={"anyOf": [shared_ref("RuntimeCheckpoint"), {"type": "null"}]})
    title: str
    createdAt: datetime
    updatedAt: datetime
    learningState: dict[str, Any] | None = Field(default=None, json_schema_extra={"anyOf": [shared_ref("LearningState"), {"type": "null"}]})


class SceneSummary(BaseModel):
    id: UUID
    title: str
    revision: int
    updatedAt: datetime


class DuplicateRequest(StrictBody):
    title: str | None = Field(default=None, min_length=1, max_length=300)


class RunCreate(StrictBody):
    expectedRevision: int = Field(ge=1, description="Durable saved scene revision; NOT LabAction.expectedRevision (the local runtime revision).")
    steps: list[dict[str, Any]] = Field(default_factory=list, max_length=10000, description="Only NEW steps, appended after a saved checkpoint. Omit to replay saved work.")
    limits: dict[str, Any] | None = None


class RunResource(BaseModel):
    runId: UUID
    sceneId: UUID
    sceneRevision: int
    status: RunStatus
    inputHash: str
    inputSnapshot: dict[str, Any] = Field(json_schema_extra=shared_ref("NodeRunRequest"))
    runtimeCheckpoint: dict[str, Any] | None = Field(json_schema_extra={"anyOf": [shared_ref("RuntimeCheckpoint"), {"type": "null"}]})
    result: dict[str, Any] | None = Field(json_schema_extra={"anyOf": [shared_ref("RunResult"), {"type": "null"}]})
    failureCode: str | None
    cancelRequested: bool
    createdAt: datetime
    startedAt: datetime | None
    completedAt: datetime | None
    unitsPolicy: dict[str, Any]
    catalogSnapshot: dict[str, Any]
    runnerSha256: str | None
    artifacts: list[dict[str, Any]]
    learningState: dict[str, Any] | None = Field(default=None, description="Frozen CLIENT/DRAFT metadata, not a verified score or scientific result.",
                                               json_schema_extra={"anyOf": [shared_ref("LearningState"), {"type": "null"}]})


class RunSummary(BaseModel):
    runId: UUID
    sceneId: UUID
    sceneRevision: int
    status: RunStatus
    inputHash: str
    methodId: str
    methodVersion: str
    failureCode: str | None
    createdAt: datetime
    completedAt: datetime | None


class TemplateCreate(StrictBody):
    title: str = Field(min_length=1, max_length=300)
    sceneId: str
    expectedRevision: int = Field(ge=1)
    kind: Literal["SCENE", "ASSEMBLY"] = "SCENE"


class TemplateResource(BaseModel):
    id: UUID
    title: str
    kind: Literal["SCENE", "ASSEMBLY"]
    scene: dict[str, Any] = Field(json_schema_extra=shared_ref("ExperimentScene"))
    catalogSnapshot: dict[str, Any]
    createdAt: datetime
