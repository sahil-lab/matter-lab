"""Owner-scoped laboratory API, added alongside (never replacing) the existing /v1 service."""

from __future__ import annotations

import asyncio
import copy
import json
import time
from typing import Any, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Header, Query, Request, Response
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.concurrency import run_in_threadpool

from ..db import Jsonb
from ..lab import catalog, store
from ..lab.auth import Exporter, Reader, Runner, Writer, require_action_actors
from ..lab.models import DuplicateRequest, RunCreate, RunResource, RunSummary, SceneCreate, ScenePatch, SceneResource, SceneSummary, TemplateCreate, TemplateResource
from ..lab.problems import LabProblem, ProblemDetails
from ..lab.validation import (
    UNITS_POLICY, canonical_bytes, decode_json, duplicated_scene, idempotency_key, parse_etag, remap_identifiers, request_hash, run_input_hash, scene_identifiers,
    validate_checkpoint, validate_contract, validate_editor_state, validate_learning_state, validate_scene,
)
from .common import Ctx, Page

router = APIRouter(
    prefix="/api/v1/lab", tags=["laboratory"],
    responses={status: {"model": ProblemDetails, "description": "RFC 9457 laboratory problem"} for status in (400, 401, 403, 404, 409, 413, 422, 428, 429, 503)},
)


def _title(value: str) -> str:
    result = value.strip()
    if not result:
        raise LabProblem(422, "EMPTY_TITLE", "A nonblank title is required.")
    return result


def _recalled(row: dict[str, Any]) -> JSONResponse:
    return JSONResponse(status_code=row["status_code"], content=row["response"], headers={"Idempotency-Replayed": "true", **({"ETag": row["etag"]} if row["etag"] else {})})


def _scene_response(row: dict[str, Any], status: int = 200) -> JSONResponse:
    return JSONResponse(status_code=status, content=store.scene_resource(row), headers={"ETag": f'"{row["revision"]}"'})


def _create_row(ctx: Any, conn: Any, owner: UUID, title: str, scene: dict[str, Any], checkpoint: dict[str, Any] | None, snapshot: dict[str, Any], learning: dict[str, Any] | None = None, editor: dict[str, Any] | None = None) -> dict[str, Any]:
    count = conn.execute("SELECT count(*) AS n FROM lab_scene WHERE owner_id = %s", (owner,)).fetchone()["n"]
    if count >= ctx.settings.lab_max_scenes_per_owner:
        raise LabProblem(429, "SCENE_QUOTA_EXCEEDED", "The configured scene quota was reached.")
    saved = copy.deepcopy(scene)
    saved["revision"] = 1
    row = conn.execute(
        "INSERT INTO lab_scene(id,owner_id,title,revision,scene,runtime_checkpoint,catalog_snapshot,source_id,learning_state,editor_state) "
        "VALUES (%s,%s,%s,1,%s,%s,%s,%s,%s,%s) ON CONFLICT (id) DO NOTHING RETURNING *",
        (UUID(saved["id"]), owner, title, Jsonb(saved), Jsonb(checkpoint) if checkpoint is not None else None, Jsonb(snapshot), ctx.user_source_id,
         Jsonb(learning) if learning is not None else None, Jsonb(editor) if editor is not None else None),
    ).fetchone()
    if row is None:
        raise LabProblem(409, "SCENE_ID_CONFLICT", "This scene ID is already in use. Duplicate it to create independent identifiers.")
    return row


@router.get("/capabilities")
def capabilities(ctx: Ctx, principal: Reader) -> dict[str, Any]:
    return {
        "schemaVersion": 1, "contractVersion": ctx.settings.lab_contract_version,
        "runtimeVersion": ctx.settings.lab_runtime_version, "methodVersion": ctx.settings.lab_method_version,
        "runnerBundlePresent": ctx.settings.lab_runner_path.is_file(), "schemaPresent": ctx.settings.lab_schema_path.is_file(),
        "validatorBundlePresent": ctx.settings.lab_validator_path.is_file(),
        "ownerId": str(principal.owner_id), "scopes": sorted(principal.scopes), "unitsPolicy": UNITS_POLICY,
        "maxRequestBytes": ctx.settings.lab_max_request_bytes, "catalogStatus": "CURATED",
    }


