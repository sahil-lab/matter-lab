"""Small transactional primitives; every resource lookup includes the authenticated owner."""

from __future__ import annotations

from typing import Any
from uuid import UUID

import psycopg
from fastapi.encoders import jsonable_encoder

from ..db import Jsonb
from .problems import LabProblem

TERMINAL_STATUSES = frozenset({"SUCCEEDED", "FAILED", "CANCELLED", "UNSUPPORTED"})


def lock_owner(conn: psycopg.Connection[Any], owner_id: UUID) -> None:
    conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", (f"lab:owner:{owner_id}",))


def scene_row(conn: psycopg.Connection[Any], scene_id: UUID, owner_id: UUID, *, lock: bool = False) -> dict[str, Any]:
    row = conn.execute(
        "SELECT * FROM lab_scene WHERE id = %s AND owner_id = %s" + (" FOR UPDATE" if lock else ""),
        (scene_id, owner_id),
    ).fetchone()
    if row is None:
        raise LabProblem(404, "SCENE_NOT_FOUND", "The laboratory scene was not found.")
    return row


def run_row(conn: psycopg.Connection[Any], run_id: UUID, owner_id: UUID, *, lock: bool = False) -> dict[str, Any]:
    row = conn.execute(
        "SELECT * FROM lab_run WHERE id = %s AND owner_id = %s" + (" FOR UPDATE" if lock else ""),
        (run_id, owner_id),
    ).fetchone()
    if row is None:
        raise LabProblem(404, "RUN_NOT_FOUND", "The laboratory run was not found.")
    return row


def scene_resource(row: dict[str, Any]) -> dict[str, Any]:
    return jsonable_encoder({
        "scene": row["scene"],
        "runtimeCheckpoint": row["runtime_checkpoint"],
        "title": row["title"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    })


def run_resource(row: dict[str, Any]) -> dict[str, Any]:
    return jsonable_encoder({
        "runId": row["id"],
        "sceneId": row["scene_id"],
        "sceneRevision": row["scene_revision"],
        "status": row["status"],
        "inputHash": row["input_hash"],
        "inputSnapshot": row["input_snapshot"],
        "runtimeCheckpoint": row["checkpoint"],
        "result": row["result"],
        "failureCode": row["failure_code"],
        "cancelRequested": row["cancel_requested"],
        "createdAt": row["created_at"],
        "startedAt": row["started_at"],
        "completedAt": row["completed_at"],
        "unitsPolicy": row["units_policy"],
        "catalogSnapshot": row["catalog_snapshot"],
        "runnerSha256": row["runner_sha256"],
        "artifacts": row["artifacts"],
    })


def revision_matches(row: dict[str, Any], expected: int) -> None:
    if row["revision"] != expected:
        raise LabProblem(409, "REVISION_CONFLICT", "The scene changed after it was loaded. Reopen or duplicate your draft; it was not overwritten.",
                         {"expectedRevision": expected, "currentRevision": row["revision"]})


def recall(conn: psycopg.Connection[Any], owner_id: UUID, route: str, key: str, digest: str) -> dict[str, Any] | None:
    conn.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", (f"lab:idempotency:{owner_id}:{route}:{key}",))
    row = conn.execute(
        "SELECT request_hash, status_code, response, etag FROM lab_idempotency WHERE owner_id = %s AND route = %s AND key = %s",
        (owner_id, route, key),
    ).fetchone()
    if row and row["request_hash"] != digest:
        raise LabProblem(409, "IDEMPOTENCY_CONFLICT", "This idempotency key was already used for a different request.")
    return row


def remember(
    conn: psycopg.Connection[Any], owner_id: UUID, route: str, key: str, digest: str,
    response: dict[str, Any], status: int, etag: str | None = None,
) -> None:
    conn.execute(
        "INSERT INTO lab_idempotency(owner_id, route, key, request_hash, status_code, response, etag) VALUES (%s,%s,%s,%s,%s,%s,%s)",
        (owner_id, route, key, digest, status, Jsonb(jsonable_encoder(response)), etag),
    )


def append_event(conn: psycopg.Connection[Any], run_id: UUID, event_type: str, data: dict[str, Any]) -> None:
    # The caller holds the run row lock, including when the final event is appended before its terminal update.
    conn.execute(
        "INSERT INTO lab_run_event(run_id, sequence, event_type, data) "
        "SELECT %s, coalesce(max(sequence), 0) + 1, %s, %s FROM lab_run_event WHERE run_id = %s",
        (run_id, event_type, Jsonb(jsonable_encoder(data)), run_id),
    )
