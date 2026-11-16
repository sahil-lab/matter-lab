"""Durable job supervisor for the shared TS runtime. No chemistry is implemented here."""

from __future__ import annotations

import hashlib
import logging
import os
import shutil
import subprocess
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

from ..config import Settings
from ..db import Database, Jsonb
from . import store
from .problems import LabProblem
from .validation import canonical_bytes, decode_json, run_input_hash, validate_contract

log = logging.getLogger("matterlab.lab")


class RunnerFailure(Exception):
    def __init__(self, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail


def bundle_fingerprint(entry: Path) -> str | None:
    if not entry.is_file():
        return None
    root = entry.resolve().parent
    digest = hashlib.sha256(b"matterlab-node-bundle-v1\0" + entry.name.encode("utf-8") + b"\0")
    paths = sorted((path for path in root.rglob("*") if path.is_file() and path.suffix in (".mjs", ".js", ".cjs", ".json")), key=lambda path: path.relative_to(root).as_posix())
    if len(paths) > 500:
        raise RunnerFailure("RUNTIME_RELEASE_INVALID", "The runtime release exceeds its file-count limit.")
    total = 0
    for path in paths:
        if path.is_symlink() or not path.resolve().is_relative_to(root):
            raise RunnerFailure("RUNTIME_RELEASE_INVALID", "Runtime release files cannot link outside the installed bundle.")
        total += path.stat().st_size
        if total > 64 * 1024 * 1024:
            raise RunnerFailure("RUNTIME_RELEASE_INVALID", "The runtime release exceeds its byte limit.")
        digest.update(path.relative_to(root).as_posix().encode("utf-8") + b"\0")
        digest.update(hashlib.sha256(path.read_bytes()).digest())
    return digest.hexdigest()


def terminal_result(row: dict[str, Any], status: str, detail: str) -> dict[str, Any]:
    result = {
        "runId": str(row["id"]), "status": status, "methodId": row["method_id"], "methodVersion": row["method_version"],
        "inputHash": row["input_hash"], "observations": [], "warnings": [detail], "assumptions": [],
    }
    if status in ("FAILED", "UNSUPPORTED"):
        result["error"] = {"type": "urn:matterlab:problem:runtime-error", "title": "Laboratory replay failed", "status": 503, "detail": detail, "code": "RUNTIME_ERROR"}
    return result


def execute_bundle(
    payload: dict[str, Any], settings: Settings, expected_bundle_hash: str | None,
    cancelled: Callable[[], bool],
) -> dict[str, Any]:
    path = settings.lab_runner_path.resolve()
    executable = shutil.which(settings.lab_node_binary)
    if executable is None or not path.is_file() or expected_bundle_hash is None:
        raise RunnerFailure("RUNTIME_UNAVAILABLE", "The shared Node laboratory runtime is not installed; no scientific calculation was performed.")
    if bundle_fingerprint(path) != expected_bundle_hash:
        raise RunnerFailure("RUNTIME_RELEASE_CHANGED", "The runtime bundle changed after this run was frozen. Submit a new run with the installed release.")
    stdin_bytes = canonical_bytes(payload)
    if len(stdin_bytes) > settings.lab_max_request_bytes:
        raise RunnerFailure("RUN_INPUT_TOO_LARGE", "The frozen replay exceeds the worker's input limit.")
    outputs = {"stdout": bytearray(), "stderr": bytearray()}
    overflow = threading.Event()
    allowed_environment = {"PATH", "SYSTEMROOT", "WINDIR", "HOME", "LANG", "LC_ALL"}
    environment = {key: value for key, value in os.environ.items() if key.upper() in allowed_environment}
    argv = [
        executable, "--max-old-space-size=192", "--disable-proto=throw", "--permission",
        f"--allow-fs-read={path.parent}", str(path),
    ]
    try:
        process = subprocess.Popen(
            argv, cwd=str(path.parent), env=environment, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            shell=False, close_fds=True,
        )
    except OSError as exc:
        raise RunnerFailure("RUNTIME_UNAVAILABLE", "The configured Node replay worker could not be started.") from exc
    assert process.stdin is not None and process.stdout is not None and process.stderr is not None

    def feed() -> None:
        try:
            process.stdin.write(stdin_bytes)
            process.stdin.close()
        except (BrokenPipeError, OSError, ValueError):
            pass

    def drain(name: str, stream: Any, limit: int) -> None:
        try:
            while block := stream.read(8192):
                remaining = limit - len(outputs[name])
                outputs[name].extend(block[:max(remaining, 0)])
                if len(block) > remaining:
                    overflow.set()
                    return
        except (OSError, ValueError):
            pass

    threads = [
        threading.Thread(target=feed, daemon=True),
        threading.Thread(target=drain, args=("stdout", process.stdout, settings.lab_max_output_bytes), daemon=True),
        threading.Thread(target=drain, args=("stderr", process.stderr, 64 * 1024), daemon=True),
    ]
    for thread in threads:
        thread.start()
    deadline = time.monotonic() + settings.lab_run_timeout_seconds
    failure: RunnerFailure | None = None
    try:
        while process.poll() is None:
            if cancelled():
                failure = RunnerFailure("RUN_CANCELLED", "The laboratory replay was cancelled.")
            elif overflow.is_set():
                failure = RunnerFailure("RUN_OUTPUT_TOO_LARGE", "The runtime exceeded the output limit.")
            elif time.monotonic() >= deadline:
                failure = RunnerFailure("RUN_TIMEOUT", "The runtime exceeded its wall-clock limit.")
            if failure:
                break
            time.sleep(0.05)
    finally:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)
        for thread in threads:
            thread.join(timeout=2)
        process.stdin.close()
        process.stdout.close()
        process.stderr.close()
    if failure:
        raise failure
    if overflow.is_set():
        raise RunnerFailure("RUN_OUTPUT_TOO_LARGE", "The runtime exceeded the output limit.")
    if process.returncode != 0:
        log.warning("Node replay exited %s: %s", process.returncode, outputs["stderr"].decode("utf-8", errors="replace")[:2000])
        raise RunnerFailure("RUNNER_EXITED", f"The shared runtime exited with code {process.returncode}; no successful result was accepted.")
    try:
        response = decode_json(bytes(outputs["stdout"]))
        validate_contract(response, "NodeRunResponse", settings.lab_schema_path, settings.lab_validator_path, settings.lab_node_binary, settings.lab_validation_timeout_seconds)
        result = response["result"]
        if (
            result["runId"] != payload["runId"] or result["inputHash"] != run_input_hash(payload)
            or result["methodId"] != payload["initialScene"]["simulationConfig"]["methodId"]
            or result["methodVersion"] != payload["methodVersion"] or result["status"] not in store.TERMINAL_STATUSES
        ):
            raise ValueError("response identity, version or hash mismatch")
        return response
    except (LabProblem, KeyError, ValueError, TypeError) as exc:
        raise RunnerFailure("RUNNER_INVALID_RESPONSE", "The shared runtime response failed its schema, identity or reproducibility checks.") from exc


