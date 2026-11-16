"""Tier 1: migrations on an empty database, idempotency, and the constraints the schema enforces."""

from __future__ import annotations

import psycopg
import pytest
from psycopg.rows import dict_row

from matterlab_science.config import Settings
from matterlab_science.migrations import MigrationError, discover, migrate, status

EXPECTED_TABLES = {
    "schema_migrations",
    "data_sources",
    "seed_state",
    "elements",
    "element_sources",
    "isotopes",
    "compounds",
    "compound_synonyms",
    "functional_groups",
    "solvents",
    "catalysts",
    "reactions",
    "reaction_participants",
    "calculations",
    "experiments",
    "experiment_calculations",
    "discoveries",
    "discovery_catalog_searches",
    "discovery_evidence",
    "data_imports",
}

# Tables holding scientific or user records: each must point at its source.
PROVENANCE_TABLES = ("elements", "isotopes", "compounds", "functional_groups", "solvents", "catalysts", "reactions", "calculations", "experiments", "discoveries")


def _tables(conninfo: str) -> set[str]:
    with psycopg.connect(conninfo, row_factory=dict_row) as conn:
        return {r["table_name"] for r in conn.execute("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")}


def test_migrations_apply_on_an_empty_database(empty_database: Settings) -> None:
    assert _tables(empty_database.database_conninfo) == set(), "the fixture must hand out an empty database"
    files = discover(empty_database.migrations_dir)
    assert len(files) >= 5
    assert [m.version for m in files] == sorted(m.version for m in files)

    report = migrate(empty_database.database_conninfo, empty_database.migrations_dir)

    assert list(report.applied) == [m.version for m in files]
    assert report.already_applied == ()
    assert report.schema_version == files[-1].version
    assert _tables(empty_database.database_conninfo) == EXPECTED_TABLES
    with psycopg.connect(empty_database.database_conninfo, row_factory=dict_row) as conn:
        recorded = conn.execute("SELECT version, name, checksum FROM schema_migrations ORDER BY version").fetchall()
    assert [(r["version"], r["name"], r["checksum"]) for r in recorded] == [(m.version, m.name, m.checksum) for m in files]


def test_migrations_are_idempotent(empty_database: Settings) -> None:
    first = migrate(empty_database.database_conninfo, empty_database.migrations_dir)
    with psycopg.connect(empty_database.database_conninfo, row_factory=dict_row) as conn:
        before = conn.execute("SELECT version, applied_at FROM schema_migrations ORDER BY version").fetchall()

    second = migrate(empty_database.database_conninfo, empty_database.migrations_dir)

    assert second.applied == ()
    assert second.already_applied == first.applied
    with psycopg.connect(empty_database.database_conninfo, row_factory=dict_row) as conn:
        after = conn.execute("SELECT version, applied_at FROM schema_migrations ORDER BY version").fetchall()
    assert after == before, "re-running must not touch the migration records"
    report = status(empty_database.database_conninfo, empty_database.migrations_dir)
    assert report["pending"] == [] and report["schema_version"] == first.schema_version


def test_an_edited_migration_is_refused(empty_database: Settings) -> None:
    migrate(empty_database.database_conninfo, empty_database.migrations_dir)
    with psycopg.connect(empty_database.database_conninfo) as conn:
        conn.execute("UPDATE schema_migrations SET checksum = repeat('0', 64) WHERE version = '0001'")
    with pytest.raises(MigrationError, match="changed after it was applied"):
        migrate(empty_database.database_conninfo, empty_database.migrations_dir)


def test_every_record_table_references_its_source(empty_database: Settings) -> None:
    migrate(empty_database.database_conninfo, empty_database.migrations_dir)
    with psycopg.connect(empty_database.database_conninfo, row_factory=dict_row) as conn:
        rows = conn.execute(
            """
            SELECT cl.relname AS table_name, a.attnotnull AS not_null
            FROM pg_constraint c
            JOIN pg_class cl ON cl.oid = c.conrelid
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
            WHERE c.contype = 'f' AND c.confrelid = 'data_sources'::regclass AND a.attname = 'source_id'
            """
        ).fetchall()
    referencing = {r["table_name"]: r["not_null"] for r in rows}
    for table in PROVENANCE_TABLES:
        assert referencing.get(table) is True, f"{table}.source_id must be a NOT NULL foreign key to data_sources"


def test_schema_constraints_reject_inconsistent_rows(empty_database: Settings) -> None:
    migrate(empty_database.database_conninfo, empty_database.migrations_dir)
    with psycopg.connect(empty_database.database_conninfo, row_factory=dict_row, autocommit=True) as conn:
        source = conn.execute(
            "INSERT INTO data_sources (key, version, kind, title) VALUES ('test-source', 'v1', 'user', 'Test source') RETURNING id"
        ).fetchone()["id"]

        with pytest.raises(psycopg.errors.CheckViolation):  # not on the status ladder
            conn.execute(
                "INSERT INTO discoveries (title, status, input_format, input_structure, structure_valid, validation, source_id) "
                "VALUES ('x', 'novel', 'smiles', 'C', false, '{}', %s)",
                (source,),
            )
        with pytest.raises(psycopg.errors.CheckViolation):  # an invalid structure cannot climb the ladder
            conn.execute(
                "INSERT INTO discoveries (title, status, input_format, input_structure, structure_valid, validation, source_id) "
                "VALUES ('x', 'structurally-validated', 'smiles', 'C(', false, '{}', %s)",
                (source,),
            )
        with pytest.raises(psycopg.errors.CheckViolation):  # a finished job needs finished_at
            conn.execute(
                "INSERT INTO calculations (kind, status, input, input_hash, engine, timeout_seconds, source_id, result) "
                "VALUES ('rdkit.geometry_optimization', 'succeeded', '{}', repeat('a', 64), 'rdkit', 10, %s, '{}')",
                (source,),
            )
        with pytest.raises(psycopg.errors.CheckViolation):  # a failed job needs its error
            conn.execute(
                "INSERT INTO calculations (kind, status, input, input_hash, engine, timeout_seconds, source_id, finished_at) "
                "VALUES ('rdkit.geometry_optimization', 'failed', '{}', repeat('a', 64), 'rdkit', 10, %s, now())",
                (source,),
            )
        with pytest.raises(psycopg.errors.ForeignKeyViolation):  # isotopes belong to an element
            conn.execute(
                "INSERT INTO isotopes (atomic_number, neutron_number, mass_from_systematics, stability, source_id) VALUES (1, 0, false, 'S', %s)",
                (source,),
            )
        with pytest.raises(psycopg.errors.NotNullViolation):  # no record without provenance
            conn.execute(
                "INSERT INTO experiments (title) VALUES ('no source')",
            )
        with pytest.raises(psycopg.errors.CheckViolation):  # InChIKey format
            conn.execute(
                "INSERT INTO compounds (name, canonical_smiles, inchi, inchikey, molblock, molecular_formula, molecular_weight_g_per_mol, "
                "monoisotopic_mass_u, formal_charge, heavy_atom_count, morgan_fp, pattern_fp, fingerprint_params, derived_by, source_id) "
                "VALUES ('x', 'C', 'InChI=1S/CH4/h1H4', 'not-a-key', 'm', 'CH4', 16.0, 16.0, 0, 1, ''::bytea, ''::bytea, '{}', '{}', %s)",
                (source,),
            )