@router.post("/scenes", response_model=SceneResource, status_code=201)
def create_scene(body: SceneCreate, ctx: Ctx, principal: Writer, key: str | None = Header(default=None, alias="Idempotency-Key")) -> JSONResponse:
    key = idempotency_key(key)
    validate_scene(body.scene, ctx.settings.lab_schema_path, ctx.settings.lab_validator_path, ctx.settings.lab_node_binary, ctx.settings.lab_validation_timeout_seconds)
    validate_checkpoint(body.runtimeCheckpoint, body.scene, ctx.settings.lab_schema_path, ctx.settings.lab_validator_path, ctx.settings.lab_node_binary, ctx.settings.lab_validation_timeout_seconds)
    validate_learning_state(body.learningState, ctx.settings)
    validate_editor_state(body.editorState, body.scene["id"], ctx.settings)
    normalized = body.model_dump()
    if body.learningState is None:
        normalized.pop("learningState")
    if body.editorState is None:
        normalized.pop("editorState")
    digest = request_hash(normalized)
    with ctx.db.connection() as conn:
        store.lock_owner(conn, principal.owner_id)
        previous = store.recall(conn, principal.owner_id, "/scenes", key, digest)
        if previous:
            return _recalled(previous)
        snapshot = catalog.snapshot_for_scene(body.scene, ctx.settings.lab_catalog_dir)
        row = _create_row(ctx, conn, principal.owner_id, _title(body.title), body.scene, body.runtimeCheckpoint, snapshot, body.learningState, body.editorState)
        store.remember(conn, principal.owner_id, "/scenes", key, digest, store.scene_resource(row), 201, '"1"')
    return _scene_response(row, 201)


@router.get("/seed-scene")
def seed_scene(ctx: Ctx, principal: Reader) -> dict[str, Any]:
    path = ctx.settings.lab_catalog_dir / "starter-scene.json"
    try:
        if path.stat().st_size > ctx.settings.lab_max_request_bytes:
            raise ValueError("oversized seed")
        seed = decode_json(path.read_bytes())
        if seed["schemaVersion"] != 1 or seed["contractVersion"] != ctx.settings.lab_contract_version:
            raise ValueError("incompatible seed")
        scene = duplicated_scene(seed["scene"])
        scene["revision"] = 0
        identifiers = dict(zip(scene_identifiers(seed["scene"]), scene_identifiers(scene), strict=True))
        for step in seed["suggestedSteps"]:
            if step["kind"] == "ACTION":
                identifiers[step["action"]["actionId"]] = str(uuid4())
            elif step["kind"] == "CONTROL":
                identifiers[step["control"]["controlId"]] = str(uuid4())
        steps = remap_identifiers(seed["suggestedSteps"], identifiers)
        validate_contract(
            {"schemaVersion": 1, "runId": str(uuid4()), "contractVersion": ctx.settings.lab_contract_version,
             "runtimeVersion": ctx.settings.lab_runtime_version, "methodVersion": ctx.settings.lab_method_version,
             "initialScene": scene, "steps": steps}, "NodeRunRequest", ctx.settings.lab_schema_path, ctx.settings.lab_validator_path, ctx.settings.lab_node_binary, ctx.settings.lab_validation_timeout_seconds,
        )
        return {"scene": scene, "title": seed["title"], "runtimeCheckpoint": None, "suggestedSteps": steps, "saved": False}
    except (OSError, KeyError, ValueError, TypeError) as exc:
        raise LabProblem(503, "SEED_UNAVAILABLE", "Build the canonical apparatus/science release before requesting its sample scene.") from exc


