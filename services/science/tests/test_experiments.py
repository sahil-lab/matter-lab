"""Tier 5: experiments can be saved, reopened, changed and reproduced."""

from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from .helpers import Contract, is_error_shape, run_job, smiles, wait_for_job

PAYLOAD = {
    "title": "Ethanol study",
    "description": "Geometry and conformers of ethanol",
    "kind": "molecule",
    "inputs": {
        "structure": smiles("CCO"),
        "scene": {"atoms": [{"id": 1, "protons": 8, "position": [0.0, 0.1, -2.5e-7]}], "label": "été – 分子 ✓"},
        "nested": {"list": [1, 2.5, None, True, {"deep": []}]},
    },
    "settings": {"force_field": "auto", "max_iterations": 2000, "temperature_k": 298.15},
    "results": {"note": "client-side only", "values": [1.0, 2.0]},
    "notes": "First try.\nSecond line.",
    "tags": ["demo", "ethanol", "demo"],
}


def test_save_and_reopen_round_trip(client: TestClient, contract: Contract) -> None:
    response = client.post("/v1/experiments", json=PAYLOAD)
    created = contract.check("POST", "/v1/experiments", response)
    assert response.status_code == 201
    assert created["revision"] == 1 and created["calculations"] == [] and created["tags"] == ["demo", "ethanol"]
    assert created["provenance"]["source_key"] == "matterlab-user" and created["provenance"]["kind"] == "user"

    reopened = contract.check("GET", "/v1/experiments/{experiment_id}", client.get(f"/v1/experiments/{created['id']}"))
    assert reopened == created
    # What was saved is what comes back, exactly.
    for key in ("title", "description", "kind", "inputs", "settings", "results", "notes"):
        assert reopened[key] == PAYLOAD[key], key
    assert reopened["created_at"].endswith("Z") and reopened["created_at"] == reopened["updated_at"]
    assert client.delete(f"/v1/experiments/{created['id']}").status_code == 204


def test_experiment_with_calculations_can_be_reproduced(client: TestClient, contract: Contract) -> None:
    optimisation = run_job(client, "rdkit.geometry_optimization", {"structure": smiles("CCO")})
    conformers = run_job(client, "rdkit.conformer_search", {"structure": smiles("CCO")}, {"num_conformers": 5})
    assert optimisation["status"] == conformers["status"] == "succeeded"

    created = client.post("/v1/experiments", json={**PAYLOAD, "calculation_ids": [optimisation["id"], conformers["id"], optimisation["id"]]}).json()
    linked = created["calculations"]
    assert [c["id"] for c in linked] == [optimisation["id"], conformers["id"]], "links keep their order and are not duplicated"
    assert linked[0]["input_hash"] == optimisation["input_hash"] and linked[0]["status"] == "succeeded" and linked[0]["converged"] is True
    assert linked[0]["engine"] == optimisation["engine"] and linked[0]["method"] == "MMFF94" and linked[1]["kind"] == "rdkit.conformer_search"

    # Everything needed to repeat the work is reachable from the reopened experiment.
    reopened = client.get(f"/v1/experiments/{created['id']}").json()
    stored_job = client.get(f"/v1/jobs/{reopened['calculations'][0]['id']}").json()
    assert stored_job["input"] == optimisation["input"] and stored_job["settings"] == optimisation["settings"]

    response = client.post(f"/v1/experiments/{created['id']}/rerun")
    rerun = contract.check("POST", "/v1/experiments/{experiment_id}/rerun", response)
    assert response.status_code == 202 and len(rerun["submitted"]) == 2
    assert [c["input_hash"] for c in rerun["submitted"]] == [optimisation["input_hash"], conformers["input_hash"]]
    assert {c["id"] for c in rerun["submitted"]}.isdisjoint({optimisation["id"], conformers["id"]})
    assert [c["label"] for c in rerun["submitted"]] == [f"rerun of {optimisation['id']}", f"rerun of {conformers['id']}"]
    assert len(rerun["experiment"]["calculations"]) == 4 and rerun["experiment"]["revision"] == created["revision"] + 1

    repeated = [wait_for_job(client, c["id"]) for c in rerun["submitted"]]
    assert all(job["status"] == "succeeded" for job in repeated)
    # Same request, same engine version: the repetition reproduces the original numbers.
    assert repeated[0]["engine"] == optimisation["engine"]
    assert repeated[0]["result"]["energy_final_kcal_per_mol"] == pytest.approx(optimisation["result"]["energy_final_kcal_per_mol"], abs=1e-9)
    assert repeated[0]["result"]["atoms"] == optimisation["result"]["atoms"]
    assert [c["energy_kcal_per_mol"] for c in repeated[1]["result"]["conformers"]] == pytest.approx(
        [c["energy_kcal_per_mol"] for c in conformers["result"]["conformers"]], abs=1e-9
    )

    # Deleting the experiment keeps the calculations.
    assert client.delete(f"/v1/experiments/{created['id']}").status_code == 204
    assert client.get(f"/v1/jobs/{optimisation['id']}").status_code == 200


