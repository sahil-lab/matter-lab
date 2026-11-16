"""Runtime configuration, read from environment variables with safe local-development defaults."""

from __future__ import annotations

import os
import math
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

from psycopg.conninfo import conninfo_to_dict, make_conninfo

DEFAULT_CORS_ORIGINS = (
    "http://127.0.0.1:5273",
    "http://localhost:5273",
    "http://127.0.0.1:4273",
    "http://localhost:4273",
)

_SERVICE_ROOT = Path(__file__).resolve().parents[1]
# In a source checkout the service lives in <repo>/services/science; in the image it is /app.
_REPO_ROOT = _SERVICE_ROOT.parents[1] if len(_SERVICE_ROOT.parents) > 1 else _SERVICE_ROOT


def _first_existing(*candidates: Path) -> Path:
    for candidate in candidates:
        if candidate.is_dir():
            return candidate
    return candidates[0]


@dataclass(frozen=True)
class Settings:
    database_conninfo: str = field(repr=False)
    cors_origins: tuple[str, ...]
    migrations_dir: Path
    generated_data_dir: Path
    seed_dir: Path
    auto_migrate: bool
    auto_seed: bool
    db_connect_timeout_seconds: float
    db_pool_max_size: int
    db_pool_timeout_seconds: float
    jobs_enabled: bool
    job_workers: int
    job_warm_workers: int
    job_threads: int
    job_timeout_seconds: float
    job_max_timeout_seconds: float
    job_poll_interval_seconds: float
    job_stale_after_seconds: float
    disabled_engines: frozenset[str]
    max_atoms_sync: int
    max_atoms_force_field: int
    max_atoms_xtb: int
    max_atoms_pyscf: int
    max_basis_functions_pyscf: int
    external_lookups_enabled: bool
    pubchem_base_url: str
    pubchem_timeout_seconds: float
    max_upload_bytes: int
    host: str
    port: int
    log_level: str
    lab_auth_tokens_json: str = field(default="[]", repr=False)
    lab_schema_path: Path = _REPO_ROOT / "packages" / "contracts" / "schemas" / "lab-v1.schema.json"
    lab_runner_path: Path = _REPO_ROOT / "packages" / "lab-runtime" / "dist" / "cli.mjs"
    lab_validator_path: Path = _REPO_ROOT / "services" / "science" / "node" / "dist" / "validate.mjs"
    lab_catalog_dir: Path = _REPO_ROOT / "packages" / "lab-runtime" / "dist" / "catalog"
    lab_learning_schema_path: Path = _REPO_ROOT / "packages" / "lab-runtime" / "dist" / "catalog" / "learning-state.schema.json"
    lab_node_binary: str = "node"
    lab_max_request_bytes: int = 8 * 1024 * 1024
    lab_max_output_bytes: int = 16 * 1024 * 1024
    lab_run_timeout_seconds: float = 60.0
    lab_validation_timeout_seconds: float = 5.0
    lab_max_active_runs_per_owner: int = 4
    lab_max_runs_per_owner: int = 1000
    lab_max_scenes_per_owner: int = 200
    lab_contract_version: str = "1.1.0"
    lab_runtime_version: str = "1.0.0"
    lab_method_version: str = "1.0.0"

    def with_database(self, dbname: str) -> "Settings":
        """Same settings pointed at another database on the same server (used by the test suite)."""
        return replace(self, database_conninfo=make_conninfo(self.database_conninfo, dbname=dbname))

    @property
    def database_name(self) -> str:
        return str(conninfo_to_dict(self.database_conninfo).get("dbname", ""))

    def public_dict(self) -> dict[str, Any]:
        """Settings that are safe to show (no credentials)."""
        info = conninfo_to_dict(self.database_conninfo)
        return {
            "database": {"host": info.get("host"), "port": info.get("port"), "dbname": info.get("dbname")},
            "job_workers": self.job_workers,
            "job_warm_workers": self.job_warm_workers,
            "job_threads": self.job_threads,
            "job_timeout_seconds": self.job_timeout_seconds,
            "job_max_timeout_seconds": self.job_max_timeout_seconds,
            "disabled_engines": sorted(self.disabled_engines),
            "external_lookups_enabled": self.external_lookups_enabled,
        }


