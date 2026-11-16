"""Capture RDKit's own log messages so they can be returned to the caller verbatim.

RDKit reports parse and sanitisation problems through its C++ logger. `install()` routes that
logger into Python logging; `capture()` collects what RDKit says on the current thread.
"""

from __future__ import annotations

import logging
import re
import threading
from contextlib import contextmanager
from typing import Iterator

from rdkit import rdBase

_local = threading.local()
_installed = False
_install_lock = threading.Lock()

# RDKit prefixes real log lines with a timestamp. Lines without one are C++ invariant dumps and
# stack traces, which are noise for an API consumer.
_TIMESTAMPED = re.compile(r"^\[\d\d:\d\d:\d\d\]\s*(.*)$", re.DOTALL)


class _CaptureHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        buffer = getattr(_local, "buffer", None)
        if buffer is not None:
            buffer.append((record.levelname, record.getMessage()))


def install() -> None:
    """Idempotent. After this, RDKit no longer writes to stderr on its own."""
    global _installed
    with _install_lock:
        if _installed:
            return
        rdBase.LogToPythonLogger()
        logger = logging.getLogger("rdkit")
        logger.handlers = [_CaptureHandler()]
        logger.setLevel(logging.WARNING)
        logger.propagate = False
        _installed = True


@contextmanager
def capture() -> Iterator[list[tuple[str, str]]]:
    """Collects (level, raw message) pairs logged by RDKit on this thread inside the block."""
    install()
    previous = getattr(_local, "buffer", None)
    buffer: list[tuple[str, str]] = []
    _local.buffer = buffer
    try:
        yield buffer
    finally:
        _local.buffer = previous


def messages(buffer: list[tuple[str, str]], *, levels: tuple[str, ...] = ("WARNING", "ERROR", "CRITICAL")) -> list[str]:
    """RDKit's messages without timestamps, in order, without repeats."""
    seen: list[str] = []
    for level, raw in buffer:
        if level not in levels:
            continue
        match = _TIMESTAMPED.match(raw.strip())
        if not match:
            continue
        text = match.group(1).strip()
        if text and text not in seen:
            seen.append(text)
    return seen
