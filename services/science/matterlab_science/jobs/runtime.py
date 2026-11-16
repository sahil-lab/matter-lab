"""What a job task sees: a context for reporting progress, and the ways a task can end."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable


class Unsupported(Exception):
    """The engine cannot treat this input. Ends the job with status `unsupported`."""

    def __init__(self, message: str, reasons: list[str] | None = None, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.reasons = reasons or []
        self.details = details or {}


class TaskFailure(Exception):
    """The calculation was attempted and did not produce a valid result. Ends the job with status `failed`."""

    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


@dataclass
class TaskOutcome:
    result: dict[str, Any]
    method: str
    converged: bool | None
    software: dict[str, str] = field(default_factory=dict)


@dataclass
class WorkerContext:
    limits: dict[str, int]
    threads: int
    _emit: Callable[[dict[str, Any]], None]
    _last_fraction: float = 0.0

    def progress(self, fraction: float, message: str | None = None) -> None:
        """Reports the completed fraction (never moving backwards) and optionally a message."""
        self._last_fraction = max(self._last_fraction, min(max(float(fraction), 0.0), 1.0))
        event: dict[str, Any] = {"type": "progress", "fraction": self._last_fraction}
        if message:
            event["message"] = message
        self._emit(event)

    def log(self, message: str, level: str = "info") -> None:
        self._emit({"type": "log", "level": level, "message": message})
