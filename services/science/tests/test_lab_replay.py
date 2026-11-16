"""The real Python -> bundled Agent07 runtime -> Agent06 chemistry path, without a fake database."""

from __future__ import annotations

import copy
from dataclasses import replace
from typing import Any

import pytest

from matterlab_science.config import load_settings
from matterlab_science.lab.catalog import run_catalog_snapshot
from matterlab_science.lab.runner import bundle_fingerprint, execute_bundle
from matterlab_science.lab.validation import decode_json, run_input_hash

from .lab_helpers import identifier


def titration_request() -> tuple[dict[str, Any], str, str, str]:
    settings = load_settings()
    seed = decode_json((settings.lab_catalog_dir / "starter-scene.json").read_bytes())
    scene = seed["scene"]
    source = next(instance for instance in scene["apparatus"] if instance["definitionId"] == "burette-50ml")
    receiver = next(instance for instance in scene["apparatus"] if instance["definitionId"] == "conical-flask-250ml")
    blank = next(station["id"] for station in scene["stations"] if station["id"] != source["stationId"])
    payload = {
        "schemaVersion": 1, "runId": identifier(900000), "contractVersion": settings.lab_contract_version,
        "runtimeVersion": settings.lab_runtime_version, "methodVersion": settings.lab_method_version, "initialScene": scene,
        "steps": [
            *seed["suggestedSteps"],
            seed["suggestedSteps"][0],  # Identical command retry must not append a second receipt.
            {"kind": "CONTROL", "control": {"controlId": identifier(900001), "stationId": source["stationId"], "atSimulationS": 0,
                                          "type": "RESUME", "payload": {}}},
            {"kind": "ACTION", "action": {"actionId": identifier(900002), "targetInstanceId": source["id"], "atSimulationS": 0,
                                        "type": "SET_VALVE", "payload": {"openingFraction": 1}}},
            {"kind": "ADVANCE", "stationId": source["stationId"], "ticks": 250},
        ],
    }
    return payload, source["id"], receiver["id"], blank


def test_real_shared_replay_equivalence_inventory_and_idempotent_receipts() -> None:
    settings = replace(load_settings(), lab_validation_timeout_seconds=45)
    assert settings.lab_runner_path.is_file(), "Build the actual @matterlab/lab-runtime package before testing backend replay."
    payload, source_id, receiver_id, blank_id = titration_request()
    response = execute_bundle(payload, settings, bundle_fingerprint(settings.lab_runner_path), lambda: False)
    result = response["result"]
    assert result["status"] == "SUCCEEDED", result
    assert result["inputHash"] == run_input_hash(payload)
    observations = [item for item in result["observations"] if item["type"] == "PH" and item.get("apparatusId") == receiver_id]
    assert observations and observations[-1]["quantity"]["value"] == pytest.approx(7, abs=1e-8)
    assert observations[-1]["evidence"] == "MODEL_CALCULATED"
    sources = {source["id"] for source in run_catalog_snapshot({}, settings.lab_catalog_dir)["sources"]}
    assert set(observations[-1]["sourceIds"]).issubset(sources)
    assert observations[-1]["titration"]["deliveredVolumeL"] == pytest.approx(0.025, abs=1e-12)
    snapshot = response["checkpoint"]["snapshot"]
    assert snapshot["scene"]["containerStates"][source_id]["volumeL"] == pytest.approx(0.025, abs=1e-12)
    assert snapshot["scene"]["containerStates"][receiver_id]["volumeL"] == pytest.approx(0.05, abs=1e-12)
    assert snapshot["stationStates"][blank_id]["tick"] == 0
    retried_id = payload["steps"][0]["action"]["actionId"]
    applied = [event for event in response["checkpoint"]["events"] if event["type"] == "ACTION" and event["action"]["actionId"] == retried_id]
    assert len(applied) == 1 and applied[0]["receipt"]["status"] == "APPLIED"


def test_real_shared_runner_keeps_unsupported_chemistry_explicit() -> None:
    settings = replace(load_settings(), lab_validation_timeout_seconds=45)
    payload, _, _, _ = titration_request()
    payload = copy.deepcopy(payload)
    payload["initialScene"]["simulationConfig"]["methodId"] = "not-an-implemented-method"
    payload["steps"] = []
    result = execute_bundle(payload, settings, bundle_fingerprint(settings.lab_runner_path), lambda: False)["result"]
    assert result["status"] == "UNSUPPORTED"
    assert result["observations"] == [] and result["error"]["code"] == "UNSUPPORTED_MODEL"