@router.get("/scenes", response_model=Page[SceneSummary])
def list_scenes(ctx: Ctx, principal: Reader, q: str = Query(default="", max_length=200), limit: int = Query(default=25, ge=1, le=100), offset: int = Query(default=0, ge=0)) -> dict[str, Any]:
    with ctx.db.connection() as conn:
        params = (principal.owner_id, q)
        total = conn.execute("SELECT count(*) AS n FROM lab_scene WHERE owner_id = %s AND position(lower(%s) in lower(title)) > 0", params).fetchone()["n"]
        rows = conn.execute(
            'SELECT id,title,revision,updated_at AS "updatedAt" FROM lab_scene WHERE owner_id = %s AND position(lower(%s) in lower(title)) > 0 '
            "ORDER BY updated_at DESC,id LIMIT %s OFFSET %s", (*params, limit, offset),
        ).fetchall()
    return {"items": rows, "total": total, "limit": limit, "offset": offset}


@router.get("/scenes/{scene_id}", response_model=SceneResource)
def get_scene(scene_id: UUID, ctx: Ctx, principal: Reader) -> JSONResponse:
    with ctx.db.connection() as conn:
        row = store.scene_row(conn, scene_id, principal.owner_id)
    return _scene_response(row)


@router.patch("/scenes/{scene_id}", response_model=SceneResource)
def patch_scene(scene_id: UUID, body: ScenePatch, ctx: Ctx, principal: Writer, if_match: str | None = Header(default=None, alias="If-Match")) -> JSONResponse:
    expected = parse_etag(if_match)
    if not body.model_fields_set or ("title" in body.model_fields_set and body.title is None) or ("scene" in body.model_fields_set and body.scene is None):
        raise LabProblem(422, "INVALID_PATCH", "Supply nonnull scene/title changes, or explicitly replace/clear runtimeCheckpoint.")
    if body.scene is not None:
        validate_scene(body.scene, ctx.settings.lab_schema_path, ctx.settings.lab_validator_path, ctx.settings.lab_node_binary, ctx.settings.lab_validation_timeout_seconds)
    if "learningState" in body.model_fields_set:
        validate_learning_state(body.learningState, ctx.settings)
    if "editorState" in body.model_fields_set:
        validate_editor_state(body.editorState, str(scene_id), ctx.settings)
    with ctx.db.connection() as conn:
        row = store.scene_row(conn, scene_id, principal.owner_id, lock=True)
        store.revision_matches(row, expected)
        scene = body.scene if body.scene is not None else row["scene"]
        if scene["id"] != str(scene_id) or scene["revision"] != expected:
            raise LabProblem(409, "SCENE_REVISION_MISMATCH", "The submitted scene ID and durable revision must match the saved resource and If-Match.")
        if body.scene is not None and row["runtime_checkpoint"] is not None and "runtimeCheckpoint" not in body.model_fields_set:
            raise LabProblem(409, "CHECKPOINT_REQUIRED", "Replacing a checkpointed scene requires an updated checkpoint or an explicit null to begin a fresh history.")
        checkpoint = body.runtimeCheckpoint if "runtimeCheckpoint" in body.model_fields_set else row["runtime_checkpoint"]
        learning = body.learningState if "learningState" in body.model_fields_set else row["learning_state"]
        editor = body.editorState if "editorState" in body.model_fields_set else row["editor_state"]
        validate_checkpoint(checkpoint, scene, ctx.settings.lab_schema_path, ctx.settings.lab_validator_path, ctx.settings.lab_node_binary, ctx.settings.lab_validation_timeout_seconds)
        scene = {**scene, "revision": expected + 1}
        snapshot = catalog.retain_pinned_catalog(row["catalog_snapshot"], catalog.snapshot_for_scene(scene, ctx.settings.lab_catalog_dir))
        row = conn.execute(
            "UPDATE lab_scene SET title=%s,revision=revision+1,scene=%s,runtime_checkpoint=%s,catalog_snapshot=%s,learning_state=%s,editor_state=%s WHERE id=%s AND owner_id=%s RETURNING *",
            (_title(body.title) if body.title is not None else row["title"], Jsonb(scene), Jsonb(checkpoint) if checkpoint is not None else None,
             Jsonb(snapshot), Jsonb(learning) if learning is not None else None, Jsonb(editor) if editor is not None else None, scene_id, principal.owner_id),
        ).fetchone()
    return _scene_response(row)


