"""Real PostgreSQL integration; explicitly skipped, never emulated, when this project's DB is down."""

from __future__ import annotations

import copy
import hashlib
import json
import shutil
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Iterator
from uuid import UUID, uuid4

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.conninfo import make_conninfo

from matterlab_science.config import Settings
from matterlab_science.db import Database, Jsonb
from matterlab_science.main import create_app
from matterlab_science.migrations import discover, migrate
from matterlab_science.provenance import ensure_service_source, ensure_user_source

from .lab_helpers import OWNER_A, OWNER_B, checkpoint_fixture, identifier, scene_fixture

AUTH_A = {"Authorization": "Bearer test-owner-a"}
AUTH_B = {"Authorization": "Bearer test-owner-b"}
SCOPES = ["lab:read", "lab:write", "lab:run", "lab:export"]


@pytest.fixture(scope="module")
def live_postgres(base_settings: Settings) -> None:
    try:
        with psycopg.connect(make_conninfo(base_settings.database_conninfo, connect_timeout=2)):
            pass
    except psycopg.OperationalError:
        pytest.skip("Project PostgreSQL is not accepting connections; real DB/API/migration assertions were not executed.")


@pytest.fixture(scope="module")
def lab_env(live_postgres: None, base_settings: Settings, database_factory: Callable[[], str]) -> Iterator[tuple[TestClient, Any]]:
    principals = [{"sha256": hashlib.sha256(token.encode()).hexdigest(), "ownerId": str(owner), "scopes": SCOPES}
                  for token, owner in (("test-owner-a", OWNER_A), ("test-owner-b", OWNER_B))]
    settings = replace(base_settings.with_database(database_factory()), lab_auth_tokens_json=json.dumps(principals),
                       jobs_enabled=False, lab_max_active_runs_per_owner=50, lab_validation_timeout_seconds=45)
    migrate(settings.database_conninfo, settings.migrations_dir)
    db = Database(settings.database_conninfo)
    db.open(timeout_seconds=3)
    with db.connection() as conn:
        user = ensure_user_source(conn)
        service = ensure_service_source(conn)
    app = create_app(settings)
    context = SimpleNamespace(settings=settings, db=db, user_source_id=user, service_source_id=service)
    app.state.ctx = context
    client = TestClient(app)
    try:
        yield client, context
    finally:
        client.close()
        db.close()


def save(client: TestClient, *, checkpoint: bool = False) -> dict[str, Any]:
    scene = scene_fixture()
    scene["id"] = str(uuid4())
    body = {"title": "Integration notebook", "scene": scene, "runtimeCheckpoint": checkpoint_fixture(scene) if checkpoint else None}
    response = client.post("/api/v1/lab/scenes", json=body, headers={**AUTH_A, "Idempotency-Key": str(uuid4())})
    assert response.status_code == 201, response.text
    assert response.headers["ETag"] == '"1"'
    return response.json()


def run(client: TestClient, resource: dict[str, Any]) -> dict[str, Any]:
    response = client.post(f'/api/v1/lab/scenes/{resource["scene"]["id"]}/runs', json={"expectedRevision": resource["scene"]["revision"]},
                           headers={**AUTH_A, "Idempotency-Key": str(uuid4())})
    assert response.status_code == 202, response.text
    return response.json()


def test_create_idempotency_reopen_and_owner_isolation(lab_env: tuple[TestClient, Any]) -> None:
    client, _ = lab_env
    scene = scene_fixture()
    scene["id"] = str(uuid4())
    body = {"title": "Exact roundtrip", "scene": scene}
    headers = {**AUTH_A, "Idempotency-Key": str(uuid4())}
    first = client.post("/api/v1/lab/scenes", json=body, headers=headers)
    again = client.post("/api/v1/lab/scenes", json=body, headers=headers)
    assert first.status_code == again.status_code == 201 and first.json() == again.json()
    assert again.headers["Idempotency-Replayed"] == "true"
    expected = {**scene, "revision": 1}
    assert first.json()["scene"] == expected
    path = f'/api/v1/lab/scenes/{scene["id"]}'
    assert client.get(path, headers=AUTH_A).json() == first.json()
    conflict = client.post("/api/v1/lab/scenes", json={**body, "title": "Changed request"}, headers=headers)
    assert conflict.status_code == 409 and conflict.json()["code"] == "IDEMPOTENCY_CONFLICT"
    assert client.get(path, headers=AUTH_B).status_code == 404
    assert client.get(path + "/export", headers=AUTH_B).status_code == 404
    assert client.patch(path, json={"title": "Other owner"}, headers={**AUTH_B, "If-Match": '"1"'}).status_code == 404
    assert scene["id"] not in {item["id"] for item in client.get("/api/v1/lab/scenes", headers=AUTH_B).json()["items"]}


