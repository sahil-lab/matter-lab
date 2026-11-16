"""PostgreSQL access: one connection pool per application, dict rows, UTC sessions."""

from __future__ import annotations

import logging
import time
from contextlib import contextmanager
from typing import Any, Iterator

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool, PoolClosed, PoolTimeout

log = logging.getLogger("matterlab.db")

__all__ = ["Database", "DatabaseUnavailable", "Jsonb", "connect", "wait_for_database"]


def connect(conninfo: str, *, autocommit: bool = False) -> psycopg.Connection[dict[str, Any]]:
    """A single connection outside the pool (migrations, seeding, CLI commands)."""
    return psycopg.connect(conninfo, autocommit=autocommit, row_factory=dict_row)


def wait_for_database(conninfo: str, timeout_seconds: float) -> None:
    """Blocks until the server accepts connections; raises if it does not within the timeout."""
    deadline = time.monotonic() + timeout_seconds
    delay = 0.25
    while True:
        try:
            with psycopg.connect(conninfo, connect_timeout=5) as conn:
                conn.execute("SELECT 1")
            return
        except psycopg.OperationalError as exc:
            if time.monotonic() + delay > deadline:
                raise RuntimeError(f"database not reachable after {timeout_seconds:.0f} s: {exc}".strip()) from exc
            log.info("waiting for database (%s)", str(exc).strip().splitlines()[0] if str(exc).strip() else type(exc).__name__)
            time.sleep(delay)
            delay = min(delay * 2, 3.0)


class DatabaseUnavailable(Exception):
    """PostgreSQL cannot be reached (no usable connection within the time limit)."""


class Database:
    def __init__(self, conninfo: str, *, max_size: int = 10, timeout_seconds: float = 10.0) -> None:
        self.conninfo = conninfo
        self.timeout_seconds = timeout_seconds
        self._pool: ConnectionPool[psycopg.Connection[dict[str, Any]]] = ConnectionPool(
            conninfo,
            min_size=1,
            max_size=max_size,
            open=False,
            kwargs={"row_factory": dict_row},
            # A pooled connection is verified when it is handed out, so a restart of PostgreSQL
            # costs a reconnect, not a failed request.
            check=ConnectionPool.check_connection,
            timeout=timeout_seconds,
            name="matterlab",
        )

    def open(self, timeout_seconds: float = 30.0) -> None:
        self._pool.open(wait=True, timeout=timeout_seconds)

    def close(self) -> None:
        self._pool.close()

    @contextmanager
    def connection(self, timeout_seconds: float | None = None) -> Iterator[psycopg.Connection[dict[str, Any]]]:
        """One transaction: committed when the block exits normally, rolled back on an exception.

        Raises DatabaseUnavailable when no working connection can be had within the time limit.
        """
        try:
            conn = self._pool.getconn(timeout=timeout_seconds)
        except (PoolTimeout, PoolClosed) as exc:
            raise DatabaseUnavailable(str(exc) or type(exc).__name__) from exc
        try:
            with conn:  # commit or roll back; a pooled connection is not closed here
                yield conn
        finally:
            self._pool.putconn(conn)

    def fetch_all(self, query: str, params: Any = None) -> list[dict[str, Any]]:
        with self.connection() as conn:
            return conn.execute(query, params).fetchall()

    def fetch_one(self, query: str, params: Any = None) -> dict[str, Any] | None:
        with self.connection() as conn:
            return conn.execute(query, params).fetchone()

    def execute(self, query: str, params: Any = None) -> int:
        with self.connection() as conn:
            return conn.execute(query, params).rowcount
