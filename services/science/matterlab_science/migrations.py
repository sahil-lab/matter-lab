"""Forward-only SQL migration runner.

Migration files live in db/migrations as NNNN_name.sql (plain SQL, applied in numeric order, each in
its own transaction). Applied versions are recorded in schema_migrations together with a checksum of
the file, so an edited migration is detected instead of being silently ignored. Running the
migrations again is a no-op.
"""

from __future__ import annotations

import hashlib
import logging
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import psycopg

from .db import connect

log = logging.getLogger("matterlab.migrations")

_FILE_PATTERN = re.compile(r"^(\d{4})_([a-z0-9_]+)\.sql$")
# Arbitrary constant identifying the MATTER LAB migration lock (pg_advisory_lock key).
_ADVISORY_LOCK_KEY = 7_203_114_580_011


class MigrationError(RuntimeError):
    pass


@dataclass(frozen=True)
class Migration:
    version: str
    name: str
    path: Path
    sql: str
    checksum: str


@dataclass(frozen=True)
class MigrationReport:
    applied: tuple[str, ...]
    already_applied: tuple[str, ...]

    @property
    def schema_version(self) -> str | None:
        versions = self.already_applied + self.applied
        return max(versions) if versions else None


def discover(directory: Path) -> list[Migration]:
    if not directory.is_dir():
        raise MigrationError(f"migrations directory not found: {directory}")
    found: list[Migration] = []
    for path in sorted(directory.iterdir()):
        if path.suffix != ".sql":
            continue
        match = _FILE_PATTERN.match(path.name)
        if not match:
            raise MigrationError(f"migration file name must look like 0001_description.sql: {path.name}")
        # Line endings are normalised so a checkout with CRLF has the same checksum as one with LF.
        sql = path.read_text(encoding="utf-8").replace("\r\n", "\n")
        found.append(Migration(match.group(1), match.group(2), path, sql, hashlib.sha256(sql.encode("utf-8")).hexdigest()))
    versions = [m.version for m in found]
    if len(set(versions)) != len(versions):
        raise MigrationError(f"duplicate migration version numbers in {directory}")
    return found


def _ensure_table(conn: psycopg.Connection[Any]) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version       text PRIMARY KEY CHECK (version ~ '^[0-9]{4}$'),
          name          text NOT NULL,
          checksum      text NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
          applied_at    timestamptz NOT NULL DEFAULT now(),
          execution_ms  integer NOT NULL CHECK (execution_ms >= 0)
        )
        """
    )


def applied_versions(conn: psycopg.Connection[Any]) -> dict[str, dict[str, Any]]:
    rows = conn.execute("SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version").fetchall()
    return {row["version"]: row for row in rows}


def migrate(conninfo: str, directory: Path) -> MigrationReport:
    """Applies every pending migration. Safe to call concurrently and repeatedly."""
    migrations = discover(directory)
    applied: list[str] = []
    skipped: list[str] = []
    with connect(conninfo, autocommit=True) as conn:
        # Session-level lock: concurrent starters queue here instead of racing each other.
        conn.execute("SELECT pg_advisory_lock(%s)", (_ADVISORY_LOCK_KEY,))
        try:
            _ensure_table(conn)
            done = applied_versions(conn)
            known = {m.version for m in migrations}
            missing = sorted(set(done) - known)
            if missing:
                raise MigrationError(
                    f"the database has migrations that are not in {directory}: {', '.join(missing)}. "
                    "Refusing to continue with an older set of migration files."
                )
            for migration in migrations:
                record = done.get(migration.version)
                if record is not None:
                    if record["checksum"] != migration.checksum:
                        raise MigrationError(
                            f"migration {migration.path.name} was changed after it was applied "
                            f"(recorded checksum {record['checksum'][:12]}..., file checksum {migration.checksum[:12]}...). "
                            "Migrations are forward-only: add a new migration instead of editing an applied one."
                        )
                    skipped.append(migration.version)
                    continue
                pending_before = [v for v in done if v > migration.version]
                if pending_before:
                    raise MigrationError(
                        f"migration {migration.path.name} is older than already applied migration(s) {', '.join(sorted(pending_before))}; "
                        "new migrations must have a higher number than every applied one."
                    )
                started = time.monotonic()
                try:
                    with conn.transaction():
                        conn.execute(migration.sql)  # type: ignore[arg-type]
                        conn.execute(
                            "INSERT INTO schema_migrations (version, name, checksum, execution_ms) VALUES (%s, %s, %s, %s)",
                            (migration.version, migration.name, migration.checksum, int((time.monotonic() - started) * 1000)),
                        )
                except psycopg.Error as exc:
                    raise MigrationError(f"migration {migration.path.name} failed and was rolled back: {exc}".strip()) from exc
                done[migration.version] = {"checksum": migration.checksum}
                applied.append(migration.version)
                log.info("applied migration %s (%s)", migration.version, migration.name)
        finally:
            conn.execute("SELECT pg_advisory_unlock(%s)", (_ADVISORY_LOCK_KEY,))
    return MigrationReport(tuple(applied), tuple(skipped))


def status(conninfo: str, directory: Path) -> dict[str, Any]:
    """Applied and pending migrations, without changing anything."""
    migrations = discover(directory)
    with connect(conninfo, autocommit=True) as conn:
        exists = conn.execute("SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present").fetchone()
        done = applied_versions(conn) if exists and exists["present"] else {}
    return {
        "applied": [
            {"version": v, "name": r["name"], "applied_at": r["applied_at"].isoformat().replace("+00:00", "Z")} for v, r in sorted(done.items())
        ],
        "pending": [{"version": m.version, "name": m.name} for m in migrations if m.version not in done],
        "schema_version": max(done) if done else None,
    }
