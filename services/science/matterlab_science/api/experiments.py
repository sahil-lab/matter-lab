"""Experiments: saved work that can be reopened and reproduced."""

from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

import psycopg
from fastapi import APIRouter, Query, Response
from pydantic import BaseModel, ConfigDict, Field

from ..db import Jsonb
from ..errors import ApiError, error_responses, not_found
from ..jobs.kinds import KINDS
from ..provenance import PROVENANCE_COLUMNS, Provenance, provenance_from_row
from .common import Ctx, Page, Title
from .jobs import JobEngine, JobStatus

router = APIRouter(prefix="/v1/experiments", tags=["experiments"])

_JSON_LIMIT = "Stored verbatim as JSON."


class ExperimentWrite(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        json_schema_extra={
            "examples": [
                {
                    "title": "Ethanol conformers",
                    "kind": "molecule",
                    "inputs": {"structure": {"format": "smiles", "data": "CCO"}},
                    "settings": {"force_field": "auto"},
                    "tags": ["demo"],
                }
            ]
        },
    )

    title: Title
    description: str | None = Field(default=None, max_length=20_000)
    kind: str | None = Field(default=None, max_length=100, description="Free-form category chosen by the client.")
    inputs: dict[str, Any] = Field(default_factory=dict, description=f"Everything needed to rebuild the experiment (structures, scene, parameters). {_JSON_LIMIT}")
    settings: dict[str, Any] = Field(default_factory=dict, description=f"Client settings. {_JSON_LIMIT}")
    results: dict[str, Any] = Field(default_factory=dict, description=f"Client-side results. Computed results belong to the linked calculations. {_JSON_LIMIT}")
    notes: str | None = Field(default=None, max_length=100_000)
    tags: list[str] = Field(default_factory=list, max_length=50)
    reaction_id: UUID | None = None
    calculation_ids: list[UUID] = Field(default_factory=list, max_length=500, description="Jobs that belong to this experiment, in order.")


class ExperimentReplace(ExperimentWrite):
    expected_revision: int | None = Field(default=None, ge=1, description="When given, the update is refused with 409 unless the stored revision matches.")


class ExperimentPatch(BaseModel):
    """Only the fields that are present are changed."""

    model_config = ConfigDict(extra="forbid")

    title: Title | None = None
    description: str | None = Field(default=None, max_length=20_000)
    kind: str | None = Field(default=None, max_length=100)
    inputs: dict[str, Any] | None = None
    settings: dict[str, Any] | None = None
    results: dict[str, Any] | None = None
    notes: str | None = Field(default=None, max_length=100_000)
    tags: list[str] | None = Field(default=None, max_length=50)
    reaction_id: UUID | None = None
    calculation_ids: list[UUID] | None = Field(default=None, max_length=500)
    expected_revision: int | None = Field(default=None, ge=1)


class LinkedCalculation(BaseModel):
    id: UUID
    kind: str
    status: JobStatus
    input_hash: str
    engine: JobEngine
    method: str | None
    converged: bool | None
    label: str | None
    created_at: datetime
    finished_at: datetime | None


class ExperimentSummary(BaseModel):
    id: UUID
    title: str
    description: str | None
    kind: str | None
    tags: list[str]
    revision: int
    calculation_count: int
    created_at: datetime
    updated_at: datetime


class Experiment(BaseModel):
    id: UUID
    title: str
    description: str | None
    kind: str | None
    inputs: dict[str, Any]
    settings: dict[str, Any]
    results: dict[str, Any]
    notes: str | None
    tags: list[str]
    reaction_id: UUID | None
    revision: int = Field(description="Incremented on every update.")
    calculations: list[LinkedCalculation] = Field(description="Linked jobs with what is needed to compare or repeat them; fetch the full job from /v1/jobs/{id}.")
    provenance: Provenance
    created_at: datetime
    updated_at: datetime


class RerunResponse(BaseModel):
    experiment: Experiment
    submitted: list[LinkedCalculation] = Field(description="The newly submitted jobs. Each repeats a linked calculation with an identical request, so it has the same input_hash.")
    note: str


