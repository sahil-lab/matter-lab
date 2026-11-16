from __future__ import annotations

import copy
import hashlib
import io
import json
import shutil
import subprocess
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from openpyxl import load_workbook

from matterlab_science.config import load_settings
from matterlab_science.lab.auth import configured_principals, require_action_actors
from matterlab_science.lab.exports import SHEETS, export_document, export_workbook
from matterlab_science.lab.problems import LabProblem
from matterlab_science.lab.runner import RunnerFailure, bundle_fingerprint, execute_bundle, terminal_result
from matterlab_science.lab.validation import (
    UNITS_POLICY, canonical_bytes, decode_json, duplicated_scene, run_input_hash,         validate_checkpoint, validate_contract, validate_editor_state, validate_learning_state, validate_scene,
)
from matterlab_science.main import create_app

from .lab_helpers import OWNER_A, checkpoint_fixture, identifier, request_fixture, scene_fixture


@pytest.fixture(autouse=True)
def shared_host_validation_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    # Process startup can be slow on the shared Windows host; production stays bounded at 5 s.
    monkeypatch.setenv("MATTERLAB_LAB_VALIDATION_TIMEOUT_SECONDS", "45")


def test_shared_schema_semantics_and_roundtrip() -> None:
    settings = load_settings()
    scene = scene_fixture()
    validate_scene(scene, settings.lab_schema_path, settings.lab_validator_path)
    assert decode_json(canonical_bytes(scene)) == scene
    checkpoint = checkpoint_fixture(scene)
    validate_checkpoint(checkpoint, scene, settings.lab_schema_path, settings.lab_validator_path)
    broken = copy.deepcopy(scene)
    broken["apparatus"][0]["transform"]["quaternion"] = [0, 0, 0, 0.5]
    with pytest.raises(LabProblem, match="semantic"):
        validate_scene(broken, settings.lab_schema_path, settings.lab_validator_path)
    broken = copy.deepcopy(scene)
    broken["apparatus"][0]["stationId"] = identifier(3)
    with pytest.raises(LabProblem, match="semantic"):
        validate_scene(broken, settings.lab_schema_path, settings.lab_validator_path)
    checkpoint["snapshot"]["scene"]["containerStates"][identifier(5)]["volumeL"] = 0.026
    with pytest.raises(LabProblem) as error:
        validate_checkpoint(checkpoint, scene, settings.lab_schema_path, settings.lab_validator_path)
    assert error.value.code == "CHECKPOINT_SCENE_MISMATCH"


@pytest.mark.parametrize("text", ['{"x":NaN}', '{"x":Infinity}', '{"x":1,"x":2}', '{"__proto__":{}}', '{"x":"\\ud800"}'])
def test_noninteroperable_json_is_rejected(text: str) -> None:
    with pytest.raises(LabProblem):
        decode_json(text)


def test_duplicate_remaps_every_local_reference_without_touching_original() -> None:
    source = scene_fixture()
    before = copy.deepcopy(source)
    duplicate = duplicated_scene(source)
    assert source == before
    assert duplicate["id"] != source["id"] and duplicate["revision"] == 1
    old_ids = {source["id"], *(item["id"] for item in source["stations"]), *(item["id"] for item in source["apparatus"]), *(item["id"] for item in source["connections"])}
    assert not any(identifier in canonical_bytes(duplicate).decode() for identifier in old_ids)
    source_vessel, receiver = duplicate["apparatus"]
    assert duplicate["connections"][0]["from"]["instanceId"] == source_vessel["id"]
    assert source_vessel["config"]["selectedContainer"] == receiver["id"]
    assert duplicate["containerStates"][receiver["id"]] == source["containerStates"][identifier(5)]


def test_jcs_hash_matches_actual_typescript_for_keys_numbers_unicode_and_ignores_only_run_id() -> None:
    request = request_fixture()
    request["initialScene"]["viewport"] = {"2": 1, "10": 2, "\ue000": "private", "\U00010000": "supplementary", "minusZero": -0.0, "tiny": 1e-7, "large": 1e21}
    node = shutil.which("node")
    assert node is not None, "Node 22.12+ is required for cross-language replay contracts"
    result = subprocess.run([node, str(load_settings().lab_validator_path), "--hash"],
                            input=canonical_bytes(request), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10, check=True)
    assert result.stdout.decode() == run_input_hash(request)
    changed_id = {**request, "runId": identifier(21)}
    assert run_input_hash(changed_id) == run_input_hash(request)
    assert run_input_hash({**request, "runtimeVersion": "2.0.0"}) != run_input_hash(request)