def _env(name: str, default: str) -> str:
    value = os.environ.get(name)
    return default if value is None or value.strip() == "" else value.strip()


def _env_bool(name: str, default: bool) -> bool:
    raw = _env(name, "true" if default else "false").lower()
    if raw in ("1", "true", "yes", "on"):
        return True
    if raw in ("0", "false", "no", "off"):
        return False
    raise ValueError(f"{name} must be a boolean (true/false), got {raw!r}")


def _env_int(name: str, default: int, minimum: int) -> int:
    value = int(_env(name, str(default)))
    if value < minimum:
        raise ValueError(f"{name} must be >= {minimum}, got {value}")
    return value


def _env_float(name: str, default: float, minimum: float) -> float:
    value = float(_env(name, str(default)))
    if not math.isfinite(value) or value < minimum:
        raise ValueError(f"{name} must be finite and >= {minimum}, got {value}")
    return value


def _database_conninfo() -> str:
    url = os.environ.get("MATTERLAB_DATABASE_URL", "").strip()
    if url:
        base = url
    else:
        base = make_conninfo(
            host=_env("MATTERLAB_DB_HOST", "127.0.0.1"),
            port=_env("MATTERLAB_DB_PORT", "55432"),
            user=_env("MATTERLAB_DB_USER", "matterlab"),
            password=_env("MATTERLAB_DB_PASSWORD", "matterlab_local_dev"),
            dbname=_env("MATTERLAB_DB_NAME", "matterlab"),
        )
    # Every session talks UTC, so timestamps read from the database are always UTC-aware.
    return make_conninfo(base, options="-c timezone=UTC", application_name="matterlab-science")


