"""Service-level endpoints: liveness, health and the engine inventory."""

from __future__ import annotations

import time
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

from .. import SERVICE_NAME, __version__
from ..errors import ApiError, error_responses
from ..jobs import store
from ..jobs.kinds import KINDS
from .common import Ctx, utc_now

router = APIRouter()


class ServiceInfo(BaseModel):
    service: str
    version: str
    description: str
    api_base: str = Field(description="Prefix of the versioned API.")
    docs: str = Field(description="Interactive OpenAPI documentation.")
    openapi: str
    health: str


class DatabaseHealth(BaseModel):
    connected: bool
    schema_version: str | None = Field(description="Number of the newest applied migration.")
    migrations_applied: int
    latency_ms: float = Field(description="Round-trip time of the health query, in milliseconds.")


class JobsHealth(BaseModel):
    supervisor_running: bool
    max_worker_processes: int
    running: int = Field(description="Jobs currently running in this database.")
    queued: int


class HealthResponse(BaseModel):
    status: Literal["ok"]
    service: str
    version: str
    time: datetime = Field(description="Current server time (UTC).")
    uptime_seconds: float
    database: DatabaseHealth
    jobs: JobsHealth
    engines: dict[str, str | None] = Field(description="Engine id mapped to its detected version, or null when the engine is not available.")


class SelfTest(BaseModel):
    description: str
    passed: bool
    elapsed_seconds: float
    detail: str | None = None


class EngineInfo(BaseModel):
    id: str = Field(examples=["rdkit"])
    name: str
    description: str
    available: bool = Field(description="True only if the engine imported and completed its self-test in this service instance.")
    version: str | None = Field(description="Version detected at runtime; null when the engine is not available.")
    unavailable_reason: str | None
    components: dict[str, str] = Field(description="Versions of the libraries that make up the engine.")
    capabilities: list[str]
    job_kinds: list[str] = Field(description="Job kinds this engine serves.")
    available_job_kinds: list[str] = Field(description="Job kinds that can actually run now; the rest answer with status `unsupported`.")
    license: str | None = Field(description="Licence as declared in the installed package metadata.")
    url: str | None
    self_test: SelfTest | None = Field(description="The small real calculation run at start-up to verify the engine.")


class EnginesResponse(BaseModel):
    engines: list[EngineInfo]
    detected_at: datetime = Field(description="When the engines were probed (service start-up).")


@router.get("/", response_model=ServiceInfo, tags=["service"], summary="Service information")
def root() -> ServiceInfo:
    return ServiceInfo(
        service=SERVICE_NAME,
        version=__version__,
        description="MATTER LAB science service: validated scientific libraries behind a typed HTTP API.",
        api_base="/v1",
        docs="/docs",
        openapi="/openapi.json",
        health="/health",
    )


@router.get(
    "/health",
    response_model=HealthResponse,
    responses=error_responses(503),
    tags=["service"],
    summary="Health of the service and its database",
)
def health(ctx: Ctx) -> HealthResponse:
    """200 when the service can reach PostgreSQL and its schema is in place; 503 otherwise."""
    started = time.perf_counter()
    try:
        # A short wait: a health check must answer quickly, above all when the database is down.
        with ctx.db.connection(timeout_seconds=min(3.0, ctx.db.timeout_seconds)) as conn:
            row = conn.execute("SELECT max(version) AS version, count(*) AS n FROM schema_migrations").fetchone()
            job_counts = store.counts(conn)
    except Exception as exc:
        raise ApiError(
            503,
            "database_unavailable",
            "The service cannot reach its PostgreSQL database.",
            {"service": SERVICE_NAME, "version": __version__, "database": {"connected": False, "error": str(exc).strip().splitlines()[0] if str(exc).strip() else type(exc).__name__}},
        ) from exc
    return HealthResponse(
        status="ok",
        service=SERVICE_NAME,
        version=__version__,
        time=utc_now(),
        uptime_seconds=round((utc_now() - ctx.started_at).total_seconds(), 3),
        database=DatabaseHealth(
            connected=True,
            schema_version=row["version"] if row else None,
            migrations_applied=int(row["n"]) if row else 0,
            latency_ms=round((time.perf_counter() - started) * 1000, 3),
        ),
        jobs=JobsHealth(
            supervisor_running=ctx.jobs.is_running(),
            max_worker_processes=ctx.settings.job_workers,
            running=job_counts["running"],
            queued=job_counts["queued"],
        ),
        engines={engine.id: (engine.version if engine.available else None) for engine in ctx.engines.all()},
    )


def engine_documents(ctx: Any) -> list[EngineInfo]:
    documents = []
    for engine in ctx.engines.all():
        kinds = [kind for kind in KINDS.values() if kind.engine == engine.id]
        documents.append(
            EngineInfo(
                id=engine.id,
                name=engine.name,
                description=engine.description,
                available=engine.available,
                version=engine.version,
                unavailable_reason=engine.unavailable_reason,
                components=engine.components,
                capabilities=list(engine.capabilities),
                job_kinds=[kind.name for kind in kinds],
                available_job_kinds=[kind.name for kind in kinds if ctx.jobs.availability(kind)[0]],
                license=engine.license,
                url=engine.url,
                self_test=SelfTest(**engine.self_test) if engine.self_test else None,
            )
        )
    return documents


@router.get("/v1/engines", response_model=EnginesResponse, tags=["service"], summary="Scientific engines available in this instance")
def engines(ctx: Ctx) -> EnginesResponse:
    """Engines are detected at start-up by importing them and running a small real calculation.
    Versions are read from the installed libraries, never hard-coded."""
    detected = min((engine.detected_at for engine in ctx.engines.all()), default=time.time())
    return EnginesResponse(engines=engine_documents(ctx), detected_at=datetime.fromtimestamp(detected, tz=utc_now().tzinfo))