def test_required_etag_and_concurrent_revision_conflict(lab_env: tuple[TestClient, Any]) -> None:
    client, _ = lab_env
    saved = save(client)
    path = f'/api/v1/lab/scenes/{saved["scene"]["id"]}'
    assert client.patch(path, json={"title": "No revision"}, headers=AUTH_A).status_code == 428
    assert client.patch(path, json={"title": "Wildcard"}, headers={**AUTH_A, "If-Match": "*"}).status_code == 400
    first = client.patch(path, json={"title": "Editor one"}, headers={**AUTH_A, "If-Match": '"1"'})
    assert first.status_code == 200 and first.headers["ETag"] == '"2"'
    second = client.patch(path, json={"title": "Editor two"}, headers={**AUTH_A, "If-Match": '"1"'})
    assert second.status_code == 409 and second.json()["details"]["currentRevision"] == 2
    assert client.get(path, headers=AUTH_A).json()["title"] == "Editor one"


def test_duplicate_and_templates_do_not_cross_link_original(lab_env: tuple[TestClient, Any]) -> None:
    client, _ = lab_env
    saved = save(client, checkpoint=True)
    path = f'/api/v1/lab/scenes/{saved["scene"]["id"]}'
    duplicate = client.post(path + "/duplicate", json={}, headers={**AUTH_A, "Idempotency-Key": str(uuid4())})
    assert duplicate.status_code == 201
    cloned = duplicate.json()
    assert cloned["scene"]["id"] != saved["scene"]["id"] and cloned["runtimeCheckpoint"] is None
    assert cloned["scene"]["apparatus"][0]["id"] != saved["scene"]["apparatus"][0]["id"]
    assert client.get(path, headers=AUTH_A).json() == saved
    template = client.post("/api/v1/lab/templates", json={"sceneId": saved["scene"]["id"], "expectedRevision": 1, "title": "My assembly", "kind": "ASSEMBLY"},
                           headers={**AUTH_A, "Idempotency-Key": str(uuid4())})
    assert template.status_code == 201 and template.json()["scene"] == saved["scene"]
    assert template.json()["id"] not in {item["id"] for item in client.get("/api/v1/lab/templates", headers=AUTH_B).json()["items"]}


def test_saved_checkpoint_uses_initial_inventory_and_preserves_limits(lab_env: tuple[TestClient, Any]) -> None:
    client, _ = lab_env
    saved = save(client, checkpoint=True)
    checkpoint = saved["runtimeCheckpoint"]
    initial = copy.deepcopy(checkpoint["initialScene"])
    current = copy.deepcopy(saved["scene"])
    current["containerStates"][identifier(4)]["volumeL"] -= 0.001
    current["containerStates"][identifier(5)]["volumeL"] += 0.001
    checkpoint["snapshot"]["scene"] = current
    checkpoint["limits"] = {"maxTicks": 100, "maxActions": 100, "maxObservations": 100, "maxSimulationTimeS": 10}
    action = {"actionId": identifier(30), "atSimulationS": 0, "targetInstanceId": identifier(4), "type": "TRANSFER",
              "payload": {"sourceInstanceId": identifier(4), "targetInstanceId": identifier(5), "volumeL": 0.001, "connectionId": identifier(6)}}
    checkpoint["steps"] = [{"kind": "ACTION", "action": action}]
    checkpoint["completedStepCount"] = 1
    checkpoint["snapshot"]["revision"] = 1
    checkpoint["snapshot"]["lastSequence"] = 1
    checkpoint["events"] = [{"type": "ACTION", "runId": checkpoint["snapshot"]["runId"], "sequence": 1, "stationId": identifier(2), "epoch": 0,
                             "action": action, "receipt": {"actionId": identifier(30), "sequence": 1, "runtimeRevision": 1, "stationId": identifier(2), "epoch": 0, "status": "APPLIED"}}]
    path = f'/api/v1/lab/scenes/{saved["scene"]["id"]}'
    changed = client.patch(path, json={"scene": current, "runtimeCheckpoint": checkpoint}, headers={**AUTH_A, "If-Match": '"1"'})
    assert changed.status_code == 200, changed.text
    stored = changed.json()
    assert stored["runtimeCheckpoint"] == checkpoint
    result = run(client, stored)
    assert result["inputSnapshot"]["initialScene"] == initial
    assert result["inputSnapshot"]["steps"] == checkpoint["steps"]
    assert result["inputSnapshot"]["limits"] == checkpoint["limits"]
    assert result["inputSnapshot"]["initialScene"]["containerStates"][identifier(5)]["volumeL"] == 0.025
    stale = client.patch(path, json={"scene": stored["scene"]}, headers={**AUTH_A, "If-Match": '"2"'})
    assert stale.status_code == 409 and stale.json()["code"] == "CHECKPOINT_REQUIRED"
    bad = copy.deepcopy(checkpoint)
    bad["snapshot"]["scene"]["viewport"] = {"mode": "wrong"}
    assert client.patch(path, json={"runtimeCheckpoint": bad}, headers={**AUTH_A, "If-Match": '"2"'}).status_code == 422


