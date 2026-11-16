"""FastAPI application factory."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from . import SERVICE_NAME, __version__
from .config import Settings, load_settings
from .context import startup
from .errors import error_payload, error_responses, install_error_handlers
from .lab.middleware import LabBoundaryMiddleware
from .lab.openapi import install_lab_openapi
from .lab.problems import is_lab, problem_response

log = logging.getLogger("matterlab.app")

DESCRIPTION = """
Scientific backend of **MATTER LAB**. It wraps validated scientific libraries (RDKit, and when
installed tblite/xTB and PySCF), runs calculations as asynchronous jobs in worker processes,
keeps reference data with provenance in PostgreSQL, and imports/exports Excel.

Conventions

* Existing `/v1` errors retain `{"error": {"code", "message", "details"}}`.
* Additive `/api/v1/lab` routes use authenticated bearer scopes and RFC 9457 Problem Details.
  Lab coordinates are meters, volume liters, amount moles, temperature kelvin and time seconds.
* Coordinates are in angstrom. Energies name their unit in the field name or in a `units` object.
* Timestamps are ISO 8601 in UTC.
* Results are labelled by how they were obtained (`evidence`) and by the engine and version that
  produced them. Nothing is fabricated: when an engine cannot treat an input the answer is an
  explicit `unsupported` or `failed` state with the reasons.
* An endpoint that needs PostgreSQL answers `503` with code `database_unavailable` while the
  database cannot be reached. An unexpected failure is a `500` with code `internal_error`.
"""

TAGS = [
    {"name": "service", "description": "Liveness, health and the engine inventory."},
    {"name": "chemistry", "description": "Synchronous RDKit operations on one structure."},
    {"name": "jobs", "description": "Asynchronous calculations in worker processes, persisted in the `calculations` table."},
    {"name": "reference data", "description": "Elements, isotopes, functional groups, solvents, catalysts and their sources."},
    {"name": "catalogue", "description": "The local compound catalogue and its exact, substructure and similarity searches."},
    {"name": "reactions", "description": "Reactions as RDKit-validated reaction SMILES."},
    {"name": "experiments", "description": "Saved experiments that can be reopened and reproduced."},
    {"name": "discoveries", "description": "Discovery candidates, the catalogues searched for them, and their evidence trail."},
    {"name": "excel", "description": "Workbook export and import. PostgreSQL is authoritative; Excel is an interchange format."},
    {"name": "laboratory", "description": "Owner-scoped, revisioned scenes, immutable shared-runtime runs, curated catalogues and scoped JSON/Excel notebooks."},
]


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or load_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        ctx = await run_in_threadpool(startup, settings)
        app.state.ctx = ctx
        log.info("%s %s ready", SERVICE_NAME, __version__)
        try:
            yield
        finally:
            await run_in_threadpool(ctx.shutdown)

    app = FastAPI(
        title="MATTER LAB science service",
        version=__version__,
        description=DESCRIPTION,
        openapi_tags=TAGS,
        lifespan=lifespan,
    )

    @app.middleware("http")
    async def _unexpected_errors(request: Request, call_next):  # type: ignore[no-untyped-def]
        # Kept inside the CORS middleware so that even an unexpected failure reaches the browser
        # as a readable JSON error instead of an opaque CORS failure.
        try:
            return await call_next(request)
        except Exception as exc:
            log.exception("unhandled error on %s %s", request.method, request.url.path)
            if is_lab(request):
                return problem_response(request, 500, "INTERNAL_ERROR", "The laboratory request failed; no successful write is confirmed.")
            return JSONResponse(
                status_code=500,
                content=error_payload("internal_error", "The service hit an unexpected error. It has been logged.", {"type": type(exc).__name__}),
            )

    app.add_middleware(LabBoundaryMiddleware, max_bytes=settings.lab_max_request_bytes)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["*"],
        expose_headers=["Content-Disposition", "X-MatterLab-Schema-Version", "X-MatterLab-Exported-At", "Retry-After", "ETag", "X-Request-ID", "Location", "Idempotency-Replayed"],
        max_age=600,
    )
    install_error_handlers(app)

    from .api import chem, compounds, discoveries, excel, experiments, jobs, lab, reactions, reference, system

    for router in (system.router, chem.router, jobs.info_router):
        app.include_router(router)
    # Everything below reads or writes PostgreSQL and answers 503 while it cannot be reached.
    for router in (jobs.router, reference.router, compounds.router, reactions.router, experiments.router, discoveries.router):
        app.include_router(router, responses=error_responses(503))
    app.include_router(excel.info_router)
    app.include_router(excel.router, responses=error_responses(503))
    app.include_router(lab.router)
    install_lab_openapi(app, settings.lab_schema_path, settings.lab_learning_schema_path, settings.lab_editor_schema_path)
    return app