def test_lab_and_legacy_requests_without_lifespan_database() -> None:
    token = "test-bearer-not-a-production-secret"
    settings = replace(load_settings(), lab_auth_tokens_json=json.dumps([{"sha256": hashlib.sha256(token.encode()).hexdigest(), "ownerId": str(OWNER_A), "scopes": ["lab:read"]}]))
    app = create_app(settings)
    app.state.ctx = SimpleNamespace(settings=settings)
    client = TestClient(app)
    try:
        denied = client.get("/api/v1/lab/capabilities")
        assert denied.status_code == 401 and denied.json()["code"] == "AUTH_REQUIRED"
        assert denied.headers["content-type"].startswith("application/problem+json")
        assert "X-Request-ID" in denied.headers
        allowed = client.get("/api/v1/lab/capabilities", headers={"Authorization": f"Bearer {token}"})
        assert allowed.status_code == 200 and allowed.json()["scopes"] == ["lab:read"]
        scope_denied = client.post("/api/v1/lab/scenes", json={"title": "draft", "scene": scene_fixture()}, headers={"Authorization": f"Bearer {token}"})
        assert scope_denied.status_code == 403 and scope_denied.json()["code"] == "SCOPE_REQUIRED"
        bad_json = client.post("/api/v1/lab/scenes", content='{"scene":1,"scene":2}', headers={"Content-Type": "application/json"})
        assert bad_json.status_code == 422 and bad_json.json()["code"] == "INVALID_JSON"
        old = client.get("/v1/nowhere")
        assert old.status_code == 404 and old.json()["error"]["code"] == "not_found"
        assert client.get("/v1/excel/format").status_code == 200
        seed = client.get("/api/v1/lab/seed-scene", headers={"Authorization": f"Bearer {token}"})
        assert seed.status_code == 200, seed.text
        assert seed.json()["saved"] is False and seed.json()["scene"]["containerStates"] == {}
        assert len(seed.json()["scene"]["stations"]) == 2
        assert all(step["kind"] == "ACTION" and step["action"]["type"] == "FILL" for step in seed.json()["suggestedSteps"])
        again = client.get("/api/v1/lab/seed-scene", headers={"Authorization": f"Bearer {token}"}).json()
        assert again["scene"]["id"] != seed.json()["scene"]["id"]
        catalogue = client.get("/api/v1/lab/reagents?q=hcl", headers={"Authorization": f"Bearer {token}"})
        assert catalogue.status_code == 200 and catalogue.json()["catalogStatus"] == "CURATED"
        assert catalogue.json()["items"][0]["id"] == "hcl"
        assert token not in repr(settings)
        assert len(configured_principals(settings.lab_auth_tokens_json)) == 1
        document = app.openapi()
        assert document["components"]["schemas"]["SceneResource"]["properties"]["scene"]["$ref"].endswith("LabExperimentScene")
        assert "/v1/experiments" in document["paths"] and "/api/v1/lab/scenes" in document["paths"]
    finally:
        client.close()


def test_excel_sheets_types_provenance_formula_safety_and_no_inferred_curve_volume() -> None:
    scene = scene_fixture()
    scene["revision"] = 1
    now = datetime.now(timezone.utc)
    saved = {"scene": scene, "runtime_checkpoint": None, "title": "=HYPERLINK(\"malicious\")", "revision": 1,
             "created_at": now, "updated_at": now, "catalog_snapshot": {"equipment": [], "reagents": [], "sources": [{"id": "test-source", "title": "Fixture reference", "version": "v1"}]}}
    result = {"runId": identifier(20), "status": "SUCCEEDED", "methodId": "test-only-export-fixture", "methodVersion": "1.0.0", "inputHash": "a" * 64,
              "observations": [{"type": "PH", "apparatusId": identifier(5), "timeS": 0.2, "quantity": {"value": 7.125, "unit": "pH"},
                                "evidence": "UNVERIFIED", "methodId": "test-only-export-fixture", "sourceIds": ["=source-fixture"]}],
              "warnings": ["Synthetic export fixture; not a scientific calculation."], "assumptions": []}
    run = {"id": identifier(20), "scene_id": scene["id"], "scene_revision": 1, "status": "SUCCEEDED", "input_hash": "a" * 64,
           "input_snapshot": request_fixture(), "result": result, "failure_code": None, "cancel_requested": False, "created_at": now,
           "started_at": now, "completed_at": now, "units_policy": UNITS_POLICY, "runner_sha256": "b" * 64, "artifacts": [],
           "catalog_snapshot": {"equipment": [], "reagents": [], "sources": [{"id": "test-source", "title": "Fixture reference", "version": "v2"}]}, "checkpoint": None}
    document = export_document(saved, [run])
    assert decode_json(canonical_bytes(document))["scene"] == scene
    workbook = load_workbook(io.BytesIO(export_workbook(document)), data_only=False)
    try:
        assert tuple(workbook.sheetnames) == SHEETS
        assert workbook["Stations"]["B2"].value == "=Untrusted station"
        assert workbook["Stations"]["B2"].data_type == "s"
        assert workbook["Trial Measurements"]["G2"].value == 7.125
        assert workbook["Trial Measurements"]["G2"].data_type == "n"
        assert workbook["Titration Curve"]["G2"].value is None
        assert workbook["Titration Curve"]["H2"].value == 7.125
        assert "intentionally blank" in workbook["Titration Curve"]["J2"].value
        assert all(cell.data_type != "f" for sheet in workbook for row in sheet for cell in row)
        assert any(row[0].value == "=source-fixture" and "UNVERIFIED" in row[-1].value for row in workbook["Sources"].iter_rows(min_row=2))
        assert {row[4].value for row in workbook["Sources"].iter_rows(min_row=2) if row[0].value == "test-source"} == {"v1", "v2"}
    finally:
        workbook.close()