@router.post("/scenes/{scene_id}/duplicate", response_model=SceneResource, status_code=201)
def duplicate_scene(scene_id: UUID, ctx: Ctx, principal: Writer, body: DuplicateRequest | None = None, key: str | None = Header(default=None, alias="Idempotency-Key")) -> JSONResponse:
    body = body or DuplicateRequest()
    key = idempotency_key(key)
    route = f"/scenes/{scene_id}/duplicate"
    digest = request_hash(body.model_dump())
    with ctx.db.connection() as conn:
        store.lock_owner(conn, principal.owner_id)
        previous = store.recall(conn, principal.owner_id, route, key, digest)
        if previous:
            return _recalled(previous)
        original = store.scene_row(conn, scene_id, principal.owner_id)
        scene = duplicated_scene(original["scene"])
        validate_scene(scene, ctx.settings.lab_schema_path, ctx.settings.lab_validator_path, ctx.settings.lab_node_binary, ctx.settings.lab_validation_timeout_seconds)
        title = _title(body.title) if body.title else (original["title"][:290] + " (copy)")
        row = _create_row(ctx, conn, principal.owner_id, title, scene, None, original["catalog_snapshot"])
        store.remember(conn, principal.owner_id, route, key, digest, store.scene_resource(row), 201, '"1"')
    return _scene_response(row, 201)


