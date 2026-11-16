"""Worker process: runs exactly one job and reports over a pipe.

    python -m matterlab_science.jobs.worker        (started by the supervisor, never by hand)

Protocol
  stdin   one line of JSON: {"kind", "input", "settings", "limits", "threads"}
  stdout  JSON lines: {"type": "ready" | "started" | "progress" | "log" | "final", ...}
  stderr  free text; the supervisor keeps the tail for crash diagnostics

A worker first imports what jobs need and reports `ready`; it then waits for its job. The
supervisor keeps a few such idle workers so that a job starts computing immediately instead of
paying for interpreter start-up and imports. A worker still runs one job only and then exits.

The worker has no database access. It is a pure function of its input, which is what makes a
job reproducible and makes cancellation trivial: the supervisor terminates this process.
"""

from __future__ import annotations

import importlib
import json
import os
import platform
import sys
import time
import traceback
from typing import Any, TextIO

from pydantic import ValidationError


def _open_channel() -> TextIO:
    # The protocol gets a private copy of stdout; fd 1 is then pointed at stderr so that anything
    # a native library prints to "stdout" lands in the log instead of corrupting the protocol.
    channel = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    return channel


def _warm_up() -> None:
    """Imports everything a job may need, so a pre-started worker can begin computing at once.

    Which optional engines to preload is decided by the supervisor (it knows which ones passed
    their self-test); a failing preload is not fatal, the import is simply repeated by the task.
    """
    from ..chem import rdlog
    from . import kinds, tasks_rdkit  # noqa: F401

    rdlog.install()
    for engine in filter(None, os.environ.get("MATTERLAB_WORKER_PRELOAD", "").split(",")):
        try:
            if engine == "xtb":
                import tblite.interface  # noqa: F401

                from . import tasks_xtb  # noqa: F401

                try:
                    import ase.optimize  # noqa: F401
                    import tblite.ase  # noqa: F401
                except ImportError:
                    pass
            elif engine == "pyscf":
                from pyscf import dft, gto, scf  # noqa: F401

                from . import tasks_pyscf  # noqa: F401
        except Exception as exc:
            print(f"worker warm-up: could not preload {engine}: {type(exc).__name__}: {exc}", file=sys.stderr)


def main() -> int:
    channel = _open_channel()
    last_progress = 0.0

    def emit(event: dict[str, Any]) -> None:
        nonlocal last_progress
        if event.get("type") == "progress" and "message" not in event:
            # Bare progress ticks are throttled; ticks that carry a message always go through.
            now = time.monotonic()
            if now - last_progress < 0.2 and event.get("fraction", 0) < 1:
                return
            last_progress = now
        channel.write(json.dumps(event, allow_nan=False) + "\n")
        channel.flush()

    def final(status: str, **fields: Any) -> int:
        emit({"type": "final", "status": status, **fields})
        return 0

    try:
        _warm_up()
    except Exception as exc:
        print(f"worker warm-up failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        traceback.print_exc()
        return 3
    emit({"type": "ready", "pid": os.getpid()})

    # The job arrives as one line of JSON. End of input without a job means the supervisor no
    # longer needs this (idle) worker.
    line = sys.stdin.readline()
    if not line.strip():
        return 0
    try:
        spec = json.loads(line)
    except Exception as exc:
        return final("failed", error={"code": "internal_error", "message": f"The worker could not read its job specification: {exc}", "details": None})

    from .. import __version__
    from .kinds import KINDS
    from .runtime import TaskFailure, Unsupported, WorkerContext

    base_software = {"python": platform.python_version(), "matterlab_science": __version__}
    emit({"type": "started", "pid": os.getpid()})

    kind = KINDS.get(spec.get("kind", ""))
    if kind is None:
        return final("failed", error={"code": "internal_error", "message": f"Unknown job kind {spec.get('kind')!r}.", "details": None}, software=base_software)

    ctx = WorkerContext(limits=spec["limits"], threads=int(spec.get("threads", 1)), _emit=emit)
    try:
        module_name, function_name = kind.runner.split(":")
        task = getattr(importlib.import_module(module_name), function_name)
        outcome = task(spec["input"], spec["settings"], ctx)
        software = {**base_software, **outcome.software}
        document = kind.result_model.model_validate(outcome.result).model_dump(mode="json")
        json.dumps(document, allow_nan=False)  # a result must be finite, serialisable JSON
        return final("succeeded", result=document, method=outcome.method, converged=outcome.converged, software=software)
    except Unsupported as exc:
        return final(
            "unsupported",
            error={"code": "unsupported", "message": exc.message, "details": {"reasons": exc.reasons, **exc.details}},
            software=base_software,
        )
    except TaskFailure as exc:
        return final("failed", error={"code": exc.code, "message": exc.message, "details": exc.details or None}, software=base_software)
    except ValidationError as exc:
        return final(
            "failed",
            error={
                "code": "result_contract_violation",
                "message": "The engine finished but its result does not match the published result schema; it was discarded.",
                "details": {"problems": json.loads(exc.json(include_url=False, include_input=False))[:20]},
            },
            software=base_software,
        )
    except ValueError as exc:
        if "Out of range float values" in str(exc) or "not JSON compliant" in str(exc):
            return final(
                "failed",
                error={"code": "non_finite_result", "message": "The engine produced non-finite numbers (NaN or infinity); the result was discarded.", "details": None},
                software=base_software,
            )
        return final(
            "failed",
            error={"code": "internal_error", "message": f"{type(exc).__name__}: {exc}", "details": {"traceback": traceback.format_exc().splitlines()[-12:]}},
            software=base_software,
        )
    except MemoryError:
        return final("failed", error={"code": "out_of_memory", "message": "The calculation ran out of memory.", "details": None}, software=base_software)
    except Exception as exc:
        return final(
            "failed",
            error={
                "code": "internal_error",
                "message": f"The calculation stopped with an unexpected error: {type(exc).__name__}: {exc}",
                "details": {"traceback": traceback.format_exc().splitlines()[-12:]},
            },
            software=base_software,
        )


if __name__ == "__main__":
    sys.exit(main())
