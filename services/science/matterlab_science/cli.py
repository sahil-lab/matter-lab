"""Command line interface: python -m matterlab_science <command>.

  serve               run the HTTP API (migrates and seeds first unless disabled by configuration)
  migrate             apply pending SQL migrations
  migration-status    show applied and pending migrations
  seed [--force]      load reference data (idempotent)
  engines             detect and print the available engines
  export-openapi P    write the OpenAPI schema to the file P ("-" for standard output)
  export-excel P      write the database to the workbook P
  import-excel P      import the workbook P (add --dry-run to validate only)
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from dataclasses import asdict
from pathlib import Path

from .config import Settings, load_settings


def _configure_logging(level: str) -> None:
    logging.basicConfig(level=getattr(logging, level, logging.INFO), format="%(asctime)s %(levelname)s %(name)s: %(message)s", stream=sys.stderr)


def _print(document: object) -> None:
    print(json.dumps(document, indent=2, default=str))


def cmd_migrate(settings: Settings, _: argparse.Namespace) -> int:
    from .db import wait_for_database
    from .migrations import migrate

    wait_for_database(settings.database_conninfo, settings.db_connect_timeout_seconds)
    report = migrate(settings.database_conninfo, settings.migrations_dir)
    _print({"applied": list(report.applied), "already_applied": list(report.already_applied), "schema_version": report.schema_version})
    return 0


def cmd_migration_status(settings: Settings, _: argparse.Namespace) -> int:
    from .db import wait_for_database
    from .migrations import status

    wait_for_database(settings.database_conninfo, settings.db_connect_timeout_seconds)
    _print(status(settings.database_conninfo, settings.migrations_dir))
    return 0


def cmd_seed(settings: Settings, args: argparse.Namespace) -> int:
    from .db import wait_for_database
    from .seeding.run import seed_all

    wait_for_database(settings.database_conninfo, settings.db_connect_timeout_seconds)
    _print(seed_all(settings, force=args.force))
    return 0


def cmd_engines(settings: Settings, _: argparse.Namespace) -> int:
    from .engines import EngineRegistry

    _print([asdict(engine) for engine in EngineRegistry.detect(settings).all()])
    return 0


def cmd_export_openapi(settings: Settings, args: argparse.Namespace) -> int:
    from .main import create_app

    schema = json.dumps(create_app(settings).openapi(), indent=2, sort_keys=True) + "\n"
    if args.path == "-":
        sys.stdout.write(schema)
    else:
        Path(args.path).write_text(schema, encoding="utf-8")
        print(f"wrote {args.path}", file=sys.stderr)
    return 0


def cmd_export_excel(settings: Settings, args: argparse.Namespace) -> int:
    from .db import Database
    from .excel.exporter import export_workbook

    db = Database(settings.database_conninfo, max_size=2)
    db.open(settings.db_connect_timeout_seconds)
    try:
        content, summary = export_workbook(db)
    finally:
        db.close()
    Path(args.path).write_bytes(content)
    _print({"path": args.path, **summary})
    return 0


def cmd_import_excel(settings: Settings, args: argparse.Namespace) -> int:
    from .db import Database
    from .excel.importer import import_workbook

    path = Path(args.path)
    db = Database(settings.database_conninfo, max_size=2)
    db.open(settings.db_connect_timeout_seconds)
    try:
        report = import_workbook(db, path.read_bytes(), filename=path.name, dry_run=args.dry_run, atomic=args.atomic)
    finally:
        db.close()
    _print(report)
    return 0 if report["outcome"] != "rejected" else 1


def cmd_serve(settings: Settings, _: argparse.Namespace) -> int:
    import uvicorn

    from .main import create_app

    uvicorn.run(create_app(settings), host=settings.host, port=settings.port, log_level=settings.log_level.lower(), access_log=False)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m matterlab_science", description="MATTER LAB science service")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("serve", help="run the HTTP API").set_defaults(run=cmd_serve)
    commands.add_parser("migrate", help="apply pending SQL migrations").set_defaults(run=cmd_migrate)
    commands.add_parser("migration-status", help="show applied and pending migrations").set_defaults(run=cmd_migration_status)
    seed = commands.add_parser("seed", help="load reference data (idempotent)")
    seed.add_argument("--force", action="store_true", help="re-apply every seed even when its input is unchanged")
    seed.set_defaults(run=cmd_seed)
    commands.add_parser("engines", help="detect and print the available engines").set_defaults(run=cmd_engines)
    openapi = commands.add_parser("export-openapi", help="write the OpenAPI schema")
    openapi.add_argument("path", help='output file, or "-" for standard output')
    openapi.set_defaults(run=cmd_export_openapi)
    export = commands.add_parser("export-excel", help="export the database to an .xlsx workbook")
    export.add_argument("path")
    export.set_defaults(run=cmd_export_excel)
    imp = commands.add_parser("import-excel", help="import an .xlsx workbook")
    imp.add_argument("path")
    imp.add_argument("--dry-run", action="store_true", help="validate only; write nothing")
    imp.add_argument("--atomic", action="store_true", help="write nothing unless every row is valid")
    imp.set_defaults(run=cmd_import_excel)

    args = parser.parse_args(argv)
    settings = load_settings()
    _configure_logging(settings.log_level)
    return int(args.run(settings, args))


if __name__ == "__main__":
    sys.exit(main())