@router.post("/scenes/{scene_id}/runs", response_model=RunResource, status_code=202)
def create_run(scene_id: UUID, body: RunCreate, ctx: Ctx, principal: Runner, key: str | None = Header(default=None, alias="Idempotency-Key")) -> JSONResponse:
    from ..lab.runner import bundle_fingerprint

    key = idempotency_key(key)
    route = f"/scenes/{scene_id}/runs"
    digest = request_hash(body.model_dump())
    with ctx.db.connection() as conn:
        store.lock_owner(conn, principal.owner_id)
        previous = store.recall(conn, principal.owner_id, route, key, digest)
        if previous:
            return _recalled(previous)
        saved = store.scene_row(conn, scene_id, principal.owner_id, lock=True)
        store.revision_matches(saved, body.expectedRevision)
        counts = conn.execute("SELECT count(*) AS total, count(*) FILTER (WHERE status IN ('QUEUED','RUNNING')) AS active FROM lab_run WHERE owner_id=%s", (principal.owner_id,)).fetchone()
        if counts["active"] >= ctx.settings.lab_max_active_runs_per_owner:
            raise LabProblem(429, "RUN_QUOTA_EXCEEDED", "Wait for or cancel an active laboratory run before submitting another.")
        if counts["total"] >= ctx.settings.lab_max_runs_per_owner:
            raise LabProblem(429, "RUN_HISTORY_QUOTA_EXCEEDED", "The configured immutable run-history quota was reached. Ask an administrator about retention capacity.")
        checkpoint = saved["runtime_checkpoint"]
        versions = {
            "contractVersion": ctx.settings.lab_contract_version, "runtimeVersion": ctx.settings.lab_runtime_version, "methodVersion": ctx.settings.lab_method_version,
        }
        if checkpoint and any(checkpoint[name] != version for name, version in versions.items()):
            raise LabProblem(409, "RUNTIME_VERSION_UNAVAILABLE", "The saved checkpoint requires another runtime release; it will not be silently upgraded.")
        run_id = uuid4()
        initial = checkpoint["initialScene"] if checkpoint else saved["scene"]
        steps = [*(checkpoint["steps"] if checkpoint else []), *body.steps]
        payload = {"schemaVersion": 1, "runId": str(run_id), **versions, "initialScene": initial, "steps": steps}
        limits = body.limits if body.limits is not None else checkpoint.get("limits") if checkpoint else None
        if limits is not None:
            payload["limits"] = limits
        validate_contract(payload, "NodeRunRequest", ctx.settings.lab_schema_path, ctx.settings.lab_validator_path, ctx.settings.lab_node_binary, ctx.settings.lab_validation_timeout_seconds)
        require_action_actors(steps, principal.owner_id)
        catalog.require_installed_calibrations(saved["catalog_snapshot"], ctx.settings.lab_catalog_dir)
        if len(canonical_bytes(payload)) > ctx.settings.lab_max_request_bytes:
            raise LabProblem(413, "RUN_INPUT_TOO_LARGE", "Combined saved history and new steps exceed the run input limit.")
        input_hash = run_input_hash(payload)
        path = ctx.settings.lab_runner_path
        runner_hash = bundle_fingerprint(path)
        row = conn.execute(
            "INSERT INTO lab_run(id,scene_id,owner_id,scene_revision,status,input_snapshot,input_hash,contract_version,runtime_version,"
            "method_id,method_version,runner_sha256,catalog_snapshot,units_policy,source_id,learning_state_snapshot,editor_state_snapshot) "
            "VALUES(%s,%s,%s,%s,'QUEUED',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *",
            (run_id, scene_id, principal.owner_id, saved["revision"], Jsonb(payload), input_hash, versions["contractVersion"], versions["runtimeVersion"],
             initial["simulationConfig"]["methodId"], versions["methodVersion"], runner_hash,
             Jsonb(catalog.run_catalog_snapshot(saved["catalog_snapshot"], ctx.settings.lab_catalog_dir)), Jsonb(UNITS_POLICY), ctx.service_source_id,
             Jsonb(saved["learning_state"]) if saved["learning_state"] is not None else None,
             Jsonb(saved["editor_state"]) if saved["editor_state"] is not None else None),
        ).fetchone()
        store.append_event(conn, run_id, "status", {"status": "QUEUED", "runId": str(run_id)})
        resource = store.run_resource(row)
        store.remember(conn, principal.owner_id, route, key, digest, resource, 202)
    return JSONResponse(status_code=202, content=resource, headers={"Location": f"/api/v1/lab/runs/{run_id}"})


@router.get("/scenes/{scene_id}/runs", response_model=Page[RunSummary])
def list_runs(scene_id: UUID, ctx: Ctx, principal: Reader, limit: int = Query(default=10, ge=1, le=25), offset: int = Query(default=0, ge=0)) -> dict[str, Any]:
    with ctx.db.connection() as conn:
        store.scene_row(conn, scene_id, principal.owner_id)
        total = conn.execute("SELECT count(*) AS n FROM lab_run WHERE scene_id=%s AND owner_id=%s", (scene_id, principal.owner_id)).fetchone()["n"]
        rows = conn.execute(
            'SELECT id AS "runId",scene_id AS "sceneId",scene_revision AS "sceneRevision",status,input_hash AS "inputHash",'
            'method_id AS "methodId",method_version AS "methodVersion",failure_code AS "failureCode",created_at AS "createdAt",completed_at AS "completedAt" '
            "FROM lab_run WHERE scene_id=%s AND owner_id=%s ORDER BY created_at DESC,id LIMIT %s OFFSET %s",
            (scene_id, principal.owner_id, limit, offset),
        ).fetchall()
    return {"items": rows, "total": total, "limit": limit, "offset": offset}


@router.get("/runs/{run_id}", response_model=RunResource)
def get_run(run_id: UUID, ctx: Ctx, principal: Reader) -> dict[str, Any]:
    with ctx.db.connection() as conn:
        return store.run_resource(store.run_row(conn, run_id, principal.owner_id))