def _load(conn: psycopg.Connection[Any], experiment_id: UUID) -> Experiment | None:
    row = conn.execute(
        f"""
        SELECT x.id, x.title, x.description, x.kind, x.inputs, x.settings, x.results, x.notes, x.tags, x.reaction_id, x.revision,
               x.created_at, x.updated_at, {PROVENANCE_COLUMNS}
        FROM experiments x JOIN data_sources ds ON ds.id = x.source_id WHERE x.id = %s
        """,
        (experiment_id,),
    ).fetchone()
    if row is None:
        return None
    links = conn.execute(
        """
        SELECT c.id, c.kind, c.status, c.input_hash, c.engine, c.engine_version, c.method, c.converged, l.label, c.created_at, c.finished_at
        FROM experiment_calculations l JOIN calculations c ON c.id = l.calculation_id
        WHERE l.experiment_id = %s ORDER BY l.position, l.linked_at, c.id
        """,
        (experiment_id,),
    ).fetchall()
    data = {k: v for k, v in row.items() if not k.startswith("ds_")}
    return Experiment(**data, calculations=[_linked(link) for link in links], provenance=provenance_from_row(row))


def _linked(row: dict[str, Any]) -> LinkedCalculation:
    return LinkedCalculation(
        id=row["id"],
        kind=row["kind"],
        status=row["status"],
        input_hash=row["input_hash"],
        engine=JobEngine(id=row["engine"], version=row["engine_version"]),
        method=row["method"],
        converged=row["converged"],
        label=row["label"],
        created_at=row["created_at"],
        finished_at=row["finished_at"],
    )


def _check_links(conn: psycopg.Connection[Any], reaction_id: UUID | None, calculation_ids: list[UUID] | None) -> None:
    if reaction_id is not None and conn.execute("SELECT 1 FROM reactions WHERE id = %s", (reaction_id,)).fetchone() is None:
        raise ApiError(422, "unknown_reference", f"There is no reaction with id {reaction_id}.", {"field": "reaction_id", "id": str(reaction_id)})
    if calculation_ids:
        known = {r["id"] for r in conn.execute("SELECT id FROM calculations WHERE id = ANY(%s)", (calculation_ids,))}
        missing = [str(c) for c in calculation_ids if c not in known]
        if missing:
            raise ApiError(422, "unknown_reference", f"There is no job with id {', '.join(missing)}.", {"field": "calculation_ids", "ids": missing})


def _set_links(conn: psycopg.Connection[Any], experiment_id: UUID, calculation_ids: list[UUID]) -> None:
    ordered = list(dict.fromkeys(calculation_ids))
    conn.execute("DELETE FROM experiment_calculations WHERE experiment_id = %s AND NOT (calculation_id = ANY(%s))", (experiment_id, ordered))
    for position, calculation_id in enumerate(ordered):
        conn.execute(
            "INSERT INTO experiment_calculations (experiment_id, calculation_id, position) VALUES (%s, %s, %s) "
            "ON CONFLICT (experiment_id, calculation_id) DO UPDATE SET position = EXCLUDED.position",
            (experiment_id, calculation_id, position),
        )


def _clean_tags(tags: list[str]) -> list[str]:
    return list(dict.fromkeys(tag.strip() for tag in tags if tag.strip()))


@router.post("", response_model=Experiment, status_code=201, responses=error_responses(422), summary="Save a new experiment")
def create_experiment(request: ExperimentWrite, ctx: Ctx) -> Experiment:
    with ctx.db.connection() as conn:
        _check_links(conn, request.reaction_id, request.calculation_ids)
        row = conn.execute(
            """
            INSERT INTO experiments (title, description, kind, inputs, settings, results, notes, tags, reaction_id, source_id)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id
            """,
            (
                request.title.strip(),
                request.description,
                request.kind,
                Jsonb(request.inputs),
                Jsonb(request.settings),
                Jsonb(request.results),
                request.notes,
                _clean_tags(request.tags),
                request.reaction_id,
                ctx.user_source_id,
            ),
        ).fetchone()
        assert row is not None
        _set_links(conn, row["id"], request.calculation_ids)
        experiment = _load(conn, row["id"])
    assert experiment is not None
    return experiment


