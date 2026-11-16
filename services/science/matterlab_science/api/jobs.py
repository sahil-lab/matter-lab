"""Asynchronous jobs: submit, inspect, list, cancel."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

from ..errors import error_responses, not_found
from ..jobs import store
from ..jobs.kinds import KINDS, JobRequest, canonical_request
from ..provenance import Provenance, provenance_from_row
from .common import Ctx, Page

router = APIRouter(prefix="/v1", tags=["jobs"])
# Routes that do not touch PostgreSQL (they are documented without the 503 response).
info_router = APIRouter(prefix="/v1", tags=["jobs"])

JobStatus = Literal["queued", "running", "succeeded", "failed", "cancelled", "unsupported"]


class JobMessage(BaseModel):
    time: datetime
    level: Literal["info", "warning", "error"]
    text: str


class JobError(BaseModel):
    code: str = Field(description="Machine-readable reason, e.g. `invalid_structure`, `scf_not_converged`, `timeout`, `worker_crashed`, `engine_unavailable`.")
    message: str
    details: dict[str, Any] | None = None


class JobEngine(BaseModel):
    id: str = Field(examples=["rdkit"])
    version: str | None = Field(description="Engine version detected when the job was accepted; null when the engine is not installed.")


class JobSummary(BaseModel):
    id: UUID
    kind: str
    status: JobStatus
    progress: float = Field(ge=0, le=1, description="Fraction completed.")
    input_hash: str = Field(description="SHA-256 of the canonical JSON of {kind, input, settings}.")
    engine: JobEngine
    method: str | None = Field(description="Method actually used, reported by the worker (e.g. MMFF94, GFN2-xTB, RKS/b3lyp/6-31g*).")
    converged: bool | None = Field(description="Convergence reported by the engine; null until a result exists.")
    error: JobError | None = Field(description="Set for `failed` and `unsupported` jobs.")
    cancel_requested: bool
    origin: Literal["service", "import"] = Field(description="`import`: the record came from a workbook and was not executed by this service.")
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    updated_at: datetime
    duration_seconds: float | None = Field(description="Run time from start to finish (or to now, while running).")


class Job(JobSummary):
    input: dict[str, Any] = Field(description="Validated input with defaults applied.")
    settings: dict[str, Any] = Field(description="Validated settings with defaults applied.")
    timeout_seconds: float
    software: dict[str, str] = Field(description="Versions of the libraries involved, as reported by the worker.")
    messages: list[JobMessage]
    result: dict[str, Any] | None = Field(
        description="Result document, present only when status is `succeeded`. Its schema depends on the kind; see GET /v1/job-kinds."
    )
    worker_pid: int | None = Field(description="Operating-system process id of the worker that ran the job.")
    provenance: Provenance


class JobKindInfo(BaseModel):
    kind: str
    title: str
    description: str
    engine: str
    available: bool = Field(description="False when the engine is not installed or disabled; such jobs end as `unsupported`.")
    unavailable_reasons: list[str]
    input_schema: dict[str, Any] = Field(description="JSON Schema of `input`.")
    settings_schema: dict[str, Any] = Field(description="JSON Schema of `settings`.")
    result_schema: dict[str, Any] = Field(description="JSON Schema of the `result` document of a succeeded job.")


class JobKindsResponse(BaseModel):
    kinds: list[JobKindInfo]


def _duration(row: dict[str, Any]) -> float | None:
    if row["started_at"] is None:
        return None
    end = row["finished_at"] or datetime.now(row["started_at"].tzinfo)
    return round((end - row["started_at"]).total_seconds(), 3)


def _summary_fields(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": row["id"],
        "kind": row["kind"],
        "status": row["status"],
        "progress": row["progress"],
        "input_hash": row["input_hash"],
        "engine": JobEngine(id=row["engine"], version=row["engine_version"]),
        "method": row["method"],
        "converged": row["converged"],
        "error": JobError(**row["error"]) if row["error"] else None,
        "cancel_requested": row["cancel_requested"],
        "origin": row["origin"],
        "created_at": row["created_at"],
        "started_at": row["started_at"],
        "finished_at": row["finished_at"],
        "updated_at": row["updated_at"],
        "duration_seconds": _duration(row),
    }


def job_from_row(row: dict[str, Any]) -> Job:
    return Job(
        **_summary_fields(row),
        input=row["input"],
        settings=row["settings"],
        timeout_seconds=row["timeout_seconds"],
        software=row["software"],
        messages=[JobMessage(**m) for m in row["messages"]],
        result=row["result"],
        worker_pid=row["worker_pid"],
        provenance=provenance_from_row(row),
    )


@info_router.get("/job-kinds", response_model=JobKindsResponse, summary="Job kinds and their input, settings and result schemas")
def job_kinds(ctx: Ctx) -> JobKindsResponse:
    kinds = []
    for kind in KINDS.values():
        available, reasons = ctx.jobs.availability(kind)
        kinds.append(
            JobKindInfo(
                kind=kind.name,
                title=kind.title,
                description=kind.description,
                engine=kind.engine,
                available=available,
                unavailable_reasons=reasons,
                input_schema=kind.input_model.model_json_schema(),
                settings_schema=kind.settings_model.model_json_schema(),
                result_schema=kind.result_model.model_json_schema(),
            )
        )
    return JobKindsResponse(kinds=kinds)


@router.post(
    "/jobs",
    response_model=Job,
    status_code=202,
    responses=error_responses(422),
    summary="Submit a job",
)
def submit_job(request: JobRequest, ctx: Ctx) -> Job:
    """Accepts a calculation and returns at once. The job runs in a separate worker process; poll
    `GET /v1/jobs/{id}` until the status is terminal (`succeeded`, `failed`, `cancelled` or
    `unsupported`). When the engine for the kind is not available in this instance the job is
    stored with status `unsupported` and the reasons, and is never run."""
    kind, job_input, settings = canonical_request(request)
    job_id = ctx.jobs.submit(kind, job_input, settings, request.timeout_seconds)
    with ctx.db.connection() as conn:
        row = store.get_job(conn, job_id)
    assert row is not None
    return job_from_row(row)


@router.get("/jobs", response_model=Page[JobSummary], responses=error_responses(422), summary="List jobs, newest first")
def list_jobs(
    ctx: Ctx,
    status: JobStatus | None = Query(default=None, description="Only jobs in this status."),
    kind: str | None = Query(default=None, description="Only jobs of this kind."),
    input_hash: str | None = Query(default=None, pattern="^[0-9a-f]{64}$", description="Only jobs with this request hash (earlier runs of the same request)."),
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> Page[JobSummary]:
    with ctx.db.connection() as conn:
        rows, total = store.list_jobs(conn, status=status, kind=kind, input_hash=input_hash, limit=limit, offset=offset)
    return Page[JobSummary](items=[JobSummary(**_summary_fields(r)) for r in rows], total=total, limit=limit, offset=offset)


@router.get("/jobs/{job_id}", response_model=Job, responses=error_responses(404, 422), summary="Get a job with its progress, messages and result")
def get_job(job_id: UUID, ctx: Ctx) -> Job:
    with ctx.db.connection() as conn:
        row = store.get_job(conn, job_id)
    if row is None:
        raise not_found("job", job_id)
    return job_from_row(row)


@router.delete("/jobs/{job_id}", response_model=Job, responses=error_responses(404, 422), summary="Cancel a job")
def cancel_job(job_id: UUID, ctx: Ctx) -> Job:
    """Cancels a queued job immediately. For a running job the worker process is terminated
    (SIGTERM, then SIGKILL); the response still shows `running` with `cancel_requested: true` until
    the supervisor has confirmed the process is gone, then the status becomes `cancelled`. A job
    that is already terminal is returned unchanged. The record itself is kept."""
    with ctx.db.connection() as conn:
        row = store.request_cancel(conn, job_id)
    if row is None:
        raise not_found("job", job_id)
    ctx.jobs.notify()
    return job_from_row(row)
