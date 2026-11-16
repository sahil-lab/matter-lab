"""Tier 1 and 4: seeded reference data, its sources, and the idempotency of seeding."""

from __future__ import annotations

import json
import math

import pytest

from matterlab_science.chem import functional_groups
from matterlab_science.config import Settings
from matterlab_science.db import Database
from matterlab_science.seeding.run import seed_all


@pytest.fixture(scope="module")
def generated(settings: Settings) -> dict:
    return {
        "elements": json.loads((settings.generated_data_dir / "elements.json").read_text(encoding="utf-8")),
        "isotopes": json.loads((settings.generated_data_dir / "isotopes.json").read_text(encoding="utf-8")),
    }


@pytest.fixture(scope="module")
def snapshot(settings: Settings) -> dict:
    return {
        "names": json.loads((settings.seed_dir / "pubchem" / "names.json").read_text(encoding="utf-8")),
        "snapshot": json.loads((settings.seed_dir / "pubchem" / "snapshot.json").read_text(encoding="utf-8")),
    }


def test_all_118_elements_are_seeded(db: Database, generated: dict) -> None:
    rows = db.fetch_all("SELECT * FROM elements ORDER BY atomic_number")
    assert len(rows) == 118
    assert [r["atomic_number"] for r in rows] == list(range(1, 119))
    by_z = {e["z"]: e for e in generated["elements"]["elements"]}
    for row in rows:
        source = by_z[row["atomic_number"]]
        assert row["symbol"] == source["symbol"] and row["name"] == source["name"]
        assert row["standard_atomic_weight_u"] == source["atomicWeight"]
        assert row["electronegativity_pauling"] == source["electronegativityPauling"]
        assert row["melting_point_k"] == source["meltingPointK"]
        assert row["density_g_per_cm3"] == source["densityGPerCm3"]
        assert row["oxidation_states"] == source["oxidationStates"]
        assert row["covalent_radius_angstrom"] == source["covalentRadius"]
        assert row["cpk_color_hex"] == source["color"]
        if source["yearDiscovered"] == "ancient":
            assert row["discovered_in_antiquity"] is True and row["year_discovered"] is None
        else:
            assert row["discovered_in_antiquity"] is False and row["year_discovered"] == source["yearDiscovered"]


def test_isotopes_are_seeded_exactly_as_in_the_source_file(db: Database, generated: dict) -> None:
    expected = generated["isotopes"]["rows"]
    count = db.fetch_one("SELECT count(*) AS n FROM isotopes")
    assert count["n"] == len(expected)
    assert count["n"] > 3000
    rows = {
        (r["atomic_number"], r["neutron_number"]): r
        for r in db.fetch_all("SELECT * FROM isotopes")
    }
    for z, n, mass, systematics, abundance, half_life, stability, limit, decay_mode, decay_percent, spin_parity in expected:
        row = rows[(z, n)]
        assert row["mass_number"] == z + n
        assert row["atomic_mass_u"] == mass
        assert row["mass_from_systematics"] is bool(systematics)
        assert row["natural_abundance_percent"] == abundance
        assert row["stability"] == stability
        assert (row["half_life_seconds"] is None and half_life is None) or math.isclose(row["half_life_seconds"], half_life, rel_tol=0, abs_tol=0)
        assert row["half_life_limit"] == limit
        assert row["decay_mode"] == (decay_mode or None)
        assert row["decay_percent"] == decay_percent
        assert row["spin_parity"] == (spin_parity or None)


def test_sources_are_registered_with_their_metadata(db: Database, generated: dict, snapshot: dict) -> None:
    sources = {r["key"]: r for r in db.fetch_all("SELECT * FROM data_sources")}
    for declared in generated["elements"]["sources"]:
        row = sources[declared["id"]]
        assert row["title"] == declared["title"]
        assert row["url"] == declared["url"]
        assert row["license"] == declared.get("license")
        assert (row["retrieved_on"].isoformat() if row["retrieved_on"] else None) == declared.get("retrieved")
        if declared.get("version"):
            assert row["version"] == declared["version"]

    iaea = sources["iaea-livechart-ground-states"]
    declared = generated["isotopes"]["source"]
    assert iaea["title"] == declared["source"]
    assert iaea["version"] == declared["version"]
    assert iaea["url"] == declared["url"]
    assert iaea["retrieved_on"].isoformat() == declared["retrieved"]
    assert iaea["citations"] == declared["citations"]

    pubchem = sources["pubchem-compound"]
    assert pubchem["retrieved_on"].isoformat() == snapshot["snapshot"]["retrieved_on"]
    assert pubchem["kind"] == "external-service"
    assert pubchem["url"] and pubchem["license"] and "PubChem" in pubchem["notes"]

    rdkit_files = sources["rdkit-data-files"]
    assert rdkit_files["kind"] == "software" and rdkit_files["version"]
    assert {"matterlab-user", "matterlab-science", "rdkit"} <= set(sources)