def test_update_and_revision_control(client: TestClient, contract: Contract) -> None:
    created = client.post("/v1/experiments", json=PAYLOAD).json()
    time.sleep(0.01)
    patched = contract.check(
        "PATCH",
        "/v1/experiments/{experiment_id}",
        client.patch(f"/v1/experiments/{created['id']}", json={"title": "Ethanol study (revised)", "results": {"energy_kcal_per_mol": -1.5}, "expected_revision": 1}),
    )
    assert patched["revision"] == 2 and patched["title"] == "Ethanol study (revised)" and patched["results"] == {"energy_kcal_per_mol": -1.5}
    assert patched["inputs"] == PAYLOAD["inputs"] and patched["notes"] == PAYLOAD["notes"], "fields that were not sent are untouched"
    assert patched["updated_at"] > patched["created_at"] == created["created_at"]

    stale = client.patch(f"/v1/experiments/{created['id']}", json={"title": "lost update", "expected_revision": 1})
    conflict = contract.check("PATCH", "/v1/experiments/{experiment_id}", stale)
    assert stale.status_code == 409 and is_error_shape(conflict) and conflict["error"]["code"] == "revision_conflict"
    assert conflict["error"]["details"] == {"current_revision": 2, "expected_revision": 1}
    assert client.get(f"/v1/experiments/{created['id']}").json()["title"] == "Ethanol study (revised)"

    replaced = contract.check(
        "PUT", "/v1/experiments/{experiment_id}", client.put(f"/v1/experiments/{created['id']}", json={"title": "Replaced", "inputs": {"only": "this"}})
    )
    assert replaced["revision"] == 3 and replaced["title"] == "Replaced" and replaced["inputs"] == {"only": "this"}
    assert replaced["settings"] == {} and replaced["results"] == {} and replaced["notes"] is None and replaced["tags"] == [], "PUT replaces every field"

    assert client.patch(f"/v1/experiments/{created['id']}", json={"title": None}).status_code == 422
    assert client.patch(f"/v1/experiments/{created['id']}", json={"unknown": 1}).status_code == 422
    assert client.put(f"/v1/experiments/{created['id']}", json={"description": "no title"}).status_code == 422
    unknown_link = client.patch(f"/v1/experiments/{created['id']}", json={"calculation_ids": ["00000000-0000-4000-8000-000000000000"]})
    assert unknown_link.status_code == 422 and unknown_link.json()["error"]["code"] == "unknown_reference"
    assert client.get(f"/v1/experiments/{created['id']}").json()["revision"] == 3, "a refused update changes nothing"
    assert client.delete(f"/v1/experiments/{created['id']}").status_code == 204


def test_list_filter_and_delete(client: TestClient, contract: Contract) -> None:
    first = client.post("/v1/experiments", json={"title": "Alpha benzene run", "kind": "molecule", "tags": ["aromatic"]}).json()
    second = client.post("/v1/experiments", json={"title": "Beta reaction run", "kind": "reaction", "tags": ["kinetics", "aromatic"]}).json()
    listing = contract.check("GET", "/v1/experiments", client.get("/v1/experiments", params={"limit": 500}))
    ids = [e["id"] for e in listing["items"]]
    assert ids.index(second["id"]) < ids.index(first["id"]), "most recently updated first"
    assert {e["id"] for e in client.get("/v1/experiments", params={"tag": "aromatic"}).json()["items"]} >= {first["id"], second["id"]}
    assert [e["id"] for e in client.get("/v1/experiments", params={"tag": "kinetics"}).json()["items"]] == [second["id"]]
    assert [e["id"] for e in client.get("/v1/experiments", params={"kind": "reaction", "q": "BETA"}).json()["items"]] == [second["id"]]
    summary = next(e for e in listing["items"] if e["id"] == first["id"])
    assert summary["calculation_count"] == 0 and "inputs" not in summary

    deleted = client.delete(f"/v1/experiments/{first['id']}")
    contract.check("DELETE", "/v1/experiments/{experiment_id}", deleted)
    assert deleted.status_code == 204
    for method, path in (("GET", f"/v1/experiments/{first['id']}"), ("DELETE", f"/v1/experiments/{first['id']}"), ("PATCH", f"/v1/experiments/{first['id']}"), ("POST", f"/v1/experiments/{first['id']}/rerun")):
        response = client.request(method, path, json={"title": "x"} if method == "PATCH" else None)
        assert response.status_code == 404 and is_error_shape(response.json()), (method, path)
    assert client.delete(f"/v1/experiments/{second['id']}").status_code == 204

    before = client.get("/v1/experiments").json()["total"]
    blank = client.post("/v1/experiments", json={"title": "   "})
    assert blank.status_code == 422 and is_error_shape(blank.json()), "a title of only spaces is not a title"
    assert client.get("/v1/experiments").json()["total"] == before