@pytest.mark.parametrize("mode,code", [("cancel", "RUN_CANCELLED"), ("wait", "RUN_TIMEOUT"), ("overflow", "RUN_OUTPUT_TOO_LARGE")])
def test_real_node_process_cancel_timeout_and_output_limits(mode: str, code: str) -> None:
    fixture = Path(__file__).parent / "data" / "lab-process-fixture.mjs"
    settings = replace(load_settings(), lab_runner_path=fixture, lab_run_timeout_seconds=0.25 if mode == "wait" else 5.0, lab_max_output_bytes=1024)
    with pytest.raises(RunnerFailure) as error:
        execute_bundle({"testMode": mode}, settings, bundle_fingerprint(fixture), lambda: mode == "cancel")
    assert error.value.code == code


def test_infrastructure_failures_have_no_observations_and_match_shared_result_schema() -> None:
    request = request_fixture()
    row = {"id": request["runId"], "method_id": request["initialScene"]["simulationConfig"]["methodId"], "method_version": "1.0.0", "input_hash": run_input_hash(request)}
    result = terminal_result(row, "FAILED", "No runtime bundle was installed.")
    settings = load_settings()
    validate_contract({"schemaVersion": 1, "result": result}, "NodeRunResponse", settings.lab_schema_path, settings.lab_validator_path)
    assert result["observations"] == [] and result["error"]["code"] == "RUNTIME_ERROR"


def test_nonfinite_worker_deadlines_are_configuration_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MATTERLAB_LAB_RUN_TIMEOUT_SECONDS", "NaN")
    with pytest.raises(ValueError, match="finite"):
        load_settings()


def test_learning_sidecar_uses_agent08_parser_and_does_not_accept_scores() -> None:
    state = {"schemaVersion": 1, "kind": "MATTERLAB_LEARNING_STATE", "attempts": []}
    validate_learning_state(state, load_settings())
    with pytest.raises(LabProblem) as error:
        validate_learning_state({**state, "score": 100}, load_settings())
    assert error.value.code == "CONTRACT_VALIDATION_FAILED"
    assert decode_json(canonical_bytes(state)) == state


def test_editor_sidecar_is_scene_bound_and_does_not_accept_domain_inventory() -> None:
    state = {"schemaVersion": 1, "sceneId": identifier(1), "activeStationId": identifier(2),
             "selectedIds": [identifier(4)], "lockedIds": [], "groups": [], "mode": "select",
             "snapM": 0.01, "angleStepDeg": 15, "initialTransforms": {}}
    validate_editor_state(state, identifier(1), load_settings())
    with pytest.raises(LabProblem) as error:
        validate_editor_state(state, identifier(40), load_settings())
    assert error.value.code == "EDITOR_SCENE_MISMATCH"
    with pytest.raises(LabProblem):
        validate_editor_state({**state, "containerStates": {}}, identifier(1), load_settings())


def test_editor_batch_cannot_spoof_another_actors_identity() -> None:
    batch = [{"kind": "ACTION", "action": {"actorId": str(OWNER_A), "type": "CUSTOM",
                                         "payload": {"pluginId": "matterlab:editor-v1", "actionType": "BATCH",
                                                     "data": {"actions": [{"actorId": identifier(999)}]}}}}]
    with pytest.raises(LabProblem) as error:
        require_action_actors(batch, OWNER_A)
    assert error.value.status == 403 and error.value.code == "ACTOR_MISMATCH"


def test_large_payload_still_uses_full_shared_structural_validation() -> None:
    scene = scene_fixture()
    scene["viewport"] = {"notes": ["x" * 4000] * 20}
    scene["invented"] = True
    assert len(canonical_bytes(scene)) > 64 * 1024
    with pytest.raises(LabProblem) as error:
        validate_scene(scene, load_settings().lab_schema_path)
    assert error.value.code == "CONTRACT_VALIDATION_FAILED"
