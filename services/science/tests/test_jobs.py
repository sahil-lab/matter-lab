"""Tier 3: asynchronous jobs in real worker processes."""

from __future__ import annotations

import hashlib
import json
import math
import os
import signal
import time
from dataclasses import replace
from datetime import datetime

import pytest
from fastapi.testclient import TestClient
from rdkit import rdBase

from matterlab_science.config import Settings
from matterlab_science.context import AppContext
from matterlab_science.db import Database
from matterlab_science.jobs.hashing import canonical_json, input_hash
from matterlab_science.jobs.kinds import KINDS
from matterlab_science.main import create_app

from .helpers import LONG_CHAIN, PENTAVALENT_CARBON, WATER_ATOMS, Contract, is_error_shape, process_alive, run_job, smiles, submit, wait_for_job, wait_until_dead

LONG_JOB = {"num_conformers": 2000, "max_iterations": 100000}


def _parse(timestamp: str) -> datetime:
    return datetime.fromisoformat(timestamp.replace("Z", "+00:00"))


def _start_long_job(client: TestClient, **extra: object) -> dict:
    job = submit(client, "rdkit.conformer_search", {"structure": smiles(LONG_CHAIN)}, LONG_JOB, **extra)
    running = wait_for_job(client, job["id"], statuses=("running", "failed", "cancelled", "succeeded", "unsupported"), timeout=60)
    assert running["status"] == "running", running
    deadline = time.monotonic() + 30
    while running["worker_pid"] is None and time.monotonic() < deadline:
        time.sleep(0.05)
        running = client.get(f"/v1/jobs/{job['id']}").json()
    assert running["worker_pid"] is not None
    return running


# ---------------------------------------------------------------------------------------------
# Lifecycle and contract
# ---------------------------------------------------------------------------------------------


def test_job_lifecycle_geometry_optimization(client: TestClient, contract: Contract) -> None:
    response = client.post("/v1/jobs", json={"kind": "rdkit.geometry_optimization", "input": {"structure": smiles("CCO")}})
    accepted = contract.check("POST", "/v1/jobs", response)
    assert response.status_code == 202
    assert accepted["status"] in ("queued", "running")
    assert accepted["result"] is None and accepted["error"] is None and accepted["finished_at"] is None
    assert accepted["engine"] == {"id": "rdkit", "version": rdBase.rdkitVersion}
    # Defaults are filled in and stored: this is the canonical request that is hashed.
    assert accepted["settings"]["force_field"] == "auto" and accepted["settings"]["max_iterations"] == 2000

    job = wait_for_job(client, accepted["id"])
    contract.check("GET", "/v1/jobs/{job_id}", client.get(f"/v1/jobs/{job['id']}"))
    assert job["status"] == "succeeded", job["error"]
    assert job["progress"] == 1.0 and job["converged"] is True and job["method"] == "MMFF94"
    assert job["error"] is None and job["cancel_requested"] is False and job["origin"] == "service"
    assert _parse(job["created_at"]) <= _parse(job["started_at"]) <= _parse(job["finished_at"])
    assert job["duration_seconds"] >= 0
    assert job["created_at"].endswith("Z")
    assert job["software"]["rdkit"] == rdBase.rdkitVersion and "python" in job["software"]
    assert job["provenance"]["source_key"] == "rdkit" and job["provenance"]["version"] == rdBase.rdkitVersion and job["provenance"]["kind"] == "software"
    texts = [m["text"] for m in job["messages"]]
    assert texts[0] == "Queued." and any(t.startswith("Started in worker process") for t in texts) and texts[-1].startswith("Finished in")
    assert job["worker_pid"] is not None and not process_alive(job["worker_pid"]), "the worker exits when its job is done"

    result = job["result"]
    KINDS["rdkit.geometry_optimization"].result_model.model_validate(result)
    assert result["structure"]["canonical_smiles"] == "CCO" and result["structure"]["atom_count"] == 9
    assert result["starting_geometry"]["source"] == "generated" and result["starting_geometry"]["embedding"]["method"] == "ETKDGv3"
    assert result["force_field"] == {"requested": "auto", "used": "MMFF94", "fallback_reason": None, "interfragment_interactions": "included"}
    assert result["converged"] is True
    assert result["energy_final_kcal_per_mol"] < result["energy_initial_kcal_per_mol"]
    assert result["energy_change_kcal_per_mol"] == pytest.approx(result["energy_final_kcal_per_mol"] - result["energy_initial_kcal_per_mol"])
    assert result["gradient_rms_final_kcal_per_mol_angstrom"] < 0.01 < result["gradient_rms_initial_kcal_per_mol_angstrom"]
    assert result["units"] == {"coordinates": "angstrom", "energy": "kcal/mol", "gradient": "kcal/(mol*angstrom)"}
    assert len(result["atoms"]) == 9 and len(result["bonds"]) == 8
    assert result["trajectory"] is None and result["iterations"] is None