def load_settings() -> Settings:
    origins = tuple(o.strip() for o in _env("MATTERLAB_CORS_ORIGINS", ",".join(DEFAULT_CORS_ORIGINS)).split(",") if o.strip())
    job_timeout = _env_float("MATTERLAB_JOB_TIMEOUT_SECONDS", 600.0, 1.0)
    return Settings(
        database_conninfo=_database_conninfo(),
        cors_origins=origins,
        migrations_dir=Path(_env("MATTERLAB_MIGRATIONS_DIR", str(_first_existing(Path("/db/migrations"), _REPO_ROOT / "db" / "migrations")))),
        generated_data_dir=Path(
            _env("MATTERLAB_GENERATED_DATA_DIR", str(_first_existing(Path("/data/generated"), _REPO_ROOT / "tools" / "data" / "generated")))
        ),
        seed_dir=Path(_env("MATTERLAB_SEED_DIR", str(_SERVICE_ROOT / "seed"))),
        auto_migrate=_env_bool("MATTERLAB_AUTO_MIGRATE", True),
        auto_seed=_env_bool("MATTERLAB_AUTO_SEED", True),
        db_connect_timeout_seconds=_env_float("MATTERLAB_DB_CONNECT_TIMEOUT_SECONDS", 60.0, 1.0),
        db_pool_max_size=_env_int("MATTERLAB_DB_POOL_MAX_SIZE", 10, 2),
        db_pool_timeout_seconds=_env_float("MATTERLAB_DB_POOL_TIMEOUT_SECONDS", 10.0, 0.5),
        jobs_enabled=_env_bool("MATTERLAB_JOBS_ENABLED", True),
        job_workers=_env_int("MATTERLAB_JOB_WORKERS", 2, 1),
        job_warm_workers=_env_int("MATTERLAB_JOB_WARM_WORKERS", 1, 0),
        job_threads=_env_int("MATTERLAB_JOB_THREADS", 2, 1),
        job_timeout_seconds=job_timeout,
        job_max_timeout_seconds=max(job_timeout, _env_float("MATTERLAB_JOB_MAX_TIMEOUT_SECONDS", 3600.0, 1.0)),
        job_poll_interval_seconds=_env_float("MATTERLAB_JOB_POLL_INTERVAL_SECONDS", 0.2, 0.02),
        job_stale_after_seconds=_env_float("MATTERLAB_JOB_STALE_AFTER_SECONDS", 30.0, 2.0),
        disabled_engines=frozenset(e.strip().lower() for e in _env("MATTERLAB_DISABLED_ENGINES", "").split(",") if e.strip()),
        max_atoms_sync=_env_int("MATTERLAB_MAX_ATOMS_SYNC", 300, 1),
        max_atoms_force_field=_env_int("MATTERLAB_MAX_ATOMS_FORCE_FIELD", 2000, 1),
        max_atoms_xtb=_env_int("MATTERLAB_MAX_ATOMS_XTB", 300, 1),
        max_atoms_pyscf=_env_int("MATTERLAB_MAX_ATOMS_PYSCF", 60, 1),
        max_basis_functions_pyscf=_env_int("MATTERLAB_MAX_BASIS_FUNCTIONS_PYSCF", 600, 1),
        external_lookups_enabled=_env_bool("MATTERLAB_EXTERNAL_LOOKUPS_ENABLED", True),
        pubchem_base_url=_env("MATTERLAB_PUBCHEM_BASE_URL", "https://pubchem.ncbi.nlm.nih.gov/rest/pug").rstrip("/"),
        pubchem_timeout_seconds=_env_float("MATTERLAB_PUBCHEM_TIMEOUT_SECONDS", 15.0, 1.0),
        max_upload_bytes=_env_int("MATTERLAB_MAX_UPLOAD_BYTES", 50 * 1024 * 1024, 1024),
        host=_env("MATTERLAB_HOST", "0.0.0.0"),
        port=_env_int("MATTERLAB_PORT", 8787, 1),
        log_level=_env("MATTERLAB_LOG_LEVEL", "INFO").upper(),
        lab_auth_tokens_json=_env("MATTERLAB_LAB_AUTH_TOKENS_JSON", "[]"),
        lab_schema_path=Path(_env("MATTERLAB_LAB_SCHEMA_PATH", str(_REPO_ROOT / "packages" / "contracts" / "schemas" / "lab-v1.schema.json"))),
        lab_runner_path=Path(_env("MATTERLAB_LAB_RUNNER_PATH", str(_REPO_ROOT / "packages" / "lab-runtime" / "dist" / "cli.mjs"))),
        lab_validator_path=Path(_env("MATTERLAB_LAB_VALIDATOR_PATH", str(_REPO_ROOT / "services" / "science" / "node" / "dist" / "validate.mjs"))),
        lab_catalog_dir=Path(_env("MATTERLAB_LAB_CATALOG_DIR", str(_REPO_ROOT / "packages" / "lab-runtime" / "dist" / "catalog"))),
        lab_learning_schema_path=Path(_env("MATTERLAB_LAB_LEARNING_SCHEMA_PATH", str(_REPO_ROOT / "packages" / "lab-runtime" / "dist" / "catalog" / "learning-state.schema.json"))),
        lab_node_binary=_env("MATTERLAB_LAB_NODE_BINARY", "node"),
        lab_max_request_bytes=_env_int("MATTERLAB_LAB_MAX_REQUEST_BYTES", 8 * 1024 * 1024, 1024),
        lab_max_output_bytes=_env_int("MATTERLAB_LAB_MAX_OUTPUT_BYTES", 16 * 1024 * 1024, 1024),
        lab_run_timeout_seconds=_env_float("MATTERLAB_LAB_RUN_TIMEOUT_SECONDS", 60.0, 1.0),
        lab_validation_timeout_seconds=_env_float("MATTERLAB_LAB_VALIDATION_TIMEOUT_SECONDS", 5.0, 1.0),
        lab_max_active_runs_per_owner=_env_int("MATTERLAB_LAB_MAX_ACTIVE_RUNS", 4, 1),
        lab_max_runs_per_owner=_env_int("MATTERLAB_LAB_MAX_RUNS", 1000, 1),
        lab_max_scenes_per_owner=_env_int("MATTERLAB_LAB_MAX_SCENES", 200, 1),
        lab_contract_version=_env("MATTERLAB_LAB_CONTRACT_VERSION", "1.1.0"),
        lab_runtime_version=_env("MATTERLAB_LAB_RUNTIME_VERSION", "1.0.0"),
        lab_method_version=_env("MATTERLAB_LAB_METHOD_VERSION", "1.0.0"),
    )
