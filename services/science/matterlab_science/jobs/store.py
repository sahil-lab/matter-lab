"""Persistence of jobs in the `calculations` table."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from uuid import UUID

import psycopg

from ..db import Jsonb
from ..provenance import PROVENANCE_COLUMNS

TERMINAL_STATUSES = ("succeeded", "failed", "cancelled", "unsupported")
MAX_MESSAGES = 200

_COLUMNS = (
    "c.id, c.kind, c.status, c.input, c.settings, c.input_hash, c.engine, c.engine_version, c.software, c.method, "
    "c.progress, c.messages, c.result, c.converged, c.error, c.timeout_seconds, c.cancel_requested, c.origin, "
    "c.worker_pid, c.created_at, c.started_at, c.finished_at, c.updated_at"
)
_SUMMARY_COLUMNS = (
    "c.id, c.kind, c.status, c.input_hash, c.engine, c.engine_version, c.method, c.progress, c.converged, c.error, "
    "c.cancel_requested, c.origin, c.created_at, c.started_at, c.finished_at, c.updated_at"
)


def message(text: str, level: str = "info") -> dict[str, str]:
    return {"time": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"), "level": level, "text": text}


def trim_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keeps the first message and the most recent ones, with a marker where older ones were dropped."""
    if len(messages) <= MAX_MESSAGES:
        return messages
    dropped = len(messages) - MAX_MESSAGES + 1
    marker = {"time": messages[1]["time"], "level": "info", "text": f"... {dropped} earlier message(s) omitted ..."}
    return [messages[0], marker, *messages[-(MAX_MESSAGES - 2) :]]


def insert_job(
    conn: psycopg.Connection[Any],
    *,
    kind: str,
    status: str,
    job_input: dict[str, Any],
    settings: dict[str, Any],
    input_hash: str,
    engine: str,
    engine_version: str | None,
    software: dict[str, str],
    timeout_seconds: float,
    source_id: int,
    messages: list[dict[str, Any]],
    error: dict[str, Any] | None = None,
) -> UUID:
    row = conn.execute(
        """
        INSERT INTO calculations (kind, status, input, settings, input_hash, engine, engine_version, software,
                                  timeout_seconds, source_id, messages, error, finished_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, CASE WHEN %s THEN now() END)
        RETURNING id
        """,
        (
            kind,
            status,
            Jsonb(job_input),
            Jsonb(settings),
            input_hash,
            engine,
            engine_version,
            Jsonb(software),
            timeout_seconds,
            source_id,
            Jsonb(messages),
            Jsonb(error) if error is not None else None,
            status in TERMINAL_STATUSES,
        ),
    ).fetchone()
    assert row is not None
    return row["id"]


def get_job(conn: psycopg.Connection[Any], job_id: UUID) -> dict[str, Any] | None:
    return conn.execute(
        f"SELECT {_COLUMNS}, {PROVENANCE_COLUMNS} FROM calculations c JOIN data_sources ds ON ds.id = c.source_id WHERE c.id = %s",
        (job_id,),
    ).fetchone()


def list_jobs(
    conn: psycopg.Connection[Any],
    *,
    status: str | None,
    kind: str | None,
    input_hash: str | None,
    limit: int,
    offset: int,
) -> tuple[list[dict[str, Any]], int]:
    clauses = []
    params: list[Any] = []
    for column, value in (("c.status", status), ("c.kind", kind), ("c.input_hash", input_hash)):
        if value is not None:
            clauses.append(f"{column} = %s")
            params.append(value)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    total = conn.execute(f"SELECT count(*) AS n FROM calculations c {where}", params).fetchone()
    rows = conn.execute(
        f"SELECT {_SUMMARY_COLUMNS} FROM calculations c {where} ORDER BY c.created_at DESC, c.id LIMIT %s OFFSET %s",
        [*params, limit, offset],
    ).fetchall()
    return rows, int(total["n"]) if total else 0


def request_cancel(conn: psycopg.Connection[Any], job_id: UUID) -> dict[str, Any] | None:
    """Cancels a queued job at once; flags a running job for the supervisor that owns its worker.

    Returns None when the job does not exist. Terminal jobs are returned unchanged.
    """
    row = conn.execute("SELECT status, messages FROM calculations WHERE id = %s FOR UPDATE", (job_id,)).fetchone()
    if row is None:
        return None
    if row["status"] == "queued":
        messages = trim_messages([*row["messages"], message("Cancelled on request before the job started.")])
        conn.execute(
            "UPDATE calculations SET status = 'cancelled', cancel_requested = true, finished_at = now(), messages = %s WHERE id = %s",
            (Jsonb(messages), job_id),
        )
    elif row["status"] == "running":
        # Only the supervisor that owns the worker writes messages of a running job; it will record
        # the cancellation when it terminates the process.
        conn.execute("UPDATE calculations SET cancel_requested = true WHERE id = %s", (job_id,))
    return get_job(conn, job_id)


def counts(conn: psycopg.Connection[Any]) -> dict[str, int]:
    row = conn.execute(
        "SELECT count(*) FILTER (WHERE status = 'queued') AS queued, count(*) FILTER (WHERE status = 'running') AS running FROM calculations"
    ).fetchone()
    return {"queued": int(row["queued"]), "running": int(row["running"])} if row else {"queued": 0, "running": 0}