def test_input_coordinates_are_used_as_the_starting_geometry(client: TestClient) -> None:
    generated = client.post("/v1/chem/3d", json={"structure": smiles("CCO"), "force_field": "none"}).json()
    job = run_job(client, "rdkit.geometry_optimization", {"structure": {"format": "molblock", "data": generated["molblock"]}})
    assert job["status"] == "succeeded"
    result = job["result"]
    assert result["starting_geometry"]["source"] == "input-coordinates" and result["starting_geometry"]["hydrogens_added"] == 0
    assert [a["added_hydrogen"] for a in result["atoms"]] == [False] * 9
    moved = max(math.dist((a["x"], a["y"], a["z"]), (b["x"], b["y"], b["z"])) for a, b in zip(result["atoms"], generated["atoms"]))
    assert 0 < moved < 1.0, "the optimisation starts from, and stays near, the supplied geometry"


def test_trajectory_is_a_replay_of_the_same_minimisation(client: TestClient) -> None:
    structure = {"structure": smiles("CC(C)Cc1ccc(cc1)C(C)C(=O)O")}
    plain = run_job(client, "rdkit.geometry_optimization", structure)
    traced = run_job(client, "rdkit.geometry_optimization", structure, {"record_trajectory": True, "trajectory_max_frames": 12})
    assert plain["status"] == traced["status"] == "succeeded"
    a, b = plain["result"], traced["result"]
    # Recording a trajectory must not change the answer.
    flat = lambda atoms: [value for atom in atoms for value in (atom["x"], atom["y"], atom["z"])]  # noqa: E731
    assert b["energy_final_kcal_per_mol"] == pytest.approx(a["energy_final_kcal_per_mol"], abs=1e-9)
    assert flat(b["atoms"]) == pytest.approx(flat(a["atoms"]), abs=1e-9)
    assert a["iterations"] is None and isinstance(b["iterations"], int) and 1 <= b["iterations"] <= b["max_iterations"]

    trajectory = b["trajectory"]
    frames = trajectory["frames"]
    assert trajectory["energy_unit"] == "kcal/mol" and 2 <= len(frames) <= 13 and trajectory["frames_returned"] == len(frames)
    assert frames[0]["iteration"] == 0 and frames[0]["energy"] == pytest.approx(b["energy_initial_kcal_per_mol"], abs=1e-9)
    assert frames[-1]["iteration"] == b["iterations"] and frames[-1]["energy"] == pytest.approx(b["energy_final_kcal_per_mol"], abs=1e-9)
    assert [v for xyz in frames[-1]["coordinates_angstrom"] for v in xyz] == pytest.approx(flat(b["atoms"]), abs=1e-9)
    iterations = [f["iteration"] for f in frames]
    assert iterations == sorted(set(iterations))
    energies = [f["energy"] for f in frames]
    assert all(later <= earlier + 1e-6 for earlier, later in zip(energies, energies[1:])), "the minimiser never goes uphill between frames"
    assert all(len(f["coordinates_angstrom"]) == len(b["atoms"]) for f in frames)


def test_uff_fallback_and_unsupported_force_field(client: TestClient) -> None:
    fallback = run_job(client, "rdkit.geometry_optimization", {"structure": smiles("CB(O)O")})
    assert fallback["status"] == "succeeded" and fallback["method"] == "UFF"
    assert fallback["result"]["force_field"]["used"] == "UFF" and "MMFF94" in fallback["result"]["force_field"]["fallback_reason"]
    assert any("UFF was used instead of MMFF94" in w for w in fallback["result"]["warnings"])

    strict = run_job(client, "rdkit.geometry_optimization", {"structure": smiles("CB(O)O")}, {"force_field": "mmff94"})
    assert strict["status"] == "unsupported" and strict["result"] is None and strict["converged"] is None
    assert strict["error"]["code"] == "unsupported" and strict["error"]["details"]["reasons"]

    xenon = run_job(client, "rdkit.geometry_optimization", {"structure": smiles("F[Xe]F")})
    assert xenon["status"] == "unsupported" and xenon["result"] is None
    assert any("Xe" in reason for reason in xenon["error"]["details"]["reasons"])
    assert xenon["finished_at"] is not None and xenon["progress"] < 1.0


def test_conformer_search(client: TestClient) -> None:
    request = ({"structure": smiles("CCCCCO")}, {"num_conformers": 30, "max_returned": 5, "random_seed": 11})
    job = run_job(client, "rdkit.conformer_search", *request)
    assert job["status"] == "succeeded", job["error"]
    result = job["result"]
    KINDS["rdkit.conformer_search"].result_model.model_validate(result)
    assert result["conformers_requested"] == 30 and 1 <= result["conformers_unique"] <= result["conformers_embedded"] <= 30
    assert result["conformers_returned"] == len(result["conformers"]) <= 5
    energies = [c["energy_kcal_per_mol"] for c in result["conformers"]]
    assert energies == sorted(energies)
    assert result["conformers"][0]["relative_energy_kcal_per_mol"] == 0.0 and [c["rank"] for c in result["conformers"]] == list(range(1, len(energies) + 1))
    assert all(len(c["coordinates_angstrom"]) == result["structure"]["atom_count"] == 18 for c in result["conformers"])
    assert result["force_field"]["used"] == "MMFF94" and job["method"] == "ETKDGv3 + MMFF94"
    assert [(a["x"], a["y"], a["z"]) for a in result["atoms"]] == [tuple(xyz) for xyz in result["conformers"][0]["coordinates_angstrom"]]

    again = run_job(client, "rdkit.conformer_search", *request)
    assert [c["energy_kcal_per_mol"] for c in again["result"]["conformers"]] == pytest.approx(energies, abs=1e-9), "same seed, same conformers"
    assert again["input_hash"] == job["input_hash"]


