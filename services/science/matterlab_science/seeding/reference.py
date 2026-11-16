"""Seed the periodic-table reference data (elements, isotopes) from tools/data/generated.

The JSON files are produced by the repository's data build scripts from cited sources; this
module copies them into PostgreSQL unchanged and registers those sources. Re-running is cheap:
when a file's SHA-256 matches the one recorded in seed_state, nothing is written.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import psycopg

from ..db import Jsonb
from ..provenance import upsert_data_source

# JSON key -> column, for the element fields that come straight from a cited source.
_PUBCHEM_FIELDS = {
    "name": "name",
    "atomicWeight": "standard_atomic_weight_u",
    "category": "category",
    "standardState": "standard_state",
    "electronConfiguration": "electron_configuration",
    "electronegativityPauling": "electronegativity_pauling",
    "ionizationEnergyEv": "ionization_energy_ev",
    "electronAffinityEv": "electron_affinity_ev",
    "oxidationStates": "oxidation_states",
    "meltingPointK": "melting_point_k",
    "boilingPointK": "boiling_point_k",
    "densityGPerCm3": "density_g_per_cm3",
    "yearDiscovered": "year_discovered",
}
_RDKIT_FIELDS = {
    "covalentRadius": "covalent_radius_angstrom",
    "valences": "valences",
    "valenceUnconstrained": "valence_unconstrained",
    "outerElectrons": "outer_electrons",
    "mostCommonIsotope": "most_common_isotope_mass_number",
    "mostCommonIsotopeMass": "most_common_isotope_mass_u",
}

_ELEMENT_COLUMNS = (
    "atomic_number",
    "symbol",
    "name",
    "standard_atomic_weight_u",
    "period",
    "group_number",
    "block",
    "table_row",
    "table_column",
    "category",
    "standard_state",
    "standard_state_predicted",
    "electron_configuration",
    "electron_configuration_predicted",
    "electronegativity_pauling",
    "ionization_energy_ev",
    "electron_affinity_ev",
    "oxidation_states",
    "melting_point_k",
    "boiling_point_k",
    "density_g_per_cm3",
    "year_discovered",
    "discovered_in_antiquity",
    "covalent_radius_angstrom",
    "vdw_radius_angstrom",
    "vdw_radius_source",
    "cpk_color_hex",
    "color_source",
    "valences",
    "valence_unconstrained",
    "outer_electrons",
    "most_common_isotope_mass_number",
    "most_common_isotope_mass_u",
    "source_id",
)

_ISOTOPE_COLUMNS = (
    "atomic_number",
    "neutron_number",
    "atomic_mass_u",
    "mass_from_systematics",
    "natural_abundance_percent",
    "stability",
    "half_life_seconds",
    "half_life_limit",
    "decay_mode",
    "decay_percent",
    "spin_parity",
    "source_id",
)
_ISOTOPE_JSON_COLUMNS = (
    "z",
    "n",
    "mass_u",
    "mass_from_systematics",
    "abundance_percent",
    "half_life_seconds",
    "stability",
    "half_life_limit",
    "decay_mode",
    "decay_percent",
    "spin_parity",
)


class SeedError(RuntimeError):
    pass


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def seed_is_current(conn: psycopg.Connection[Any], name: str, content_hash: str) -> bool:
    row = conn.execute("SELECT content_hash FROM seed_state WHERE name = %s", (name,)).fetchone()
    return row is not None and row["content_hash"] == content_hash


def record_seed(conn: psycopg.Connection[Any], name: str, content_hash: str, record_count: int, details: dict[str, Any]) -> None:
    conn.execute(
        """
        INSERT INTO seed_state (name, content_hash, record_count, details, applied_at)
        VALUES (%s, %s, %s, %s, now())
        ON CONFLICT (name) DO UPDATE SET content_hash = EXCLUDED.content_hash, record_count = EXCLUDED.record_count,
          details = EXCLUDED.details, applied_at = EXCLUDED.applied_at
        """,
        (name, content_hash, record_count, Jsonb(details)),
    )


def _upsert_sql(table: str, columns: tuple[str, ...], key: tuple[str, ...]) -> str:
    data_columns = [c for c in columns if c not in key]
    assignments = ", ".join(f"{c} = EXCLUDED.{c}" for c in data_columns)
    current = ", ".join(f"{table}.{c}" for c in data_columns)
    incoming = ", ".join(f"EXCLUDED.{c}" for c in data_columns)
    return (
        f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({', '.join(['%s'] * len(columns))}) "
        f"ON CONFLICT ({', '.join(key)}) DO UPDATE SET {assignments} "
        f"WHERE ({current}) IS DISTINCT FROM ({incoming})"
    )


def _source_version(source: dict[str, Any]) -> str:
    if source.get("version"):
        return str(source["version"])
    if source.get("retrieved"):
        return f"snapshot {source['retrieved']}"
    return "unversioned"


def seed_elements(conn: psycopg.Connection[Any], generated_dir: Path, *, force: bool = False) -> dict[str, Any]:
    path = generated_dir / "elements.json"
    if not path.is_file():
        raise SeedError(f"element data not found: {path}")
    digest = sha256_file(path)
    if not force and seed_is_current(conn, "elements", digest):
        count = conn.execute("SELECT count(*) AS n FROM elements").fetchone()
        return {"seed": "elements", "status": "unchanged", "records": count["n"] if count else 0}

    doc = json.loads(path.read_text(encoding="utf-8"))
    elements = doc["elements"]
    if len(elements) != 118:
        raise SeedError(f"expected 118 elements in {path}, found {len(elements)}")

    source_ids: dict[str, int] = {}
    for source in doc["sources"]:
        source_ids[source["id"]] = upsert_data_source(
            conn,
            key=source["id"],
            version=_source_version(source),
            kind="software" if source["id"].startswith("rdkit") else "reference-dataset",
            title=source["title"],
            publisher=source.get("publisher"),
            url=source.get("url"),
            license=source.get("license"),
            retrieved_on=source.get("retrieved"),
            notes=f"Fields taken from this source: {source['fields']}" if source.get("fields") else None,
        )
    for needed in ("pubchem-periodic-table", "rdkit-periodic-table"):
        if needed not in source_ids:
            raise SeedError(f"{path} does not declare the source {needed}")

    rows = []
    field_sources: list[tuple[int, int, list[str]]] = []
    for e in elements:
        antiquity = e["yearDiscovered"] == "ancient"
        rows.append(
            (
                e["z"],
                e["symbol"],
                e["name"],
                e["atomicWeight"],
                e["period"],
                e["group"],
                e["block"],
                e["tableRow"],
                e["tableColumn"],
                e["category"],
                e["standardState"],
                e["standardStatePredicted"],
                e["electronConfiguration"],
                e["electronConfigurationPredicted"],
                e["electronegativityPauling"],
                e["ionizationEnergyEv"],
                e["electronAffinityEv"],
                e["oxidationStates"],
                e["meltingPointK"],
                e["boilingPointK"],
                e["densityGPerCm3"],
                None if antiquity else e["yearDiscovered"],
                antiquity,
                e["covalentRadius"],
                e["vdwRadius"],
                e["vdwRadiusSource"],
                e["color"],
                e["colorSource"],
                e["valences"],
                e["valenceUnconstrained"],
                e["outerElectrons"],
                e["mostCommonIsotope"],
                e["mostCommonIsotopeMass"],
                source_ids["pubchem-periodic-table"],
            )
        )
        pubchem_fields = ["symbol"] + [column for key, column in _PUBCHEM_FIELDS.items() if e[key] is not None and e[key] != []]
        if antiquity:
            pubchem_fields[pubchem_fields.index("year_discovered")] = "discovered_in_antiquity"
        rdkit_fields = [column for key, column in _RDKIT_FIELDS.items() if e[key] is not None]
        (pubchem_fields if e["vdwRadiusSource"] == "pubchem" else rdkit_fields).append("vdw_radius_angstrom")
        if e["colorSource"] == "pubchem":
            pubchem_fields.append("cpk_color_hex")
        field_sources.append((e["z"], source_ids["pubchem-periodic-table"], pubchem_fields))
        field_sources.append((e["z"], source_ids["rdkit-periodic-table"], rdkit_fields))
        if e["colorSource"] == "jmol":
            if "jmol-element-colors" not in source_ids:
                raise SeedError("an element colour is attributed to Jmol but that source is not declared")
            field_sources.append((e["z"], source_ids["jmol-element-colors"], ["cpk_color_hex"]))

    with conn.cursor() as cur:
        cur.executemany(_upsert_sql("elements", _ELEMENT_COLUMNS, ("atomic_number",)), rows)
        cur.execute(
            "DELETE FROM element_sources es USING data_sources ds WHERE es.source_id = ds.id AND ds.key = ANY(%s)",
            (list(source_ids),),
        )
        cur.executemany("INSERT INTO element_sources (atomic_number, source_id, fields) VALUES (%s, %s, %s)", field_sources)
    record_seed(conn, "elements", digest, len(rows), {"file": path.name, "sources": sorted(source_ids)})
    return {"seed": "elements", "status": "applied", "records": len(rows)}


def seed_isotopes(conn: psycopg.Connection[Any], generated_dir: Path, *, force: bool = False) -> dict[str, Any]:
    path = generated_dir / "isotopes.json"
    if not path.is_file():
        raise SeedError(f"isotope data not found: {path}")
    digest = sha256_file(path)
    if not force and seed_is_current(conn, "isotopes", digest):
        count = conn.execute("SELECT count(*) AS n FROM isotopes").fetchone()
        return {"seed": "isotopes", "status": "unchanged", "records": count["n"] if count else 0}

    doc = json.loads(path.read_text(encoding="utf-8"))
    if tuple(doc["columns"]) != _ISOTOPE_JSON_COLUMNS:
        raise SeedError(f"unexpected isotope columns in {path}: {doc['columns']}")
    source = doc["source"]
    publisher = next((c.get("source") for c in source.get("citations", []) if c.get("source")), None)
    source_id = upsert_data_source(
        conn,
        key="iaea-livechart-ground-states",
        version=_source_version(source),
        kind="reference-dataset",
        title=source["source"],
        publisher=publisher,
        url=source.get("url"),
        license=source.get("license"),
        retrieved_on=source.get("retrieved"),
        citations=source.get("citations"),
        notes=source.get("notes"),
    )

    rows = []
    for z, n, mass, systematics, abundance, half_life, stability, limit, decay_mode, decay_percent, spin_parity in doc["rows"]:
        rows.append(
            (
                z,
                n,
                mass,
                bool(systematics),
                abundance,
                stability,
                half_life,
                limit,
                decay_mode or None,
                decay_percent,
                spin_parity or None,
                source_id,
            )
        )
    with conn.cursor() as cur:
        cur.executemany(_upsert_sql("isotopes", _ISOTOPE_COLUMNS, ("atomic_number", "neutron_number")), rows)
    record_seed(conn, "isotopes", digest, len(rows), {"file": path.name, "source": "iaea-livechart-ground-states"})
    return {"seed": "isotopes", "status": "applied", "records": len(rows)}