def test_element_field_provenance_names_the_right_source(db: Database, generated: dict) -> None:
    rows = db.fetch_all(
        "SELECT es.atomic_number, ds.key, es.fields FROM element_sources es JOIN data_sources ds ON ds.id = es.source_id"
    )
    fields = {(r["atomic_number"], r["key"]): set(r["fields"]) for r in rows}
    for element in generated["elements"]["elements"]:
        z = element["z"]
        vdw_owner = "pubchem-periodic-table" if element["vdwRadiusSource"] == "pubchem" else "rdkit-periodic-table"
        assert "vdw_radius_angstrom" in fields[(z, vdw_owner)]
        assert "covalent_radius_angstrom" in fields[(z, "rdkit-periodic-table")]
        assert "standard_atomic_weight_u" in fields[(z, "pubchem-periodic-table")]
        if element["colorSource"] == "jmol":
            assert fields[(z, "jmol-element-colors")] == {"cpk_color_hex"}
        if element["colorSource"] == "fallback":
            assert all("cpk_color_hex" not in f for (number, _), f in fields.items() if number == z), "a fallback colour has no source"


def test_functional_groups_come_from_rdkit_data_files(db: Database) -> None:
    definitions, rejected, _ = functional_groups.rdkit_definitions()
    assert rejected == []
    rows = db.fetch_all("SELECT group_set, key, name, smarts FROM functional_groups")
    assert {(r["group_set"], r["key"]): r["smarts"] for r in rows} == {(d["group_set"], d["key"]): d["smarts"] for d in definitions}
    counts = {s: sum(1 for r in rows if r["group_set"] == s) for s in functional_groups.SET_INFO}
    assert all(count > 0 for count in counts.values()), counts


def test_starter_catalogue_is_the_pubchem_snapshot(db: Database, snapshot: dict) -> None:
    names, snap = snapshot["names"], snapshot["snapshot"]
    resolved = {e["name"]: e["chosen_cid"] for e in snap["name_resolution"]}
    wanted = [n for n in dict.fromkeys(names["compounds"] + names["solvents"]) if resolved.get(n) is not None]
    rows = db.fetch_all("SELECT name, inchikey, external_ids, source_record, canonical_smiles FROM compounds")
    assert 150 <= len(rows) <= 300
    assert {r["external_ids"]["pubchem_cid"] for r in rows} == {resolved[n] for n in wanted}
    for row in rows:
        record = snap["records"][str(row["external_ids"]["pubchem_cid"])]["properties"]
        # RDKit recomputed the identifier from the PubChem structure; it must agree with PubChem's own.
        assert row["inchikey"] == record["InChIKey"], row["name"]
        assert row["source_record"]["inchikey_matches_source"] is True
        assert row["name"] == record["Title"]

    solvents = db.fetch_all("SELECT name, structure_status, inchikey, compound_id, properties FROM solvents")
    assert {s["name"] for s in solvents} == {n for n in names["solvents"] if resolved.get(n) is not None}
    assert all(s["structure_status"] == "rdkit-validated" and s["compound_id"] is not None for s in solvents)
    catalysts = db.fetch_all("SELECT name, external_ids, properties FROM catalysts")
    assert {c["name"] for c in catalysts} == {n for n in names["catalysts"] if resolved.get(n) is not None}
    for record in solvents + catalysts:
        # Only values that were actually fetched, each with its source.
        for prop in record["properties"]:
            assert prop["source"] and prop["retrieved"] == snap["retrieved_on"] and prop["unit"]


def test_unresolved_names_are_reported_not_invented(db: Database, snapshot: dict) -> None:
    unresolved = [e["name"] for e in snapshot["snapshot"]["name_resolution"] if e["chosen_cid"] is None]
    state = db.fetch_one("SELECT details FROM seed_state WHERE name = 'pubchem-catalogue'")
    assert sorted(s["name"] for s in state["details"]["skipped"]) == sorted(unresolved)
    for name in unresolved:
        assert db.fetch_one("SELECT 1 AS x FROM compound_synonyms WHERE name_normalized = lower(%s)", (name,)) is None


def test_seeding_is_idempotent(db: Database, settings: Settings) -> None:
    tables = ("elements", "isotopes", "compounds", "compound_synonyms", "functional_groups", "solvents", "catalysts", "data_sources", "element_sources")
    before = {t: db.fetch_one(f"SELECT count(*) AS n, max(updated_at) AS latest FROM {t}" if t not in ("compound_synonyms", "element_sources") else f"SELECT count(*) AS n, NULL AS latest FROM {t}") for t in tables}

    reports = seed_all(settings)
    assert {r["seed"]: r["status"] for r in reports if r["seed"] != "core-sources"} == {
        "elements": "unchanged",
        "isotopes": "unchanged",
        "functional-groups": "unchanged",
        "pubchem-catalogue": "unchanged",
    }
    # Forcing every seed to run again must still not create or modify a single row.
    forced = seed_all(settings, force=True)
    assert all(r["status"] == "applied" for r in forced)
    after = {t: db.fetch_one(f"SELECT count(*) AS n, max(updated_at) AS latest FROM {t}" if t not in ("compound_synonyms", "element_sources") else f"SELECT count(*) AS n, NULL AS latest FROM {t}") for t in tables}
    assert after == before