# ---------------------------------------------------------------------------------------------
# Deterministic hashing
# ---------------------------------------------------------------------------------------------


def test_input_hash_is_deterministic(client: TestClient, contract: Contract) -> None:
    first = submit(client, "rdkit.geometry_optimization", {"structure": smiles("CCN")})
    # Same request with the keys in another order, the defaults spelled out, and insignificant whitespace.
    explicit = client.post(
        "/v1/jobs",
        json={
            "timeout_seconds": 30,
            "settings": {
                "trajectory_max_frames": 30,
                "trajectory_stride": 1,
                "record_trajectory": False,
                "random_seed": first["settings"]["random_seed"],
                "max_iterations": 2000,
                "force_field": "auto",
            },
            "input": {"structure": {"data": "  CCN ", "format": "smiles"}},
            "kind": "rdkit.geometry_optimization",
        },
    ).json()
    different_settings = submit(client, "rdkit.geometry_optimization", {"structure": smiles("CCN")}, {"random_seed": 1})
    different_input = submit(client, "rdkit.geometry_optimization", {"structure": smiles("NCC")})
    different_kind = submit(client, "rdkit.conformer_search", {"structure": smiles("CCN")})

    assert len(first["input_hash"]) == 64 and int(first["input_hash"], 16) >= 0
    assert explicit["input_hash"] == first["input_hash"], "key order, spelled-out defaults and the timeout do not change the hash"
    assert explicit["timeout_seconds"] == 30 and first["timeout_seconds"] != 30
    assert len({first["input_hash"], different_settings["input_hash"], different_input["input_hash"], different_kind["input_hash"]}) == 4

    # The hash is exactly SHA-256 over the canonical JSON of {kind, input, settings} as stored.
    canonical = json.dumps({"kind": first["kind"], "input": first["input"], "settings": first["settings"]}, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    assert canonical == canonical_json({"kind": first["kind"], "input": first["input"], "settings": first["settings"]})
    assert hashlib.sha256(canonical.encode("utf-8")).hexdigest() == first["input_hash"]
    assert input_hash(first["kind"], first["input"], first["settings"]) == first["input_hash"]

    for job in (first, explicit, different_settings, different_input, different_kind):
        assert wait_for_job(client, job["id"])["status"] == "succeeded"
    listing = contract.check("GET", "/v1/jobs", client.get("/v1/jobs", params={"input_hash": first["input_hash"]}))
    assert {item["id"] for item in listing["items"]} == {first["id"], explicit["id"]} and listing["total"] == 2
    # Identical requests give identical results.
    results = [client.get(f"/v1/jobs/{job_id}").json()["result"] for job_id in (first["id"], explicit["id"])]
    assert results[0]["energy_final_kcal_per_mol"] == results[1]["energy_final_kcal_per_mol"]
    assert results[0]["atoms"] == results[1]["atoms"]


def test_canonical_json_normalisation() -> None:
    assert canonical_json({"b": 1, "a": [1.0, -0.0, {"y": None, "x": True}]}) == '{"a":[1.0,0.0,{"x":true,"y":null}],"b":1}'
    assert input_hash("k", {"a": 1, "b": 2}, {}) == input_hash("k", {"b": 2, "a": 1}, {})
    assert input_hash("k", {"a": 1}, {}) != input_hash("k", {"a": 2}, {})
    with pytest.raises(ValueError):
        canonical_json({"x": float("nan")})


# ---------------------------------------------------------------------------------------------
# Failure, cancellation, timeouts
# ---------------------------------------------------------------------------------------------


def test_invalid_structure_fails_with_rdkits_message(client: TestClient) -> None:
    job = run_job(client, "rdkit.geometry_optimization", {"structure": smiles(PENTAVALENT_CARBON)})
    assert job["status"] == "failed" and job["result"] is None and job["converged"] is None and job["finished_at"] is not None
    assert job["error"]["code"] == "invalid_structure"
    assert "Explicit valence for atom # 1 C, 5, is greater than permitted" in job["error"]["message"]
    assert job["error"]["details"]["errors"][0] == {
        "type": "AtomValenceException",
        "message": "Explicit valence for atom # 1 C, 5, is greater than permitted",
        "atom_indices": [1],
    }
    assert job["messages"][-1]["level"] == "error"


def test_real_cancellation_terminates_the_worker_process(client: TestClient, contract: Contract) -> None:
    running = _start_long_job(client)
    pid = running["worker_pid"]
    assert process_alive(pid), "the job must really be computing in its own process"
    assert pid != os.getpid()

    # The API stays responsive while the worker is busy.
    started = time.monotonic()
    assert client.post("/v1/chem/validate", json={"structure": smiles("c1ccccc1")}).json()["valid"] is True
    assert client.get("/health").status_code == 200
    assert time.monotonic() - started < 5.0

    response = client.delete(f"/v1/jobs/{running['id']}")
    acknowledged = contract.check("DELETE", "/v1/jobs/{job_id}", response)
    assert acknowledged["cancel_requested"] is True and acknowledged["status"] in ("running", "cancelled")

    cancelled = wait_for_job(client, running["id"], timeout=30)
    assert cancelled["status"] == "cancelled"
    assert wait_until_dead(pid), "cancelling must terminate the worker process"
    assert cancelled["result"] is None and cancelled["error"] is None and cancelled["finished_at"] is not None
    assert cancelled["progress"] < 1.0
    assert any("terminat" in m["text"] for m in cancelled["messages"])

    # Cancelling again changes nothing.
    again = client.delete(f"/v1/jobs/{running['id']}").json()
    assert again["status"] == "cancelled" and again["finished_at"] == cancelled["finished_at"]


def test_queued_job_is_cancelled_before_it_starts(client: TestClient, ctx: AppContext) -> None:
    busy = [_start_long_job(client) for _ in range(ctx.settings.job_workers)]
    try:
        waiting = submit(client, "rdkit.geometry_optimization", {"structure": smiles("CCCC")})
        time.sleep(1.0)
        assert client.get(f"/v1/jobs/{waiting['id']}").json()["status"] == "queued", "all workers are busy, so the job waits"
        health = client.get("/health").json()
        assert health["jobs"]["running"] >= ctx.settings.job_workers and health["jobs"]["queued"] >= 1

        cancelled = client.delete(f"/v1/jobs/{waiting['id']}").json()
        assert cancelled["status"] == "cancelled" and cancelled["started_at"] is None and cancelled["worker_pid"] is None
        assert cancelled["finished_at"] is not None
    finally:
        for job in busy:
            client.delete(f"/v1/jobs/{job['id']}")
        for job in busy:
            assert wait_for_job(client, job["id"], timeout=30)["status"] == "cancelled"
            assert wait_until_dead(job["worker_pid"])
    time.sleep(0.5)
    assert client.get(f"/v1/jobs/{waiting['id']}").json()["status"] == "cancelled", "a cancelled job is never picked up afterwards"


def test_timeout_fails_the_job_and_kills_the_worker(client: TestClient) -> None:
    running = _start_long_job(client, timeout_seconds=6)
    assert running["timeout_seconds"] == 6
    failed = wait_for_job(client, running["id"], timeout=60)
    assert failed["status"] == "failed" and failed["result"] is None
    assert failed["error"]["code"] == "timeout" and "time limit of 6 s" in failed["error"]["message"]
    assert failed["error"]["details"]["timeout_seconds"] == 6
    assert 5.5 <= failed["duration_seconds"] <= 30
    assert wait_until_dead(running["worker_pid"])


def test_killed_worker_surfaces_as_failed_not_as_a_hang(client: TestClient) -> None:
    running = _start_long_job(client)
    os.kill(running["worker_pid"], signal.SIGKILL)
    failed = wait_for_job(client, running["id"], timeout=30)
    assert failed["status"] == "failed" and failed["result"] is None
    assert failed["error"]["code"] == "worker_crashed"
    assert failed["error"]["details"]["signal"] == "SIGKILL" and "SIGKILL" in failed["error"]["message"]
    assert failed["messages"][-1]["level"] == "error"


def test_job_of_a_vanished_supervisor_is_marked_failed(client: TestClient, db: Database, ctx: AppContext) -> None:
    with db.connection() as conn:
        row = conn.execute(
            """
            INSERT INTO calculations (kind, status, input, settings, input_hash, engine, engine_version, timeout_seconds, source_id,
                                      started_at, heartbeat_at, supervisor_id, messages)
            VALUES ('rdkit.geometry_optimization', 'running', '{"structure": {"format": "smiles", "data": "C"}}', '{}', repeat('b', 64),
                    'rdkit', %s, 60, %s, now() - interval '1 hour', now() - interval '1 hour', gen_random_uuid(), '[]')
            RETURNING id
            """,
            (rdBase.rdkitVersion, ctx.engine_source_ids["rdkit"]),
        ).fetchone()
    job = wait_for_job(client, str(row["id"]), timeout=30)
    assert job["status"] == "failed" and job["error"]["code"] == "worker_lost"
    assert "Submit it again" in job["error"]["message"]


def test_job_request_validation(client: TestClient, contract: Contract) -> None:
    cases = [
        {"kind": "does.not_exist", "input": {"structure": smiles("C")}},
        {"kind": "rdkit.geometry_optimization", "input": {}},
        {"kind": "rdkit.geometry_optimization", "input": {"structure": smiles("C")}, "settings": {"force_field": "amber"}},
        {"kind": "rdkit.geometry_optimization", "input": {"structure": smiles("C")}, "settings": {"unknown_setting": 1}},
        {"kind": "rdkit.geometry_optimization", "input": {"structure": {"format": "atoms", "atoms": WATER_ATOMS}}},
        {"kind": "xtb.single_point", "input": {"structure": {"format": "atoms", "atoms": WATER_ATOMS, "data": "O"}}},
        {"kind": "xtb.single_point", "input": {"structure": {"format": "atoms", "atoms": [{"element": "Qq", "x": 0, "y": 0, "z": 0}]}}},
        {"kind": "pyscf.single_point", "input": {"structure": smiles("O")}, "settings": {"method": "hf", "functional": "b3lyp"}},
        {"kind": "rdkit.conformer_search", "input": {"structure": smiles("C")}, "timeout_seconds": -1},
    ]
    before = client.get("/v1/jobs").json()["total"]
    for body in cases:
        response = client.post("/v1/jobs", json=body)
        document = contract.check("POST", "/v1/jobs", response)
        assert response.status_code == 422, body
        assert is_error_shape(document) and document["error"]["code"] == "validation_error" and document["error"]["details"]
    assert client.get("/v1/jobs").json()["total"] == before, "a rejected request stores nothing"


def test_unknown_job_is_404(client: TestClient, contract: Contract) -> None:
    missing = "00000000-0000-4000-8000-000000000000"
    for method in ("GET", "DELETE"):
        response = client.request(method, f"/v1/jobs/{missing}")
        body = contract.check(method, "/v1/jobs/{job_id}", response)
        assert response.status_code == 404 and is_error_shape(body) and body["error"]["code"] == "not_found"
    response = client.get("/v1/jobs/not-a-uuid")
    assert response.status_code == 422 and is_error_shape(response.json())


def test_job_listing_filters(client: TestClient, contract: Contract) -> None:
    succeeded = contract.check("GET", "/v1/jobs", client.get("/v1/jobs", params={"status": "succeeded", "limit": 500}))
    assert succeeded["items"] and all(item["status"] == "succeeded" for item in succeeded["items"])
    conformers = client.get("/v1/jobs", params={"kind": "rdkit.conformer_search"}).json()
    assert conformers["items"] and all(item["kind"] == "rdkit.conformer_search" for item in conformers["items"])
    page = client.get("/v1/jobs", params={"limit": 2, "offset": 1}).json()
    everything = client.get("/v1/jobs", params={"limit": 500}).json()
    assert page["limit"] == 2 and page["offset"] == 1 and [i["id"] for i in page["items"]] == [i["id"] for i in everything["items"][1:3]]
    created = [_parse(item["created_at"]) for item in everything["items"]]
    assert created == sorted(created, reverse=True), "newest first"
    assert "result" not in everything["items"][0], "the list carries summaries; results are fetched per job"
    assert client.get("/v1/jobs", params={"status": "exploded"}).status_code == 422


# ---------------------------------------------------------------------------------------------
# Optional engines: xTB (tblite) and PySCF
# ---------------------------------------------------------------------------------------------


def _engine(client: TestClient, engine_id: str) -> dict:
    return next(e for e in client.get("/v1/engines").json()["engines"] if e["id"] == engine_id)


@pytest.fixture(scope="module")
def xtb(client: TestClient) -> dict:
    engine = _engine(client, "xtb")
    if not engine["available"]:
        pytest.skip(f"xTB engine not available in this image: {engine['unavailable_reason']}")
    return engine


@pytest.fixture(scope="module")
def pyscf_engine(client: TestClient) -> dict:
    engine = _engine(client, "pyscf")
    if not engine["available"]:
        pytest.skip(f"PySCF engine not available in this image: {engine['unavailable_reason']}")
    return engine


def test_xtb_single_point(client: TestClient, xtb: dict) -> None:
    structure = {"structure": {"format": "atoms", "atoms": WATER_ATOMS}}
    job = run_job(client, "xtb.single_point", structure)
    assert job["status"] == "succeeded", job["error"]
    assert job["method"] == "GFN2-xTB" and job["converged"] is True
    assert job["engine"] == {"id": "xtb", "version": xtb["version"]} and job["software"]["tblite"] == xtb["components"]["tblite"]
    result = job["result"]
    KINDS["xtb.single_point"].result_model.model_validate(result)
    assert result["charge"] == 0 and result["multiplicity"] == 1 and result["electron_count"] == 10
    assert math.isfinite(result["energy_hartree"]) and result["energy_hartree"] < 0
    assert result["energy_ev"] == pytest.approx(result["energy_hartree"] * result["conversions"]["hartree_to_ev"])
    assert "CODATA" in result["conversions"]["source"]
    assert sum(result["partial_charges_e"]) == pytest.approx(0.0, abs=1e-6)
    assert result["partial_charges_e"][0] < 0 < result["partial_charges_e"][1], "oxygen is negative, hydrogen positive"
    assert result["partial_charges_e"][1] == pytest.approx(result["partial_charges_e"][2], abs=1e-6), "the two hydrogens are equivalent"
    assert result["dipole_magnitude_debye"] == pytest.approx(math.sqrt(sum(v * v for v in result["dipole_debye"])))
    assert result["dipole_magnitude_debye"] > 0.5 and abs(result["dipole_debye"][0]) < 1e-6
    assert sum(result["orbital_occupations"]) == pytest.approx(8.0, abs=1e-6), "eight valence electrons"
    assert result["homo_lumo_gap_ev"] > 0
    assert {(b["begin_atom_index"], b["end_atom_index"]) for b in result["bond_orders"]} == {(0, 1), (0, 2)}
    assert result["geometry"]["source"] == "input-coordinates"
    assert [(a["x"], a["y"], a["z"]) for a in result["atoms"]] == [(a["x"], a["y"], a["z"]) for a in WATER_ATOMS]

    # The energy does not depend on where the molecule is or how it is oriented (to within the
    # convergence threshold of the self-consistent cycle).
    moved = [{"element": a["element"], "x": -a["y"] + 3.0, "y": a["x"] - 1.5, "z": a["z"] + 0.7} for a in WATER_ATOMS]
    rotated = run_job(client, "xtb.single_point", {"structure": {"format": "atoms", "atoms": moved}})
    assert rotated["result"]["energy_hartree"] == pytest.approx(result["energy_hartree"], abs=2e-6)
    assert rotated["input_hash"] != job["input_hash"]

    gfn1 = run_job(client, "xtb.single_point", structure, {"method": "GFN1-xTB"})
    assert gfn1["status"] == "succeeded" and gfn1["method"] == "GFN1-xTB"
    assert gfn1["result"]["energy_hartree"] != pytest.approx(result["energy_hartree"], abs=1e-3)


def test_xtb_charge_multiplicity_and_unsupported_elements(client: TestClient, xtb: dict) -> None:
    cation = run_job(client, "xtb.single_point", {"structure": {"format": "atoms", "atoms": WATER_ATOMS}, "charge": 1})
    assert cation["status"] == "succeeded"
    assert cation["result"]["charge"] == 1 and cation["result"]["multiplicity"] == 2 and cation["result"]["electron_count"] == 9
    assert sum(cation["result"]["partial_charges_e"]) == pytest.approx(1.0, abs=1e-6)

    impossible = run_job(client, "xtb.single_point", {"structure": {"format": "atoms", "atoms": WATER_ATOMS}, "multiplicity": 2})
    assert impossible["status"] == "failed" and impossible["error"]["code"] == "inconsistent_charge_multiplicity"

    uranium = run_job(client, "xtb.single_point", {"structure": {"format": "atoms", "atoms": [{"element": "U", "x": 0, "y": 0, "z": 0}]}})
    assert uranium["status"] == "unsupported" and uranium["result"] is None
    assert any("U (Z = 92)" in reason for reason in uranium["error"]["details"]["reasons"])

    fused = [{"element": "H", "x": 0, "y": 0, "z": 0}, {"element": "H", "x": 0, "y": 0, "z": 0.01}]
    collapsed = run_job(client, "xtb.single_point", {"structure": {"format": "atoms", "atoms": fused}})
    assert collapsed["status"] == "failed" and collapsed["error"]["code"] == "invalid_geometry"

    unconverged = run_job(client, "xtb.single_point", {"structure": {"format": "atoms", "atoms": WATER_ATOMS}}, {"max_scf_iterations": 1})
    assert unconverged["status"] == "failed" and unconverged["error"]["code"] == "scf_not_converged" and unconverged["result"] is None


def test_xtb_geometry_optimization(client: TestClient, xtb: dict) -> None:
    if "ase" not in xtb["components"]:
        pytest.skip("ASE is not installed, so xTB geometry optimisation is not available")
    stretched = [
        {"element": "O", "x": 0.0, "y": 0.0, "z": 0.0},
        {"element": "H", "x": 0.0, "y": 0.95, "z": -0.65},
        {"element": "H", "x": 0.0, "y": -0.95, "z": -0.65},
    ]
    job = run_job(client, "xtb.geometry_optimization", {"structure": {"format": "atoms", "atoms": stretched}}, {"record_trajectory": True})
    assert job["status"] == "succeeded", job["error"]
    result = job["result"]
    KINDS["xtb.geometry_optimization"].result_model.model_validate(result)
    assert job["converged"] is True and result["converged"] is True and "LBFGS" in result["optimizer"] and "ase" in job["software"]
    assert result["energy_final_hartree"] < result["energy_initial_hartree"]
    assert result["max_force_final_ev_per_angstrom"] < result["force_tolerance_ev_per_angstrom"] < result["max_force_initial_ev_per_angstrom"]
    frames = result["trajectory"]["frames"]
    assert result["trajectory"]["energy_unit"] == "hartree" and len(frames) == result["steps"] + 1
    assert frames[0]["energy"] == pytest.approx(result["energy_initial_hartree"], abs=1e-10)
    assert frames[-1]["energy"] == pytest.approx(result["energy_final_hartree"], abs=1e-10)
    assert frames[0]["coordinates_angstrom"] == [[a["x"], a["y"], a["z"]] for a in stretched]
    oh = [math.dist((result["atoms"][0][k] for k in "xyz"), (result["atoms"][i][k] for k in "xyz")) for i in (1, 2)]
    assert oh[0] == pytest.approx(oh[1], abs=1e-3) and 0.9 < oh[0] < 1.05, "the optimised O-H bonds are equal and of normal length"

    # The optimised geometry is a stationary point for a single point at the same level.
    final = [{"element": a["element"], "x": a["x"], "y": a["y"], "z": a["z"]} for a in result["atoms"]]
    check = run_job(client, "xtb.single_point", {"structure": {"format": "atoms", "atoms": final}})
    assert check["result"]["energy_hartree"] == pytest.approx(result["energy_final_hartree"], abs=2e-6)
    assert check["result"]["gradient_max_hartree_per_bohr"] < 2e-3

    limited = run_job(client, "xtb.geometry_optimization", {"structure": {"format": "atoms", "atoms": stretched}}, {"max_steps": 1})
    assert limited["status"] == "succeeded" and limited["converged"] is False and limited["result"]["converged"] is False
    assert any("not a stationary point" in w for w in limited["result"]["warnings"])


def test_pyscf_hartree_fock_and_dft(client: TestClient, pyscf_engine: dict) -> None:
    structure = {"structure": {"format": "atoms", "atoms": WATER_ATOMS}}
    hf = run_job(client, "pyscf.single_point", structure)
    assert hf["status"] == "succeeded", hf["error"]
    assert hf["method"] == "RHF/sto-3g" and hf["converged"] is True
    assert hf["engine"] == {"id": "pyscf", "version": pyscf_engine["version"]} and hf["software"]["pyscf"] == pyscf_engine["version"]
    result = hf["result"]
    KINDS["pyscf.single_point"].result_model.model_validate(result)
    assert result["scf_type"] == "RHF" and result["functional"] is None and result["basis"] == "sto-3g" and result["grid_level"] is None
    assert result["electron_count"] == 10 and result["basis_function_count"] == 7
    assert len(result["orbital_energies_hartree"]) == 7 and result["orbital_occupations"] == [2.0] * 5 + [0.0] * 2
    assert result["orbital_energies_hartree"] == sorted(result["orbital_energies_hartree"])
    assert result["homo_energy_hartree"] == result["orbital_energies_hartree"][4] and result["lumo_energy_hartree"] == result["orbital_energies_hartree"][5]
    assert result["homo_lumo_gap_ev"] == pytest.approx((result["lumo_energy_hartree"] - result["homo_energy_hartree"]) * result["conversions"]["hartree_to_ev"])
    assert math.isfinite(result["energy_hartree"]) and result["energy_hartree"] < 0 < result["nuclear_repulsion_hartree"]
    assert sum(result["mulliken_charges_e"]) == pytest.approx(0.0, abs=1e-6)
    assert result["mulliken_charges_e"][0] < 0 and result["mulliken_charges_e"][1] == pytest.approx(result["mulliken_charges_e"][2], abs=1e-6)
    assert result["dipole_magnitude_debye"] > 0.5 and abs(result["dipole_debye"][0]) < 1e-6 and abs(result["dipole_debye"][1]) < 1e-6
    assert result["spin_square"] is None and result["beta_orbital_energies_hartree"] is None
    assert result["scf_cycles"] >= 2 and any(m["text"].startswith("SCF cycle") for m in hf["messages"])

    again = run_job(client, "pyscf.single_point", structure)
    assert again["result"]["energy_hartree"] == pytest.approx(result["energy_hartree"], abs=1e-9), "the same request reproduces the same energy"

    dft = run_job(client, "pyscf.single_point", structure, {"method": "dft", "basis": "6-31g"})
    assert dft["status"] == "succeeded", dft["error"]
    assert dft["method"] == "RKS/b3lyp/6-31g" and dft["result"]["functional"] == "b3lyp" and dft["result"]["grid_level"] == 3
    assert dft["result"]["basis_function_count"] == 13 and dft["result"]["scf_type"] == "RKS"
    pbe = run_job(client, "pyscf.single_point", structure, {"method": "dft", "functional": "PBE", "basis": "6-31g"})
    hf_631g = run_job(client, "pyscf.single_point", structure, {"basis": "6-31g"})
    energies = {job["method"]: job["result"]["energy_hartree"] for job in (dft, pbe, hf_631g)}
    assert set(energies) == {"RKS/b3lyp/6-31g", "RKS/pbe/6-31g", "RHF/6-31g"}
    assert len({round(e, 4) for e in energies.values()}) == 3, "different methods give different energies"
    assert hf_631g["result"]["energy_hartree"] != pytest.approx(result["energy_hartree"], abs=1e-3), "the basis set matters"
    assert "libxc" in dft["software"]


def test_pyscf_open_shell_and_symmetry(client: TestClient, pyscf_engine: dict) -> None:
    hydroxyl = [{"element": "O", "x": 0, "y": 0, "z": 0}, {"element": "H", "x": 0, "y": 0, "z": 0.97}]
    radical = run_job(client, "pyscf.single_point", {"structure": {"format": "atoms", "atoms": hydroxyl}}, {"basis": "6-31g"})
    assert radical["status"] == "succeeded", radical["error"]
    result = radical["result"]
    assert result["scf_type"] == "UHF" and result["multiplicity"] == 2 and result["electron_count"] == 9
    assert sum(result["orbital_occupations"]) == 5 and sum(result["beta_orbital_occupations"]) == 4
    assert len(result["beta_orbital_energies_hartree"]) == result["basis_function_count"]
    assert 0.75 <= result["spin_square"] < 0.80, "a doublet has <S^2> close to 0.75"

    hydrogen = [{"element": "H", "x": 0, "y": 0, "z": -0.37}, {"element": "H", "x": 0, "y": 0, "z": 0.37}]
    h2 = run_job(client, "pyscf.single_point", {"structure": {"format": "atoms", "atoms": hydrogen}})
    assert h2["result"]["dipole_magnitude_debye"] == pytest.approx(0.0, abs=1e-6), "a homonuclear diatomic has no dipole"
    assert h2["result"]["mulliken_charges_e"] == pytest.approx([0.0, 0.0], abs=1e-6)
    assert h2["result"]["basis_function_count"] == 2 and h2["result"]["orbital_occupations"] == [2.0, 0.0]

    from_smiles = run_job(client, "pyscf.single_point", {"structure": smiles("[H][H]")})
    assert from_smiles["status"] == "succeeded"
    assert from_smiles["result"]["geometry"]["source"] == "generated" and "ETKDGv3" in from_smiles["result"]["geometry"]["description"]
    assert any("generated by the service" in w for w in from_smiles["result"]["warnings"])


def test_pyscf_explicit_failure_states(client: TestClient, pyscf_engine: dict) -> None:
    structure = {"structure": {"format": "atoms", "atoms": WATER_ATOMS}}
    basis = run_job(client, "pyscf.single_point", structure, {"basis": "no-such-basis"})
    assert basis["status"] == "unsupported" and basis["result"] is None and "no-such-basis" in basis["error"]["message"]

    functional = run_job(client, "pyscf.single_point", structure, {"method": "dft", "functional": "no-such-functional"})
    assert functional["status"] == "unsupported" and "no-such-functional" in functional["error"]["message"]

    xenon = run_job(client, "pyscf.single_point", {"structure": {"format": "atoms", "atoms": [{"element": "Xe", "x": 0, "y": 0, "z": 0}]}}, {"basis": "6-31g"})
    assert xenon["status"] == "unsupported" and "Xe" in xenon["error"]["message"]

    spin = run_job(client, "pyscf.single_point", {**structure, "multiplicity": 2})
    assert spin["status"] == "failed" and spin["error"]["code"] == "inconsistent_charge_multiplicity"

    unconverged = run_job(client, "pyscf.single_point", structure, {"basis": "6-31g", "max_scf_cycles": 1})
    assert unconverged["status"] == "failed" and unconverged["error"]["code"] == "scf_not_converged"
    assert unconverged["result"] is None and unconverged["converged"] is None, "an unconverged SCF energy is never returned as a result"
    assert unconverged["error"]["details"]["scf_cycles"] == 1


def test_missing_engine_yields_unsupported(settings: Settings, contract: Contract) -> None:
    """A second instance of the service on the same database, with the optional engines switched off."""
    limited = replace(settings, disabled_engines=frozenset({"xtb", "pyscf"}), auto_seed=False)
    with TestClient(create_app(limited)) as other:
        engines = {e["id"]: e for e in contract.check("GET", "/v1/engines", other.get("/v1/engines"))["engines"]}
        assert engines["rdkit"]["available"] is True
        for engine_id in ("xtb", "pyscf"):
            assert engines[engine_id]["available"] is False and engines[engine_id]["version"] is None
            assert "MATTERLAB_DISABLED_ENGINES" in engines[engine_id]["unavailable_reason"]
            assert engines[engine_id]["available_job_kinds"] == [] and engines[engine_id]["job_kinds"]
        kinds = {k["kind"]: k for k in other.get("/v1/job-kinds").json()["kinds"]}
        assert kinds["xtb.single_point"]["available"] is False and kinds["rdkit.geometry_optimization"]["available"] is True
        assert other.get("/health").json()["engines"] == {"rdkit": rdBase.rdkitVersion, "xtb": None, "pyscf": None}

        for kind in ("xtb.single_point", "xtb.geometry_optimization", "pyscf.single_point"):
            response = other.post("/v1/jobs", json={"kind": kind, "input": {"structure": {"format": "atoms", "atoms": WATER_ATOMS}}})
            job = contract.check("POST", "/v1/jobs", response)
            assert response.status_code == 202
            assert job["status"] == "unsupported" and job["finished_at"] is not None and job["started_at"] is None
            assert job["result"] is None and job["engine"]["version"] is None and job["worker_pid"] is None
            assert job["error"]["code"] == "engine_unavailable" and job["error"]["details"]["reasons"]
            assert job["provenance"]["source_key"] == "matterlab-science"
            assert other.get(f"/v1/jobs/{job['id']}").json()["status"] == "unsupported", "it is never run later"

        still_works = run_job(other, "rdkit.geometry_optimization", {"structure": smiles("CC")})
        assert still_works["status"] == "succeeded"