@router.post("/runs/{run_id}/cancel", response_model=RunResource)
def cancel_run(run_id: UUID, ctx: Ctx, principal: Runner) -> dict[str, Any]:
    from ..lab.runner import terminal_result

    with ctx.db.connection() as conn:
        row = store.run_row(conn, run_id, principal.owner_id, lock=True)
        if row["status"] in store.TERMINAL_STATUSES or row["cancel_requested"]:
            return store.run_resource(row)
        store.append_event(conn, run_id, "status", {"status": "CANCELLED" if row["status"] == "QUEUED" else "CANCELLING", "runId": str(run_id)})
        if row["status"] == "QUEUED":
            result = terminal_result(row, "CANCELLED", "Cancelled before execution.")
            row = conn.execute(
                "UPDATE lab_run SET status='CANCELLED',cancel_requested=true,completed_at=now(),result=%s WHERE id=%s RETURNING *", (Jsonb(result), run_id),
            ).fetchone()
        else:
            row = conn.execute("UPDATE lab_run SET cancel_requested=true WHERE id=%s RETURNING *", (run_id,)).fetchone()
    return store.run_resource(row)


@router.get("/runs/{run_id}/observations")
def observations(run_id: UUID, ctx: Ctx, principal: Reader, limit: int = Query(default=250, ge=1, le=1000), offset: int = Query(default=0, ge=0)) -> dict[str, Any]:
    with ctx.db.connection() as conn:
        store.run_row(conn, run_id, principal.owner_id)
        total = conn.execute("SELECT count(*) AS n FROM lab_observation WHERE run_id=%s", (run_id,)).fetchone()["n"]
        rows = conn.execute("SELECT observation FROM lab_observation WHERE run_id=%s ORDER BY ordinal LIMIT %s OFFSET %s", (run_id, limit, offset)).fetchall()
    return {"items": [row["observation"] for row in rows], "total": total, "limit": limit, "offset": offset}


@router.get("/runs/{run_id}/events", response_class=StreamingResponse, responses={200: {"content": {"text/event-stream": {}}}})
async def events(run_id: UUID, request: Request, ctx: Ctx, principal: Reader, last_event_id: str | None = Header(default=None, alias="Last-Event-ID")) -> StreamingResponse:
    try:
        after = int(last_event_id or "0")
        if after < 0 or after > 2**53 - 1:
            raise ValueError
    except ValueError as exc:
        raise LabProblem(400, "INVALID_EVENT_CURSOR", "Last-Event-ID must be a nonnegative event sequence.") from exc

    def read_page(cursor: int) -> tuple[list[dict[str, Any]], str]:
        with ctx.db.connection() as conn:
            row = store.run_row(conn, run_id, principal.owner_id)
            items = conn.execute("SELECT sequence,event_type,data FROM lab_run_event WHERE run_id=%s AND sequence>%s ORDER BY sequence LIMIT 100", (run_id, cursor)).fetchall()
            return items, row["status"]

    first = await run_in_threadpool(read_page, after)

    async def stream():
        cursor = after
        page, status = first
        deadline = time.monotonic() + 60
        heartbeat = time.monotonic()
        while True:
            for item in page:
                cursor = item["sequence"]
                data = json.dumps({"sequence": cursor, **item["data"]}, separators=(",", ":"), allow_nan=False)
                yield f'id: {cursor}\nevent: {item["event_type"]}\ndata: {data}\n\n'
            if status in store.TERMINAL_STATUSES and len(page) < 100:
                return
            if time.monotonic() > deadline or await request.is_disconnected():
                return
            if time.monotonic() - heartbeat >= 10:
                yield ": keepalive\n\n"
                heartbeat = time.monotonic()
            await asyncio.sleep(0.25)
            page, status = await run_in_threadpool(read_page, cursor)

    return StreamingResponse(stream(), media_type="text/event-stream", headers={"X-Accel-Buffering": "no"})


