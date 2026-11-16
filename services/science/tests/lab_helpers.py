"""Small deterministic, explicitly test-only scenes; production seeds come from the shared runtime."""

from __future__ import annotations

import copy
from typing import Any
from uuid import UUID


def identifier(n: int) -> str:
    return f"00000000-0000-4000-8000-{n:012x}"


def scene_fixture() -> dict[str, Any]:
    return {
        "id": identifier(1), "revision": 0, "schemaVersion": 1,
        "stations": [{"id": identifier(2), "name": "=Untrusted station"}, {"id": identifier(3), "name": "Blank station"}],
        "apparatus": [
            {"id": identifier(4), "kind": "BURETTE", "definitionId": "test-burette", "revision": 0, "config": {"selectedContainer": identifier(5)},
             "capabilities": ["CONTAINER", "FLOW_SOURCE"], "stationId": identifier(2), "transform": {"positionM": [0, 1, 0], "quaternion": [0, 0, 0, 1]}},
            {"id": identifier(5), "kind": "FLASK", "definitionId": "test-flask", "revision": 0, "config": {},
             "capabilities": ["CONTAINER", "FLOW_RECEIVER"], "stationId": identifier(2), "transform": {"positionM": [0, 0.9, 0], "quaternion": [0, 0, 0, 1]}},
        ],
        "connections": [{"id": identifier(6), "from": {"instanceId": identifier(4), "socketId": "out"},
                         "to": {"instanceId": identifier(5), "socketId": "in"}, "kind": "FLUID", "enabled": True}],
        "containerStates": {
            identifier(4): {"volumeL": 0.05, "species": [{"speciesId": "ion:sodium", "moles": 0.005, "sourceId": "test-source"}],
                            "temperatureK": 298.15, "mixing": "WELL_MIXED", "modelId": "aqueous-acid-base-ideal-v1"},
            identifier(5): {"volumeL": 0.025, "species": [{"speciesId": "ion:chloride", "moles": 0.0025, "sourceId": "test-source"}],
                            "temperatureK": 298.15, "mixing": "WELL_MIXED", "modelId": "aqueous-acid-base-ideal-v1"},
        },
        "simulationConfig": {"methodId": "aqueous-acid-base-ideal-v1", "timeStepS": 0.1},
        "viewport": {"selectedId": identifier(4)},
    }


def checkpoint_fixture(scene: dict[str, Any] | None = None) -> dict[str, Any]:
    initial = copy.deepcopy(scene or scene_fixture())
    return {
        "schemaVersion": 1, "contractVersion": "1.1.0", "runtimeVersion": "1.0.0", "methodVersion": "1.0.0",
        "inputHash": "a" * 64, "initialScene": initial,
        "snapshot": {
            "schemaVersion": 1, "runId": identifier(20), "revision": 0, "scene": copy.deepcopy(initial),
            "stationStates": {station["id"]: {"stationId": station["id"], "epoch": 0, "status": "PREPARING", "simulationTimeS": 0, "tick": 0, "speed": 1} for station in initial["stations"]},
            "apparatusStates": {}, "transferTotals": [], "observations": [], "lastSequence": 0,
        },
        "steps": [], "completedStepCount": 0, "events": [],
    }


def request_fixture() -> dict[str, Any]:
    return {
        "schemaVersion": 1, "runId": identifier(20), "contractVersion": "1.1.0", "runtimeVersion": "1.0.0", "methodVersion": "1.0.0",
        "initialScene": scene_fixture(), "steps": [],
    }


OWNER_A = UUID(identifier(100))
OWNER_B = UUID(identifier(101))