def test_run_idempotency_immutable_input_cancel_sse_and_owner_scoped_export(lab_env: tuple[TestClient, Any]) -> None:
    client, ctx = lab_env
    saved = save(client)
    path = f'/api/v1/lab/scenes/{saved["scene"]["id"]}'
    headers = {**AUTH_A, "Idempotency-Key": str(uuid4())}
    body = {"expectedRevision": 1}
    first = client.post(path + "/runs", json=body, headers=headers)
    again = client.post(path + "/runs", json=body, headers=headers)
    assert first.status_code == 202 and first.json() == again.json()
    result = first.json()
    run_path = f'/api/v1/lab/runs/{result["runId"]}'
    with pytest.raises(psycopg.errors.CheckViolation):
        with ctx.db.connection() as conn:
            conn.execute("UPDATE lab_run SET input_snapshot=%s WHERE id=%s", (Jsonb({"runId": result["runId"]}), UUID(result["runId"])))
    for suffix in ("", "/events", "/observations"):
        assert client.get(run_path + suffix, headers=AUTH_B).status_code == 404
    assert client.post(run_path + "/cancel", headers=AUTH_B).status_code == 404
    cancelled = client.post(run_path + "/cancel", headers=AUTH_A)
    assert cancelled.status_code == 200 and cancelled.json()["status"] == "CANCELLED"
    assert client.post(run_path + "/cancel", headers=AUTH_A).json() == cancelled.json()
    assert client.get(run_path + "/observations", headers=AUTH_A).json()["items"] == []
    events = client.get(run_path + "/events", headers=AUTH_A)
    assert events.status_code == 200 and "event: status" in events.text and '"status":"CANCELLED"' in events.text
    last = max(int(line[4:]) for line in events.text.splitlines() if line.startswith("id: "))
    assert client.get(run_path + "/events", headers={**AUTH_A, "Last-Event-ID": str(last)}).text == ""
    with pytest.raises(psycopg.errors.CheckViolation):
        with ctx.db.connection() as conn:
            conn.execute("UPDATE lab_run SET failure_code='late-overwrite' WHERE id=%s", (UUID(result["runId"]),))
    document = client.get(path + f'/export?format=json&runId={result["runId"]}', headers=AUTH_A).json()
    assert document["scene"] == saved["scene"] and len(document["runs"]) == 1
    other = save(client)
    assert client.get(f'/api/v1/lab/scenes/{other["scene"]["id"]}/export?runId={result["runId"]}', headers=AUTH_A).status_code == 404


def test_forward_migration_preserves_existing_v1_rows_and_checksums(live_postgres: None, base_settings: Settings, database_factory: Callable[[], str]) -> None:
    settings = base_settings.with_database(database_factory())
    directory = Path.cwd() / f".lab-migration-fixture-{uuid4().hex}"
    directory.mkdir()
    try:
        baseline = [migration for migration in discover(settings.migrations_dir) if migration.version <= "0005"]
        for migration in baseline:
            shutil.copyfile(migration.path, directory / migration.path.name)
        migrate(settings.database_conninfo, directory)
        with psycopg.connect(settings.database_conninfo) as conn:
            source = conn.execute("INSERT INTO data_sources(key,version,kind,title) VALUES ('upgrade-fixture','1','user','Preserved source') RETURNING id").fetchone()[0]
            old = conn.execute("INSERT INTO experiments(title,inputs,source_id) VALUES ('Existing v1',%s,%s) RETURNING id", (Jsonb({"legacy": [1, 2, 3]}), source)).fetchone()[0]
        upgrade = migrate(settings.database_conninfo, settings.migrations_dir)
        assert "0006" in upgrade.applied
        with psycopg.connect(settings.database_conninfo) as conn:
            assert conn.execute("SELECT title,inputs,revision,source_id FROM experiments WHERE id=%s", (old,)).fetchone() == ("Existing v1", {"legacy": [1, 2, 3]}, 1, source)
            versions = dict(conn.execute("SELECT version,checksum FROM schema_migrations").fetchall())
            assert all(versions[migration.version] == migration.checksum for migration in baseline)
            assert conn.execute("SELECT to_regclass('lab_run'),to_regclass('lab_scene')").fetchone() == ("lab_run", "lab_scene")
    finally:
        shutil.rmtree(directory)