def _catalogue(ctx: Any, kind: str, q: str, limit: int, offset: int) -> dict[str, Any]:
    records = catalog.read_catalog(ctx.settings.lab_catalog_dir, kind)
    selected = [record for record in records if q.casefold() in " ".join(str(record.get(key, "")) for key in ("id", "label", "name", "kind", "formula")).casefold()]
    return {"items": selected[offset:offset + limit], "total": len(selected), "limit": limit, "offset": offset, "catalogStatus": "CURATED"}


@router.get("/equipment-definitions")
def equipment(ctx: Ctx, principal: Reader, q: str = Query(default="", max_length=200), limit: int = Query(default=50, ge=1, le=100), offset: int = Query(default=0, ge=0)) -> dict[str, Any]:
    return _catalogue(ctx, "equipment", q, limit, offset)


@router.get("/reagents")
def reagents(ctx: Ctx, principal: Reader, q: str = Query(default="", max_length=200), limit: int = Query(default=25, ge=1, le=100), offset: int = Query(default=0, ge=0)) -> dict[str, Any]:
    page = _catalogue(ctx, "reagents", q, limit, offset)
    page["catalogueLinks"] = {record["id"]: catalog.catalogue_links(record) for record in page["items"]}
    return page


@router.post("/templates", response_model=TemplateResource, status_code=201)
def create_template(body: TemplateCreate, ctx: Ctx, principal: Writer, key: str | None = Header(default=None, alias="Idempotency-Key")) -> JSONResponse:
    key = idempotency_key(key)
    try:
        scene_id = UUID(body.sceneId)
    except ValueError as exc:
        raise LabProblem(422, "INVALID_SCENE_ID", "sceneId must be a UUID.") from exc
    digest = request_hash(body.model_dump())
    with ctx.db.connection() as conn:
        store.lock_owner(conn, principal.owner_id)
        previous = store.recall(conn, principal.owner_id, "/templates", key, digest)
        if previous:
            return _recalled(previous)
        saved = store.scene_row(conn, scene_id, principal.owner_id)
        store.revision_matches(saved, body.expectedRevision)
        total = conn.execute("SELECT count(*) AS n FROM lab_template WHERE owner_id=%s", (principal.owner_id,)).fetchone()["n"]
        if total >= ctx.settings.lab_max_scenes_per_owner:
            raise LabProblem(429, "TEMPLATE_QUOTA_EXCEEDED", "The configured reusable template quota was reached.")
        row = conn.execute(
            "INSERT INTO lab_template(id,owner_id,title,kind,scene,catalog_snapshot,source_id) VALUES (%s,%s,%s,%s,%s,%s,%s) "
            'RETURNING id,title,kind,scene,catalog_snapshot AS "catalogSnapshot",created_at AS "createdAt"',
            (uuid4(), principal.owner_id, _title(body.title), body.kind, Jsonb(saved["scene"]), Jsonb(saved["catalog_snapshot"]), ctx.user_source_id),
        ).fetchone()
        resource = jsonable_encoder(row)
        store.remember(conn, principal.owner_id, "/templates", key, digest, resource, 201)
    return JSONResponse(status_code=201, content=resource)


@router.get("/templates", response_model=Page[TemplateResource])
def templates(ctx: Ctx, principal: Reader, q: str = Query(default="", max_length=200), limit: int = Query(default=10, ge=1, le=25), offset: int = Query(default=0, ge=0)) -> dict[str, Any]:
    with ctx.db.connection() as conn:
        params = (principal.owner_id, q)
        total = conn.execute("SELECT count(*) AS n FROM lab_template WHERE owner_id=%s AND position(lower(%s) in lower(title))>0", params).fetchone()["n"]
        rows = conn.execute(
            'SELECT id,title,kind,scene,catalog_snapshot AS "catalogSnapshot",created_at AS "createdAt" FROM lab_template '
            "WHERE owner_id=%s AND position(lower(%s) in lower(title))>0 ORDER BY created_at DESC,id LIMIT %s OFFSET %s", (*params, limit, offset),
        ).fetchall()
    return {"items": rows, "total": total, "limit": limit, "offset": offset}


