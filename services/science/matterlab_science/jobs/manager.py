"""Job supervisor.

One supervisor thread per API process owns a small pool of worker processes. PostgreSQL is the
queue: queued rows are claimed with FOR UPDATE SKIP LOCKED, so several service processes can
share one database without running a job twice.

Guarantees
  * the API never computes: every job runs in its own operating-system process, and a process
    runs exactly one job;
  * cancellation and timeouts terminate that process (SIGTERM, then SIGKILL) and its children;
  * a worker that dies without reporting ends the job as `failed`, with its exit status and the
    tail of its error output;
  * jobs whose supervisor disappeared (service restart or crash) are marked `failed` once their
    heartbeat is stale, so no job stays `running` forever.

Start-up cost
  Starting an interpreter and importing the scientific libraries takes seconds. The supervisor
  therefore keeps a few idle workers that have already done their imports ("warm" workers). A job
  is handed to a warm worker when one exists and to a freshly started one otherwise; the outcome
  is the same, only the delay differs.
"""

from __future__ import annotations

import collections
import json
import logging
import os
import queue
import signal
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from uuid import UUID

from ..config import Settings
from ..db import Database, Jsonb
from ..engines import EngineRegistry
from . import store
from .hashing import input_hash
from .kinds import KINDS, JobKind

log = logging.getLogger("matterlab.jobs")

_HEARTBEAT_SECONDS = 2.0
_KILL_GRACE_SECONDS = 3.0
_STDERR_TAIL_LINES = 40
_WARM_FAILURE_LIMIT = 3
_SERVICE_ROOT = str(Path(__file__).resolve().parents[2])


@dataclass
class _Worker:
    """A worker process and the threads draining its pipes."""

    process: subprocess.Popen[str]
    events: "queue.SimpleQueue[dict[str, Any]]" = field(default_factory=queue.SimpleQueue)
    stderr_tail: "collections.deque[str]" = field(default_factory=lambda: collections.deque(maxlen=_STDERR_TAIL_LINES))
    readers: list[threading.Thread] = field(default_factory=list)

    def alive(self) -> bool:
        return self.process.poll() is None

    def close(self) -> None:
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            try:
                if stream is not None:
                    stream.close()
            except Exception:
                pass


@dataclass
class _Running:
    job_id: UUID
    kind: str
    worker: _Worker
    timeout_seconds: float
    messages: list[dict[str, Any]]
    started: float = field(default_factory=time.monotonic)
    final: dict[str, Any] | None = None
    progress: float = 0.0
    dirty: bool = True
    last_write: float = 0.0
    stopping: str | None = None
    kill_at: float | None = None
    # (status, fields) once decided; kept so that a failed write of the final state can be retried.
    outcome: tuple[str, dict[str, Any]] | None = None

    @property
    def process(self) -> subprocess.Popen[str]:
        return self.worker.process


def _signal_name(returncode: int) -> str | None:
    if returncode >= 0:
        return None
    try:
        return signal.Signals(-returncode).name
    except ValueError:
        return f"signal {-returncode}"


