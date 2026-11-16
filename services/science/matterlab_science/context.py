"""Application context: everything a request handler needs, built once at start-up."""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from .config import Settings
from .db import Database, wait_for_database
from .engines import EngineRegistry
from .provenance import ensure_service_source, ensure_user_source, upsert_data_source

if TYPE_CHECKING:
    from .catalogue.search import CatalogueIndex
    from .jobs.manager import JobManager

log = logging.getLogger("matterlab.app")

ENGINE_SOURCE_KEYS = {"rdkit": "rdkit", "xtb": "xtb-tblite", "pyscf": "pyscf"}


@dataclass
class AppContext:
    settings: Settings
    db: Database
    engines: EngineRegistry
    jobs: "JobManager"
    catalogue: "CatalogueIndex"
    started_at: datetime
    user_source_id: int
    service_source_id: int
    engine_source_ids: dict[str, int]

    def shutdown(self) -> None:
        self.jobs.stop()
        self.db.close()


def _register_sources(db: Database, engines: EngineRegistry) -> tuple[int, int, dict[str, int]]:
    engine_ids: dict[str, int] = {}
    with db.connection() as conn:
        user_id = ensure_user_source(conn)
        service_id = ensure_service_source(conn)
        for engine in engines.all():
            if not engine.available or not engine.version:
                continue
            components = ", ".join(f"{name} {version}" for name, version in sorted(engine.components.items()))
            engine_ids[engine.id] = upsert_data_source(
                conn,
                key=ENGINE_SOURCE_KEYS[engine.id],
                version=engine.version,
                kind="software",
                title=engine.name,
                url=engine.url,
                license=engine.license,
                notes=f"{engine.description} Components: {components}.",
            )
    return user_id, service_id, engine_ids


def startup(settings: Settings) -> AppContext:
    from .catalogue.search import CatalogueIndex
    from .chem import rdlog
    from .jobs.manager import JobManager
    from .migrations import migrate, status
    from .seeding.run import seed_all

    rdlog.install()
    wait_for_database(settings.database_conninfo, settings.db_connect_timeout_seconds)
    if settings.auto_migrate:
        report = migrate(settings.database_conninfo, settings.migrations_dir)
        log.info("schema version %s (%d migration(s) applied now)", report.schema_version, len(report.applied))
    else:
        pending = status(settings.database_conninfo, settings.migrations_dir)["pending"]
        if pending:
            versions = ", ".join(p["version"] for p in pending)
            raise RuntimeError(f"the database schema is behind (pending migrations: {versions}); run `python -m matterlab_science migrate`")
    if settings.auto_seed:
        seed_all(settings)

    db = Database(settings.database_conninfo, max_size=settings.db_pool_max_size, timeout_seconds=settings.db_pool_timeout_seconds)
    db.open(settings.db_connect_timeout_seconds)
    try:
        engines = EngineRegistry.detect(settings)
        user_id, service_id, engine_ids = _register_sources(db, engines)
        jobs = JobManager(db, settings, engines, service_source_id=service_id, engine_source_ids=engine_ids)
        if settings.jobs_enabled:
            jobs.start()
    except Exception:
        db.close()
        raise
    return AppContext(
        settings=settings,
        db=db,
        engines=engines,
        jobs=jobs,
        catalogue=CatalogueIndex(db),
        started_at=datetime.now(timezone.utc),
        user_source_id=user_id,
        service_source_id=service_id,
        engine_source_ids=engine_ids,
    )