@router.post("/templates/{template_id}/instantiate", response_model=SceneResource, status_code=201)
def instantiate_template(template_id: UUID, ctx: Ctx, principal: Writer, body: DuplicateRequest | None = None, key: str | None = Header(default=None, alias="Idempotency-Key")) -> JSONResponse:
    body = body or DuplicateRequest()
    key = idempotency_key(key)
    route = f"/templates/{template_id}/instantiate"
    digest = request_hash(body.model_dump())
    with ctx.db.connection() as conn:
        store.lock_owner(conn, principal.owner_id)
        previous = store.recall(conn, principal.owner_id, route, key, digest)
        if previous:
            return _recalled(previous)
        template = conn.execute("SELECT * FROM lab_template WHERE id=%s AND owner_id=%s", (template_id, principal.owner_id)).fetchone()
        if template is None:
            raise LabProblem(404, "TEMPLATE_NOT_FOUND", "The reusable laboratory template was not found.")
        scene = duplicated_scene(template["scene"])
        validate_scene(scene, ctx.settings.lab_schema_path, ctx.settings.lab_validator_path, ctx.settings.lab_node_binary, ctx.settings.lab_validation_timeout_seconds)
        row = _create_row(ctx, conn, principal.owner_id, _title(body.title) if body.title else template["title"], scene, None, template["catalog_snapshot"])
        store.remember(conn, principal.owner_id, route, key, digest, store.scene_resource(row), 201, '"1"')
    return _scene_response(row, 201)


@router.get("/scenes/{scene_id}/export", response_class=Response)
def export_scene(scene_id: UUID, ctx: Ctx, principal: Exporter, format: Literal["xlsx", "json"] = "json", run_id: UUID | None = Query(default=None, alias="runId")) -> Response:
    from ..lab.exports import export_document, export_workbook

    with ctx.db.connection() as conn:
        conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        scene = store.scene_row(conn, scene_id, principal.owner_id)
        if run_id is not None:
            run = store.run_row(conn, run_id, principal.owner_id)
            if run["scene_id"] != scene_id:
                raise LabProblem(404, "RUN_NOT_FOUND", "This run does not belong to the requested scene.")
            runs = [run]
        else:
            size = conn.execute(
                "SELECT count(*) AS n,coalesce(sum(octet_length(input_snapshot::text)+octet_length(coalesce(result,'{}')::text)"
                "+octet_length(coalesce(checkpoint,'{}')::text)+octet_length(catalog_snapshot::text)+octet_length(coalesce(learning_state_snapshot,'{}')::text)"
                "+octet_length(coalesce(editor_state_snapshot,'{}')::text)),0) AS bytes "
                "FROM lab_run WHERE scene_id=%s AND owner_id=%s", (scene_id, principal.owner_id),
            ).fetchone()
            if size["n"] > 100 or size["bytes"] > 60 * 1024 * 1024:
                raise LabProblem(413, "EXPORT_LIMIT", "Select one run with runId; the full scene history exceeds this export's count or byte limit.")
            runs = conn.execute("SELECT * FROM lab_run WHERE scene_id=%s AND owner_id=%s ORDER BY created_at,id LIMIT 101", (scene_id, principal.owner_id)).fetchall()
        if len(runs) > 100:
            raise LabProblem(413, "EXPORT_LIMIT", "Select one run with runId; a single export is limited to 100 runs.")
        document = export_document(scene, runs)
    if format == "json":
        content = canonical_bytes(document)
        media_type = "application/json"
    else:
        content = export_workbook(document)
        media_type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    if len(content) > 64 * 1024 * 1024:
        raise LabProblem(413, "EXPORT_LIMIT", "The export exceeds 64 MiB. Scope it to one run.")
    return Response(content=content, media_type=media_type, headers={
        "Content-Disposition": f'attachment; filename="matterlab-lab-{scene_id}.{format}"', "ETag": f'"{scene["revision"]}"', "X-MatterLab-Schema-Version": "1",
    })