@router.get("", response_model=Page[ExperimentSummary], responses=error_responses(422), summary="List experiments, most recently updated first")
def list_experiments(
    ctx: Ctx,
    tag: str | None = Query(default=None, description="Only experiments carrying this tag."),
    kind: str | None = Query(default=None, description="Only experiments of this kind."),
    q: str | None = Query(default=None, min_length=1, max_length=200, description="Case-insensitive fragment of the title."),
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> Page[ExperimentSummary]:
    clauses: list[str] = []
    params: list[Any] = []
    if tag is not None:
        clauses.append("x.tags @> ARRAY[%s]::text[]")
        params.append(tag)
    if kind is not None:
        clauses.append("x.kind = %s")
        params.append(kind)
    if q is not None:
        clauses.append("position(lower(%s) in lower(x.title)) > 0")
        params.append(q.strip())
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with ctx.db.connection() as conn:
        total = conn.execute(f"SELECT count(*) AS n FROM experiments x {where}", params).fetchone()
        rows = conn.execute(
            f"""
            SELECT x.id, x.title, x.description, x.kind, x.tags, x.revision, x.created_at, x.updated_at,
                   (SELECT count(*) FROM experiment_calculations l WHERE l.experiment_id = x.id) AS calculation_count
            FROM experiments x {where} ORDER BY x.updated_at DESC, x.id LIMIT %s OFFSET %s
            """,
            [*params, limit, offset],
        ).fetchall()
    return Page[ExperimentSummary](items=[ExperimentSummary(**r) for r in rows], total=int(total["n"]) if total else 0, limit=limit, offset=offset)


@router.get("/{experiment_id}", response_model=Experiment, responses=error_responses(404, 422), summary="Reopen an experiment")
def get_experiment(experiment_id: UUID, ctx: Ctx) -> Experiment:
    with ctx.db.connection() as conn:
        experiment = _load(conn, experiment_id)
    if experiment is None:
        raise not_found("experiment", experiment_id)
    return experiment


def _update(ctx: Any, experiment_id: UUID, changes: dict[str, Any], expected_revision: int | None) -> Experiment:
    calculation_ids = changes.pop("calculation_ids", None)
    with ctx.db.connection() as conn:
        current = conn.execute("SELECT revision FROM experiments WHERE id = %s FOR UPDATE", (experiment_id,)).fetchone()
        if current is None:
            raise not_found("experiment", experiment_id)
        if expected_revision is not None and current["revision"] != expected_revision:
            raise ApiError(
                409,
                "revision_conflict",
                f"The experiment is at revision {current['revision']}, not {expected_revision}; it was changed since you loaded it.",
                {"current_revision": current["revision"], "expected_revision": expected_revision},
            )
        _check_links(conn, changes.get("reaction_id"), calculation_ids)
        assignments = ["revision = revision + 1"]
        params: list[Any] = []
        for column, value in changes.items():
            assignments.append(f"{column} = %s")
            if column in ("inputs", "settings", "results"):
                params.append(Jsonb(value))
            elif column == "tags":
                params.append(_clean_tags(value))
            elif column == "title":
                params.append(value.strip())
            else:
                params.append(value)
        conn.execute(f"UPDATE experiments SET {', '.join(assignments)} WHERE id = %s", [*params, experiment_id])
        if calculation_ids is not None:
            _set_links(conn, experiment_id, calculation_ids)
        experiment = _load(conn, experiment_id)
    assert experiment is not None
    return experiment


@router.put("/{experiment_id}", response_model=Experiment, responses=error_responses(404, 409, 422), summary="Replace an experiment")
def replace_experiment(experiment_id: UUID, request: ExperimentReplace, ctx: Ctx) -> Experiment:
    """Every field is replaced by the request (omitted fields return to their defaults)."""
    changes = request.model_dump(exclude={"expected_revision"})
    return _update(ctx, experiment_id, changes, request.expected_revision)


@router.patch("/{experiment_id}", response_model=Experiment, responses=error_responses(404, 409, 422), summary="Change some fields of an experiment")
def patch_experiment(experiment_id: UUID, request: ExperimentPatch, ctx: Ctx) -> Experiment:
    changes = request.model_dump(exclude_unset=True, exclude={"expected_revision"})
    for required in ("title", "inputs", "settings", "results", "tags"):
        if required in changes and changes[required] is None:
            raise ApiError(422, "validation_error", f"`{required}` cannot be set to null.", [{"location": ["body", required], "message": "must not be null", "type": "null_not_allowed"}])
    return _update(ctx, experiment_id, changes, request.expected_revision)


@router.delete("/{experiment_id}", status_code=204, responses=error_responses(404, 422), summary="Delete an experiment")
def delete_experiment(experiment_id: UUID, ctx: Ctx) -> Response:
    """Removes the experiment and its links. The linked calculations themselves are kept."""
    if ctx.db.execute("DELETE FROM experiments WHERE id = %s", (experiment_id,)) == 0:
        raise not_found("experiment", experiment_id)
    return Response(status_code=204)


@router.post(
    "/{experiment_id}/rerun",
    response_model=RerunResponse,
    status_code=202,
    responses=error_responses(404, 422),
    summary="Reproduce an experiment by repeating its calculations",
)
def rerun_experiment(experiment_id: UUID, ctx: Ctx) -> RerunResponse:
    """Submits a new job for every calculation linked to the experiment, with exactly the stored
    kind, input and settings, and links the new jobs to the experiment. Because the request is
    identical the new job has the same `input_hash`; compare the two results to check
    reproducibility. Engine versions may differ from the original run and are recorded on each job."""
    with ctx.db.connection() as conn:
        if conn.execute("SELECT 1 FROM experiments WHERE id = %s", (experiment_id,)).fetchone() is None:
            raise not_found("experiment", experiment_id)
        originals = conn.execute(
            """
            SELECT c.id, c.kind, c.input, c.settings, c.timeout_seconds FROM experiment_calculations l
            JOIN calculations c ON c.id = l.calculation_id WHERE l.experiment_id = %s ORDER BY l.position, l.linked_at, c.id
            """,
            (experiment_id,),
        ).fetchall()
    runnable = [o for o in originals if o["kind"] in KINDS]
    new_ids: list[tuple[UUID, UUID]] = []
    for original in runnable:
        new_ids.append((ctx.jobs.submit(original["kind"], original["input"], original["settings"], original["timeout_seconds"]), original["id"]))
    with ctx.db.connection() as conn:
        position = conn.execute("SELECT COALESCE(max(position), -1) AS p FROM experiment_calculations WHERE experiment_id = %s", (experiment_id,)).fetchone()
        offset = int(position["p"]) + 1 if position else 0
        for index, (new_id, original_id) in enumerate(new_ids):
            conn.execute(
                "INSERT INTO experiment_calculations (experiment_id, calculation_id, label, position) VALUES (%s, %s, %s, %s)",
                (experiment_id, new_id, f"rerun of {original_id}", offset + index),
            )
        conn.execute("UPDATE experiments SET revision = revision + 1 WHERE id = %s", (experiment_id,))
        experiment = _load(conn, experiment_id)
    assert experiment is not None
    submitted_ids = {new_id for new_id, _ in new_ids}
    skipped = len(originals) - len(runnable)
    return RerunResponse(
        experiment=experiment,
        submitted=[c for c in experiment.calculations if c.id in submitted_ids],
        note=(
            f"{len(new_ids)} job(s) submitted."
            + (f" {skipped} linked calculation(s) have a kind this service does not know and were not repeated." if skipped else "")
            + " A repeated job is a new calculation; nothing is copied from the original result."
        ),
    )
