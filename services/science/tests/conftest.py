"""Test fixtures.

The suite runs against the real PostgreSQL server of the compose stack. It never touches the
development database: a fresh database is created for the session (and one more for every test
that needs an empty one), migrated and seeded by the service's own code, and dropped afterwards.
RDKit, tblite and PySCF are the real libraries; jobs run in real worker processes.
"""

from __future__ import annotations

import uuid
from dataclasses import replace
from typing import Any, Callable, Iterator

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.conninfo import make_conninfo

from matterlab_science.config import Settings, load_settings
from matterlab_science.context import AppContext
from matterlab_science.db import Database
from matterlab_science.main import create_app

from .helpers import Contract


@pytest.fixture(scope="session")
def base_settings() -> Settings:
    return load_settings()


@pytest.fixture(scope="session")
def database_factory(base_settings: Settings) -> Iterator[Callable[[], str]]:
    """Creates empty databases on the stack's PostgreSQL server and drops them at the end."""
    admin = make_conninfo(base_settings.database_conninfo, dbname="postgres")
    created: list[str] = []

    def create() -> str:
        name = f"matterlab_test_{uuid.uuid4().hex[:16]}"
        with psycopg.connect(admin, autocommit=True) as conn:
            conn.execute(f'CREATE DATABASE "{name}"')
        created.append(name)
        return name

    yield create
    if created:
        with psycopg.connect(admin, autocommit=True, connect_timeout=5) as conn:
            for name in created:
                conn.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')


@pytest.fixture(scope="session")
def settings(base_settings: Settings, database_factory: Callable[[], str]) -> Settings:
    return replace(
        base_settings.with_database(database_factory()),
        auto_migrate=True,
        auto_seed=True,
        jobs_enabled=True,
        job_workers=3,
        job_warm_workers=2,
        job_threads=1,
        job_poll_interval_seconds=0.05,
        job_timeout_seconds=180.0,
        job_max_timeout_seconds=600.0,
        job_stale_after_seconds=6.0,
        disabled_engines=frozenset(),
        external_lookups_enabled=True,
    )


@pytest.fixture(scope="session")
def client(settings: Settings) -> Iterator[TestClient]:
    """The real application: start-up migrates and seeds the session database, detects the
    engines and starts the job supervisor."""
    with TestClient(create_app(settings)) as test_client:
        yield test_client


@pytest.fixture(scope="session")
def ctx(client: TestClient) -> AppContext:
    return client.app.state.ctx  # type: ignore[attr-defined]


@pytest.fixture(scope="session")
def db(ctx: AppContext) -> Database:
    return ctx.db


@pytest.fixture(scope="session")
def contract(client: TestClient) -> Contract:
    return Contract(client.app.openapi())  # type: ignore[attr-defined]


@pytest.fixture()
def empty_database(base_settings: Settings, database_factory: Callable[[], str]) -> Settings:
    """Settings pointing at a brand-new, completely empty database."""
    return base_settings.with_database(database_factory())


@pytest.fixture()
def override_settings(ctx: AppContext) -> Iterator[Callable[..., None]]:
    """Changes configuration values of the running application for one test."""
    original = ctx.settings

    def apply(**changes: Any) -> None:
        ctx.settings = replace(ctx.settings, **changes)

    yield apply
    ctx.settings = original
