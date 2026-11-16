"""Run every seed. Idempotent: unchanged inputs are detected by hash and skipped."""

from __future__ import annotations

import logging
from typing import Any

from ..config import Settings
from ..db import connect
from ..provenance import ensure_service_source, ensure_user_source
from .chemistry import seed_catalogue, seed_functional_groups
from .reference import seed_elements, seed_isotopes

log = logging.getLogger("matterlab.seed")

# Arbitrary constant identifying the MATTER LAB seeding lock (pg_advisory_xact_lock key).
_ADVISORY_LOCK_KEY = 7_203_114_580_012


def seed_all(settings: Settings, *, force: bool = False) -> list[dict[str, Any]]:
    """Each seed runs in its own transaction, so a failing seed leaves the others in place and
    never leaves a half-loaded table behind."""
    steps = (
        ("core-sources", lambda conn: _core_sources(conn)),
        ("elements", lambda conn: seed_elements(conn, settings.generated_data_dir, force=force)),
        ("isotopes", lambda conn: seed_isotopes(conn, settings.generated_data_dir, force=force)),
        ("functional-groups", lambda conn: seed_functional_groups(conn, force=force)),
        ("pubchem-catalogue", lambda conn: seed_catalogue(conn, settings.seed_dir, force=force)),
    )
    reports: list[dict[str, Any]] = []
    with connect(settings.database_conninfo, autocommit=True) as conn:
        for name, step in steps:
            with conn.transaction():
                conn.execute("SELECT pg_advisory_xact_lock(%s)", (_ADVISORY_LOCK_KEY,))
                report = step(conn)
            reports.append(report)
            log.info("seed %s: %s", name, {k: v for k, v in report.items() if k not in ("seed", "skipped")})
            for skipped in report.get("skipped", []):
                log.warning("seed %s skipped %s (%s): %s", name, skipped["name"], skipped["list"], skipped["reason"])
    return reports


def _core_sources(conn: Any) -> dict[str, Any]:
    ensure_user_source(conn)
    ensure_service_source(conn)
    return {"seed": "core-sources", "status": "applied", "records": 2}