class JobManager:
    def __init__(
        self,
        db: Database,
        settings: Settings,
        engines: EngineRegistry,
        *,
        service_source_id: int,
        engine_source_ids: dict[str, int],
    ) -> None:
        self.db = db
        self.settings = settings
        self.engines = engines
        self.supervisor_id = uuid.uuid4()
        self._service_source_id = service_source_id
        self._engine_source_ids = engine_source_ids
        self._active: dict[UUID, _Running] = {}
        self._warm: list[_Worker] = []
        self._warm_target = settings.job_warm_workers
        self._warm_failures = 0
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._wake = threading.Event()
        self._last_recovery = 0.0

    # ------------------------------------------------------------------ submission (API thread)

    def availability(self, kind: JobKind) -> tuple[bool, list[str]]:
        """Whether the engine behind a job kind can run in this service instance, and if not, why."""
        engine = self.engines.get(kind.engine)
        if engine is None:
            return False, [f"Engine {kind.engine!r} is not known to this service."]
        if not engine.available:
            return False, [f"Engine {engine.name} is not available: {engine.unavailable_reason}"]
        missing = [component for component in kind.required_components if component not in engine.components]
        if missing:
            return False, [f"Job kind {kind.name} needs {', '.join(missing)}, which is not installed in this service image."]
        return True, []

    def submit(self, kind_name: str, job_input: dict[str, Any], job_settings: dict[str, Any], timeout_seconds: float | None) -> UUID:
        """Stores a job. It is queued when its engine is available and recorded as `unsupported`
        (a terminal state, with the reasons) when it is not."""
        kind = KINDS[kind_name]
        digest = input_hash(kind_name, job_input, job_settings)
        timeout = min(timeout_seconds or self.settings.job_timeout_seconds, self.settings.job_max_timeout_seconds)
        available, reasons = self.availability(kind)
        engine = self.engines.get(kind.engine)
        with self.db.connection() as conn:
            if available and engine is not None:
                job_id = store.insert_job(
                    conn,
                    kind=kind_name,
                    status="queued",
                    job_input=job_input,
                    settings=job_settings,
                    input_hash=digest,
                    engine=kind.engine,
                    engine_version=engine.version,
                    software=engine.software(),
                    timeout_seconds=timeout,
                    source_id=self._engine_source_ids[kind.engine],
                    messages=[store.message("Queued.")],
                )
            else:
                job_id = store.insert_job(
                    conn,
                    kind=kind_name,
                    status="unsupported",
                    job_input=job_input,
                    settings=job_settings,
                    input_hash=digest,
                    engine=kind.engine,
                    engine_version=None,
                    software={},
                    timeout_seconds=timeout,
                    source_id=self._service_source_id,
                    messages=[store.message("Not run: the engine for this job kind is not available.", "warning")],
                    error={
                        "code": "engine_unavailable",
                        "message": f"Job kind {kind_name} cannot run in this service instance. " + " ".join(reasons),
                        "details": {"engine": kind.engine, "reasons": reasons},
                    },
                )
        self._wake.set()
        return job_id

    def notify(self) -> None:
        self._wake.set()

    # ------------------------------------------------------------------ lifecycle

    def start(self) -> None:
        if self._thread is not None:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="matterlab-job-supervisor", daemon=True)
        self._thread.start()
        log.info(
            "job supervisor %s started (%d worker process(es), %d thread(s) each, %d kept warm)",
            self.supervisor_id,
            self.settings.job_workers,
            self.settings.job_threads,
            self._warm_target,
        )

    def stop(self) -> None:
        """Stops the supervisor. Running workers are terminated and their jobs marked failed."""
        if self._thread is None:
            return
        self._stop.set()
        self._wake.set()
        self._thread.join(timeout=30)
        self._thread = None
        for worker in self._warm:
            self._dismiss(worker)
        self._warm.clear()
        for running in list(self._active.values()):
            self._terminate(running, "shutdown")
        deadline = time.monotonic() + _KILL_GRACE_SECONDS + 2
        while self._active and time.monotonic() < deadline:
            for running in list(self._active.values()):
                if running.kill_at is not None and time.monotonic() >= running.kill_at:
                    self._kill(running)
                if running.process.poll() is not None:
                    self._finish_at_shutdown(running)
            time.sleep(0.05)
        for running in list(self._active.values()):
            self._kill(running)
            running.process.wait(timeout=5)
            self._finish_at_shutdown(running)
        log.info("job supervisor %s stopped", self.supervisor_id)

    def _finish_at_shutdown(self, running: _Running) -> None:
        try:
            self._finish(running)
        except Exception:
            # The final state could not be stored (database unreachable). The record stays
            # 'running' and is marked failed (worker_lost) by the next supervisor that starts.
            log.exception("could not store the final state of job %s during shutdown", running.job_id)
            self._active.pop(running.job_id, None)
            running.worker.close()

    def is_running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def active_count(self) -> int:
        return len(self._active)

    # ------------------------------------------------------------------ supervisor thread

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                self._tick()
            except Exception:
                log.exception("job supervisor tick failed; retrying")
                time.sleep(1.0)
            self._wake.wait(self.settings.job_poll_interval_seconds)
            self._wake.clear()

    def _tick(self) -> None:
        now = time.monotonic()
        if self._active:
            self._check_cancellations()
            for running in list(self._active.values()):
                self._pump(running, now)
        self._claim()
        self._keep_warm()
        if now - self._last_recovery > 5.0:
            self._last_recovery = now
            self._recover_lost_jobs()

    def _pump(self, running: _Running, now: float) -> None:
        while True:
            try:
                event = running.worker.events.get_nowait()
            except queue.Empty:
                break
            self._handle_event(running, event)

        if running.stopping is None and running.final is None and now - running.started > running.timeout_seconds:
            running.messages.append(store.message(f"Time limit of {running.timeout_seconds:g} s reached; terminating the worker process.", "error"))
            self._terminate(running, "timeout")
        if running.kill_at is not None and now >= running.kill_at and running.process.poll() is None:
            self._kill(running)

        if running.process.poll() is not None:
            self._finish(running)
            return
        if running.dirty or now - running.last_write >= _HEARTBEAT_SECONDS:
            running.messages = store.trim_messages(running.messages)
            with self.db.connection() as conn:
                conn.execute(
                    "UPDATE calculations SET progress = %s, messages = %s, heartbeat_at = now() WHERE id = %s AND status = 'running'",
                    (running.progress, Jsonb(running.messages), running.job_id),
                )
            running.dirty, running.last_write = False, now

    @staticmethod
    def _handle_event(running: _Running, event: dict[str, Any]) -> None:
        kind = event.get("type")
        if kind == "progress":
            fraction = float(event.get("fraction", 0.0))
            if fraction > running.progress:
                running.progress, running.dirty = fraction, True
            if event.get("message"):
                running.messages.append(store.message(str(event["message"])))
                running.dirty = True
        elif kind == "log":
            level = event.get("level") if event.get("level") in ("info", "warning", "error") else "info"
            running.messages.append(store.message(str(event.get("message", "")), level))
            running.dirty = True
        elif kind == "final":
            running.final = event

    def _check_cancellations(self) -> None:
        ids = [job_id for job_id, running in self._active.items() if running.stopping is None and running.final is None]
        if not ids:
            return
        rows = self.db.fetch_all("SELECT id FROM calculations WHERE id = ANY(%s) AND cancel_requested", (ids,))
        for row in rows:
            running = self._active.get(row["id"])
            if running is not None:
                running.messages.append(store.message(f"Cancellation requested; terminating worker process {running.process.pid}."))
                self._terminate(running, "cancelled")

    def _claim(self) -> None:
        while len(self._active) < self.settings.job_workers and not self._stop.is_set():
            with self.db.connection() as conn:
                row = conn.execute(
                    """
                    UPDATE calculations SET status = 'running', started_at = now(), heartbeat_at = now(), supervisor_id = %s
                    WHERE id = (
                      SELECT id FROM calculations WHERE status = 'queued' AND NOT cancel_requested
                      ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1
                    )
                    RETURNING id, kind, input, settings, timeout_seconds, messages
                    """,
                    (self.supervisor_id,),
                ).fetchone()
            if row is None:
                return
            try:
                running = self._assign(row)
            except Exception as exc:
                log.exception("could not start a worker for job %s", row["id"])
                self._write_final(
                    row["id"],
                    "failed",
                    messages=[*row["messages"], store.message(f"The worker process could not be started: {exc}", "error")],
                    error={"code": "worker_start_failed", "message": f"The worker process could not be started: {type(exc).__name__}: {exc}", "details": None},
                )
                continue
            self._active[running.job_id] = running

    # ------------------------------------------------------------------ worker processes

    def _start_worker(self) -> _Worker:
        threads = str(self.settings.job_threads)
        env = dict(os.environ)
        env.update(
            OMP_NUM_THREADS=threads,
            OPENBLAS_NUM_THREADS=threads,
            MKL_NUM_THREADS=threads,
            NUMEXPR_NUM_THREADS=threads,
            PYTHONUNBUFFERED="1",
            PYTHONPATH=_SERVICE_ROOT + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else ""),
            MATTERLAB_WORKER_PRELOAD=",".join(engine.id for engine in self.engines.all() if engine.available and engine.id != "rdkit"),
        )
        process = subprocess.Popen(
            [sys.executable, "-m", "matterlab_science.jobs.worker"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            cwd=_SERVICE_ROOT,
            start_new_session=(os.name == "posix"),  # own process group, so the whole tree can be signalled
        )
        worker = _Worker(process=process)

        def read_events() -> None:
            try:
                assert process.stdout is not None
                for line in process.stdout:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        worker.events.put(json.loads(line))
                    except json.JSONDecodeError:
                        worker.stderr_tail.append(f"[unreadable worker output] {line[:200]}")
            except Exception:  # the pipe closes abruptly when the worker is killed
                pass

        def read_stderr() -> None:
            try:
                assert process.stderr is not None
                for line in process.stderr:
                    if line.strip():
                        worker.stderr_tail.append(line.rstrip()[:500])
            except Exception:
                pass

        for target, name in ((read_events, "out"), (read_stderr, "err")):
            thread = threading.Thread(target=target, name=f"matterlab-worker-{process.pid}-{name}", daemon=True)
            thread.start()
            worker.readers.append(thread)
        return worker

    def _take_worker(self) -> _Worker:
        """An idle warm worker if one is alive, otherwise a freshly started process."""
        while self._warm:
            worker = self._warm.pop(0)
            if worker.alive():
                self._warm_failures = 0
                return worker
            worker.close()
        return self._start_worker()

    def _keep_warm(self) -> None:
        alive = []
        for worker in self._warm:
            if worker.alive():
                alive.append(worker)
                continue
            self._warm_failures += 1
            log.warning(
                "an idle worker exited with code %s before it was used: %s",
                worker.process.returncode,
                " | ".join(list(worker.stderr_tail)[-3:]) or "no output",
            )
            worker.close()
            if self._warm_failures >= _WARM_FAILURE_LIMIT and self._warm_target:
                log.error("idle workers keep exiting; warm workers are switched off (jobs still run in freshly started processes)")
                self._warm_target = 0
        self._warm = alive
        if len(self._warm) < self._warm_target and not self._stop.is_set():
            try:
                self._warm.append(self._start_worker())  # at most one per tick
            except Exception:
                self._warm_failures += 1
                log.exception("could not start an idle worker")

    @staticmethod
    def _dismiss(worker: _Worker) -> None:
        """Ends an idle worker: closing its input makes it exit on its own."""
        try:
            if worker.process.stdin is not None:
                worker.process.stdin.close()
        except Exception:
            pass
        try:
            worker.process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            worker.process.kill()
            worker.process.wait(timeout=5)
        worker.close()

    def _assign(self, row: dict[str, Any]) -> _Running:
        worker = self._take_worker()
        process = worker.process
        running = _Running(
            job_id=row["id"],
            kind=row["kind"],
            worker=worker,
            timeout_seconds=float(row["timeout_seconds"]),
            messages=[*row["messages"], store.message(f"Started in worker process {process.pid}.")],
        )
        spec = json.dumps(
            {
                "kind": row["kind"],
                "input": row["input"],
                "settings": row["settings"],
                "threads": self.settings.job_threads,
                "limits": {
                    "max_atoms_force_field": self.settings.max_atoms_force_field,
                    "max_atoms_xtb": self.settings.max_atoms_xtb,
                    "max_atoms_pyscf": self.settings.max_atoms_pyscf,
                    "max_basis_functions_pyscf": self.settings.max_basis_functions_pyscf,
                },
            }
        )

        def feed() -> None:
            # Written from its own thread: a large job specification must not stall the supervisor
            # while the worker is still busy importing.
            try:
                assert process.stdin is not None
                process.stdin.write(spec + "\n")
                process.stdin.close()
            except (BrokenPipeError, OSError, ValueError):
                pass

        threading.Thread(target=feed, name=f"matterlab-job-{row['id']}-feed", daemon=True).start()
        with self.db.connection() as conn:
            conn.execute(
                "UPDATE calculations SET worker_pid = %s, messages = %s WHERE id = %s",
                (process.pid, Jsonb(running.messages), running.job_id),
            )
        log.info("job %s (%s) started in worker process %d", running.job_id, running.kind, process.pid)
        return running

    def _signal(self, running: _Running, sig: int) -> None:
        if running.process.poll() is not None:
            return
        try:
            if os.name == "posix":
                os.killpg(running.process.pid, sig)
            elif sig == signal.SIGTERM:
                running.process.terminate()
            else:
                running.process.kill()
        except (ProcessLookupError, PermissionError):
            pass

    def _terminate(self, running: _Running, reason: str) -> None:
        if running.stopping is None:
            running.stopping = reason
            running.kill_at = time.monotonic() + _KILL_GRACE_SECONDS
            running.dirty = True
            self._signal(running, signal.SIGTERM)

    def _kill(self, running: _Running) -> None:
        running.kill_at = None
        self._signal(running, signal.SIGKILL if os.name == "posix" else signal.SIGTERM)

    def _finish(self, running: _Running) -> None:
        """Called once the worker process has exited: decides and stores the final state.

        The decision is made once. If storing it fails (PostgreSQL unreachable), the job stays in
        the active set and the next tick tries again, so a finished result is not lost.
        """
        elapsed = time.monotonic() - running.started
        if running.outcome is None:
            running.outcome = self._decide(running, elapsed)
        status, fields = running.outcome
        self._write_final(running.job_id, status, messages=running.messages, progress=running.progress, **fields)
        self._active.pop(running.job_id, None)
        running.worker.close()
        log.info("job %s (%s) finished: %s after %.1f s", running.job_id, running.kind, status, elapsed)

    def _decide(self, running: _Running, elapsed: float) -> tuple[str, dict[str, Any]]:
        for reader in running.worker.readers:
            reader.join(timeout=2.0)
        while True:  # events that arrived between the last pump and process exit
            try:
                event = running.worker.events.get_nowait()
            except queue.Empty:
                break
            self._handle_event(running, event)

        returncode = running.process.returncode
        final = running.final
        fields: dict[str, Any] = {}
        if final is not None and final.get("status") in ("succeeded", "failed", "unsupported"):
            # The worker reported before any stop signal took effect: its report stands.
            status = final["status"]
            fields = {key: final.get(key) for key in ("result", "error", "method", "converged", "software")}
            if status == "succeeded":
                running.messages.append(store.message(f"Finished in {elapsed:.1f} s."))
            else:
                error = fields.get("error") or {}
                running.messages.append(store.message(str(error.get("message", "The job did not produce a result.")), "error" if status == "failed" else "warning"))
        elif running.stopping == "cancelled":
            status = "cancelled"
            running.messages.append(store.message(f"Cancelled: worker process {running.process.pid} was terminated after {elapsed:.1f} s."))
        elif running.stopping == "timeout":
            status = "failed"
            fields["error"] = {
                "code": "timeout",
                "message": f"The job exceeded its time limit of {running.timeout_seconds:g} s and its worker process was terminated.",
                "details": {"timeout_seconds": running.timeout_seconds, "elapsed_seconds": round(elapsed, 3)},
            }
        elif running.stopping == "shutdown":
            status = "failed"
            fields["error"] = {
                "code": "service_shutdown",
                "message": "The science service shut down while this job was running, so its worker process was terminated. Submit the job again to run it.",
                "details": {"elapsed_seconds": round(elapsed, 3)},
            }
            running.messages.append(store.message("Interrupted by service shutdown.", "error"))
        else:
            status = "failed"
            name = _signal_name(returncode)
            how = f"was killed by {name}" if name else f"exited with code {returncode}"
            fields["error"] = {
                "code": "worker_crashed",
                "message": f"The worker process {how} without reporting a result. No result is available for this job.",
                "details": {"exit_code": returncode, "signal": name, "stderr_tail": list(running.worker.stderr_tail)[-15:]},
            }
            running.messages.append(store.message(f"Worker process {running.process.pid} {how} without reporting a result.", "error"))
        return status, fields

    def _write_final(
        self,
        job_id: UUID,
        status: str,
        *,
        messages: list[dict[str, Any]],
        progress: float | None = None,
        result: dict[str, Any] | None = None,
        error: dict[str, Any] | None = None,
        method: str | None = None,
        converged: bool | None = None,
        software: dict[str, str] | None = None,
    ) -> None:
        if status == "failed" and error is None:
            error = {"code": "internal_error", "message": "The job failed without an error description.", "details": None}
        with self.db.connection() as conn:
            conn.execute(
                """
                UPDATE calculations SET
                  status = %s,
                  finished_at = now(),
                  progress = CASE WHEN %s = 'succeeded' THEN 1 ELSE COALESCE(%s, progress) END,
                  messages = %s,
                  result = %s,
                  error = %s,
                  method = COALESCE(%s, method),
                  converged = %s,
                  software = software || %s
                WHERE id = %s AND status = 'running'
                """,
                (
                    status,
                    status,
                    progress,
                    Jsonb(store.trim_messages(messages)),
                    Jsonb(result) if status == "succeeded" and result is not None else None,
                    Jsonb(error) if error is not None and status in ("failed", "unsupported") else None,
                    method,
                    converged if status == "succeeded" else None,
                    Jsonb(software or {}),
                    job_id,
                ),
            )

    def _recover_lost_jobs(self) -> None:
        """Marks jobs as failed when the supervisor that owned them no longer sends heartbeats."""
        error = {
            "code": "worker_lost",
            "message": "The service instance running this job stopped reporting (it was restarted or crashed), so the job was not completed. Submit it again to run it.",
            "details": {"stale_after_seconds": self.settings.job_stale_after_seconds},
        }
        with self.db.connection() as conn:
            rows = conn.execute(
                """
                UPDATE calculations SET status = 'failed', finished_at = now(), error = %s,
                  messages = messages || %s
                WHERE status = 'running' AND supervisor_id IS DISTINCT FROM %s
                  AND (heartbeat_at IS NULL OR heartbeat_at < now() - make_interval(secs => %s))
                RETURNING id
                """,
                (Jsonb(error), Jsonb([store.message("Marked failed: the owning service instance stopped reporting.", "error")]), self.supervisor_id, self.settings.job_stale_after_seconds),
            ).fetchall()
        for row in rows:
            log.warning("job %s was running under a supervisor that disappeared; marked failed", row["id"])