class LabRunManager:
    def __init__(self, db: Database, settings: Settings) -> None:
        self.db = db
        self.settings = settings
        self.worker_id = uuid4()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._loop, name="matterlab-lab-supervisor", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=max(15.0, self.settings.db_pool_timeout_seconds + 5))

    def _claim(self) -> dict[str, Any] | None:
        with self.db.connection() as conn:
            stale = conn.execute(
                "SELECT * FROM lab_run WHERE status='RUNNING' AND heartbeat_at < now() - (%s * interval '1 second') FOR UPDATE SKIP LOCKED",
                (max(10.0, self.settings.job_stale_after_seconds),),
            ).fetchall()
            for row in stale:
                result = terminal_result(row, "FAILED", "The replay worker stopped reporting progress; no successful result was recorded.")
                store.append_event(conn, row["id"], "status", {"status": "FAILED", "failureCode": "WORKER_LOST"})
                conn.execute("UPDATE lab_run SET status='FAILED',failure_code='WORKER_LOST',result=%s,completed_at=now() WHERE id=%s", (Jsonb(result), row["id"]))
            row = conn.execute("SELECT * FROM lab_run WHERE status='QUEUED' ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED").fetchone()
            if row is None:
                return None
            store.append_event(conn, row["id"], "status", {"status": "RUNNING", "runId": str(row["id"])})
            return conn.execute(
                "UPDATE lab_run SET status='RUNNING',worker_id=%s,started_at=now(),heartbeat_at=now() WHERE id=%s RETURNING *",
                (self.worker_id, row["id"]),
            ).fetchone()

    def _run(self, row: dict[str, Any]) -> None:
        last_check = 0.0

        def cancelled() -> bool:
            nonlocal last_check
            if self._stop.is_set():
                return True
            if time.monotonic() - last_check < 0.25:
                return False
            last_check = time.monotonic()
            with self.db.connection() as conn:
                current = conn.execute(
                    "UPDATE lab_run SET heartbeat_at=now() WHERE id=%s AND worker_id=%s AND status='RUNNING' RETURNING cancel_requested",
                    (row["id"], self.worker_id),
                ).fetchone()
                return current is None or current["cancel_requested"]

        checkpoint = None
        failure_code = None
        try:
            response = execute_bundle(row["input_snapshot"], self.settings, row["runner_sha256"], cancelled)
            result = response["result"]
            checkpoint = response.get("checkpoint")
            if result["status"] == "FAILED":
                failure_code = result.get("error", {}).get("code", "RUNTIME_FAILED")
        except RunnerFailure as exc:
            status = "CANCELLED" if exc.code == "RUN_CANCELLED" and not self._stop.is_set() else "FAILED"
            failure_code = "WORKER_STOPPED" if self._stop.is_set() else exc.code
            result = terminal_result(row, status, exc.detail)
        with self.db.connection() as conn:
            current = conn.execute("SELECT * FROM lab_run WHERE id=%s FOR UPDATE", (row["id"],)).fetchone()
            if current is None or current["status"] in store.TERMINAL_STATUSES or current["worker_id"] != self.worker_id:
                return
            if current["cancel_requested"]:
                result = terminal_result(row, "CANCELLED", "Cancelled by the owner; late worker output was discarded.")
                failure_code = None
                checkpoint = None
            for ordinal, observation in enumerate(result["observations"]):
                conn.execute("INSERT INTO lab_observation(run_id,ordinal,observation) VALUES(%s,%s,%s)", (row["id"], ordinal, Jsonb(observation)))
            if checkpoint is not None:
                for event in checkpoint["events"]:
                    conn.execute("INSERT INTO lab_action_event(run_id,sequence,data) VALUES(%s,%s,%s)", (row["id"], event["sequence"], Jsonb(event)))
            store.append_event(conn, row["id"], "status", {"status": result["status"], "runId": str(row["id"]), "failureCode": failure_code, "observationCount": len(result["observations"])})
            conn.execute(
                "UPDATE lab_run SET status=%s,result=%s,checkpoint=%s,failure_code=%s,completed_at=now(),heartbeat_at=now() WHERE id=%s",
                (result["status"], Jsonb(result), Jsonb(checkpoint) if checkpoint is not None else None, failure_code, row["id"]),
            )

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                row = self._claim()
                if row is not None:
                    self._run(row)
                    continue
            except Exception:
                log.exception("laboratory supervisor failure; unfinished runs retain a durable state for stale-worker recovery")
            self._stop.wait(0.25)
