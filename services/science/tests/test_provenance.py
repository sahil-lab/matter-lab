"""Scientific integrity: every stored record has a source, every number a unit, and every computed
result says which engine, version, method and settings produced it and whether it converged."""

from __future__ import annotations

import json
from typing import Any

import pytest
from fastapi.testclient import TestClient
from rdkit import Chem, rdBase
from rdkit.Chem import Descriptors

from matterlab_science.context import AppContext
from matterlab_science.db import Database

from .helpers import ASPIRIN, PENTAVALENT_CARBON, WATER_ATOMS, run_job, smiles

RECORD_TABLES = ("elements", "isotopes", "compounds", "functional_groups", "solvents", "catalysts", "reactions", "experiments", "discoveries", "calculations")

# Unit suffix of a column name, and the words its comment must use for that unit.
UNIT_SUFFIXES = {
    "_g_per_mol": "g/mol",
    "_g_per_cm3": "gram per cubic centimetre",
    "_angstrom": "angstrom",
    "_seconds": "seconds",
    "_percent": "percent",
    "_ev": "electronvolt",
    "_pa": "pascal",
    "_k": "kelvin",
    "_u": "atomic mass units",
}
DIMENSIONLESS = {("calculations", "progress"): "Fraction", ("elements", "electronegativity_pauling"): "dimensionless"}


# ---------------------------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------------------------


def test_every_record_table_requires_a_source(db: Database) -> None:
    rows = db.fetch_all(
        """
        SELECT cl.relname AS table_name, a.attnotnull AS required,
               EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = cl.oid AND c.contype = 'f' AND c.confrelid = 'data_sources'::regclass
                         AND a.attnum = ANY (c.conkey)) AS references_registry
        FROM pg_class cl JOIN pg_attribute a ON a.attrelid = cl.oid AND a.attname = 'source_id' AND NOT a.attisdropped
        WHERE cl.relnamespace = 'public'::regnamespace AND cl.relkind = 'r'
        """
    )
    found = {r["table_name"]: (r["required"], r["references_registry"]) for r in rows}
    for table in (*RECORD_TABLES, "element_sources"):
        assert found.get(table) == (True, True), f"{table}.source_id must be NOT NULL and reference data_sources"


def test_every_numeric_column_states_its_unit(db: Database) -> None:
    columns = db.fetch_all(
        """
        SELECT c.table_name, c.column_name, col_description(format('%I.%I', c.table_schema, c.table_name)::regclass, c.ordinal_position) AS comment
        FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
        WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.data_type IN ('double precision', 'real', 'numeric')
        """
    )
    assert len(columns) >= 20
    for column in columns:
        where = f"{column['table_name']}.{column['column_name']}"
        comment = column["comment"] or ""
        if (column["table_name"], column["column_name"]) in DIMENSIONLESS:
            assert DIMENSIONLESS[(column["table_name"], column["column_name"])] in comment, where
            continue
        suffix = next((s for s in UNIT_SUFFIXES if column["column_name"].endswith(s)), None)
        assert suffix is not None, f"{where} is a number without a unit in its name"
        assert UNIT_SUFFIXES[suffix] in comment, f"{where}: the column comment does not name the unit ({UNIT_SUFFIXES[suffix]}): {comment!r}"


# ---------------------------------------------------------------------------------------------
# Stored records
# ---------------------------------------------------------------------------------------------


def test_every_stored_record_has_a_registered_source(client: TestClient, db: Database) -> None:
    # Make sure the user-created tables are not empty when this runs on its own.
    job = run_job(client, "rdkit.geometry_optimization", {"structure": smiles("CCO")})
    reaction = client.post("/v1/reactions", json={"name": "Provenance", "reaction_smiles": "C=C.[H][H]>>CC"}).json()
    experiment = client.post("/v1/experiments", json={"title": "Provenance", "calculation_ids": [job["id"]]}).json()
    candidate = client.post("/v1/discoveries", json={"title": "Provenance", "structure": smiles("OC(=O)C1CC1c1ccncc1")}).json()

    for table in RECORD_TABLES:
        summary = db.fetch_one(
            f"""
            SELECT count(*) AS n, count(ds.id) AS with_source,
                   count(*) FILTER (WHERE btrim(ds.key) <> '' AND btrim(ds.version) <> '' AND btrim(ds.title) <> '') AS described,
                   array_agg(DISTINCT ds.key) AS keys, array_agg(DISTINCT ds.kind) AS kinds
            FROM {table} t LEFT JOIN data_sources ds ON ds.id = t.source_id
            """
        )
        assert summary["n"] > 0, f"{table} is empty"
        assert summary["n"] == summary["with_source"] == summary["described"], f"{table} has rows without a described source"
        expected = {
            "elements": {"pubchem-periodic-table"},
            "isotopes": {"iaea-livechart-ground-states"},
            "functional_groups": {"rdkit-data-files"},
            "compounds": {"pubchem-compound"},
            "solvents": {"pubchem-compound"},
            "catalysts": {"pubchem-compound"},
            "reactions": {"matterlab-user"},
            "experiments": {"matterlab-user"},
            "discoveries": {"matterlab-user"},
        }.get(table)
        if expected is not None:
            assert set(summary["keys"]) == expected, table
        else:  # calculations: the engine that ran them (or the service itself for an unsupported verdict)
            assert set(summary["keys"]) <= {"rdkit", "xtb-tblite", "pyscf", "matterlab-science"} and "rdkit" in summary["keys"]
            assert set(summary["kinds"]) == {"software"}

    # Elements combine three sources; which field came from which is recorded per element.
    per_field = db.fetch_one(
        "SELECT count(DISTINCT es.atomic_number) AS elements, array_agg(DISTINCT ds.key) AS keys FROM element_sources es JOIN data_sources ds ON ds.id = es.source_id"
    )
    assert per_field["elements"] == 118 and set(per_field["keys"]) == {"pubchem-periodic-table", "rdkit-periodic-table", "jmol-element-colors"}
    # Catalogue records keep the address of the record they were taken from and what PubChem returned.
    unlinked = db.fetch_one("SELECT count(*) AS n FROM compounds WHERE source_url IS NULL OR source_record IS NULL OR NOT (external_ids ? 'pubchem_cid') OR derived_by IS NULL")
    assert unlinked["n"] == 0

    for path in (f"/v1/experiments/{experiment['id']}", f"/v1/discoveries/{candidate['id']}", f"/v1/reactions/{reaction['id']}"):
        assert client.delete(path).status_code == 204


def test_the_source_registry_is_complete(client: TestClient) -> None:
    sources = {f"{s['key']}@{s['version']}": s for s in client.get("/v1/data-sources").json()["items"]}
    by_key = {s["key"]: s for s in sources.values()}
    for source in sources.values():
        assert source["key"] and source["version"] and source["title"] and source["kind"] in ("reference-dataset", "software", "external-service", "user", "import")
        if source["kind"] in ("reference-dataset", "external-service"):
            assert source["url"] and source["url"].startswith("https://") and source["publisher"], source["key"]

    # Reference data: where it came from, which snapshot, when it was retrieved, and its terms where the source states them.
    for key in ("pubchem-periodic-table", "pubchem-compound"):
        assert by_key[key]["retrieved_on"] and by_key[key]["version"] == f"snapshot {by_key[key]['retrieved_on']}" and by_key[key]["license"], key
        assert "National Center for Biotechnology Information" in by_key[key]["publisher"]
    isotopes = by_key["iaea-livechart-ground-states"]
    assert isotopes["retrieved_on"] and isotopes["version"].startswith("dataset extraction ") and len(isotopes["citations"]) == 3
    assert all(citation["title"] for citation in isotopes["citations"])
    assert by_key["pubchem-compound"]["citations"] and "pubchem.ncbi.nlm.nih.gov" in by_key["pubchem-compound"]["url"]
    assert "Retrieved" in by_key["pubchem-compound"]["notes"], "the retrieval window of the snapshot is recorded"

    # Software sources carry the version that is actually installed.
    engines = {e["id"]: e for e in client.get("/v1/engines").json()["engines"]}
    assert by_key["rdkit"]["version"] == by_key["rdkit-data-files"]["version"] == by_key["rdkit-periodic-table"]["version"] == rdBase.rdkitVersion == engines["rdkit"]["version"]
    assert by_key["rdkit"]["license"] == "BSD-3-Clause" and by_key["rdkit"]["kind"] == "software"
    for engine_id, key in (("xtb", "xtb-tblite"), ("pyscf", "pyscf")):
        if engines[engine_id]["available"]:
            assert by_key[key]["version"] == engines[engine_id]["version"] and by_key[key]["license"] == engines[engine_id]["license"]
        else:
            assert key not in by_key, "an engine that is not installed is not registered as a source"
    assert by_key["matterlab-user"]["kind"] == "user" and "not verified" in by_key["matterlab-user"]["notes"]


# ---------------------------------------------------------------------------------------------
# API records
# ---------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("path", "params", "source_key", "evidence"),
    [
        ("/v1/elements", {}, "pubchem-periodic-table", "reference"),
        ("/v1/isotopes", {"limit": 5000}, "iaea-livechart-ground-states", "reference"),
        ("/v1/functional-groups", {"limit": 2000}, "rdkit-data-files", "rule-based"),
        ("/v1/solvents", {"limit": 1000}, "pubchem-compound", "reference"),
        ("/v1/catalysts", {"limit": 1000}, "pubchem-compound", "reference"),
        ("/v1/compounds", {"limit": 500}, "pubchem-compound", "reference"),
    ],
)
def test_list_items_name_their_source(client: TestClient, path: str, params: dict[str, Any], source_key: str, evidence: str) -> None:
    page = client.get(path, params=params).json()
    assert page["total"] == len(page["items"]) > 0
    assert page["sources"], "the page carries the provenance of the sources its items refer to"
    for item in page["items"]:
        assert item["source"] in page["sources"], f"{path}: item refers to a source that is not on the page"
        assert item["evidence"] == evidence
    assert {page["sources"][item["source"]]["source_key"] for item in page["items"]} == {source_key}
    for reference, provenance in page["sources"].items():
        assert reference == f"{provenance['source_key']}@{provenance['version']}"
        assert provenance["source"] and provenance["kind"] and provenance["version"] and provenance["url"]


def test_detail_records_embed_their_provenance(client: TestClient) -> None:
    iron = client.get("/v1/elements/Fe").json()
    assert iron["provenance"]["source_key"] == "pubchem-periodic-table" and iron["provenance"]["retrieved"] and iron["provenance"]["license"]
    fields = {entry["provenance"]["source_key"]: set(entry["fields"]) for entry in iron["field_provenance"]}
    assert {"standard_atomic_weight_u", "melting_point_k", "density_g_per_cm3"} <= fields["pubchem-periodic-table"]
    assert {"covalent_radius_angstrom", "most_common_isotope_mass_u"} <= fields["rdkit-periodic-table"]
    attributed = set().union(*fields.values())
    structural = {"atomic_number", "symbol", "period", "group_number", "block", "table_row", "table_column"}
    unattributed = {key for key in iron if key not in attributed | structural | {"provenance", "field_provenance", "note", "evidence", "source"} and iron[key] is not None}
    assert unattributed <= {"vdw_radius_source", "color_source", "standard_state_predicted", "electron_configuration_predicted", "discovered_in_antiquity"}, unattributed
    erbium = client.get("/v1/elements/Er").json()
    assert erbium["color_source"] == "jmol" and any(e["provenance"]["source_key"] == "jmol-element-colors" and e["fields"] == ["cpk_color_hex"] for e in erbium["field_provenance"])

    aspirin = client.get("/v1/compounds", params={"name": "aspirin"}).json()["items"][0]
    compound = client.get(f"/v1/compounds/{aspirin['id']}").json()
    assert compound["provenance"]["source_key"] == "pubchem-compound" and compound["provenance"]["retrieved"] and compound["provenance"]["citations"]
    assert compound["source_url"] == "https://pubchem.ncbi.nlm.nih.gov/compound/2244" and compound["external_ids"] == {"pubchem_cid": 2244}
    assert compound["derived_by"]["engine"] == "RDKit" and compound["derived_by"]["version"] == rdBase.rdkitVersion, "identifiers were recomputed by RDKit"
    assert compound["fingerprint_params"]["morgan"]["radius"] == 2 and compound["fingerprint_params"]["morgan"]["bits"] == 2048, "the stored fingerprint says how it was made"
    assert compound["evidence"] == "reference"

    solvent = client.get("/v1/solvents", params={"limit": 1000}).json()["items"][0]
    detail = client.get(f"/v1/solvents/{solvent['id']}").json()
    assert detail["provenance"]["source_key"] == "pubchem-compound"
    for item in detail["properties"]:
        assert item["name"] and item["value"] is not None and item["unit"] and item["source"] and item["retrieved"], "a stored property has its unit and its source"


def test_units_are_explicit_in_field_names(client: TestClient, ctx: AppContext) -> None:
    iron = client.get("/v1/elements/26").json()
    for field in ("standard_atomic_weight_u", "ionization_energy_ev", "electron_affinity_ev", "melting_point_k", "boiling_point_k", "density_g_per_cm3", "covalent_radius_angstrom", "vdw_radius_angstrom", "most_common_isotope_mass_u"):
        assert isinstance(iron[field], float), field
    tritium = next(i for i in client.get("/v1/isotopes", params={"symbol": "H"}).json()["items"] if i["mass_number"] == 3)
    assert tritium["half_life_seconds"] > 0 and tritium["atomic_mass_u"] > 3 and tritium["natural_abundance_percent"] is None and "decay_percent" in tritium
    # The catalogue masses are RDKit's, and they agree with what PubChem returned for the record.
    aspirin = client.get("/v1/compounds", params={"name": "aspirin"}).json()["items"][0]
    mol = Chem.MolFromSmiles(ASPIRIN)
    assert aspirin["molecular_weight_g_per_mol"] == pytest.approx(Descriptors.MolWt(mol)) and aspirin["monoisotopic_mass_u"] == pytest.approx(Descriptors.ExactMolWt(mol))
    fetched = json.loads((ctx.settings.seed_dir / "pubchem" / "snapshot.json").read_text(encoding="utf-8"))["records"][str(aspirin["external_ids"]["pubchem_cid"])]["properties"]
    assert aspirin["molecular_weight_g_per_mol"] == pytest.approx(float(fetched["MolecularWeight"]), abs=0.01)
    assert aspirin["monoisotopic_mass_u"] == pytest.approx(float(fetched["MonoisotopicMass"]), abs=0.001)


# ---------------------------------------------------------------------------------------------
# Computed results
# ---------------------------------------------------------------------------------------------


def test_synchronous_results_name_engine_method_and_evidence(client: TestClient) -> None:
    stamp = {"engine": "RDKit", "version": rdBase.rdkitVersion}
    validated = client.post("/v1/chem/validate", json={"structure": smiles(ASPIRIN)}).json()
    assert {k: validated["engine"][k] for k in stamp} == stamp and validated["engine"]["inchi_software_version"]

    embedded = client.post("/v1/chem/3d", json={"structure": smiles(ASPIRIN)}).json()
    assert {k: embedded["engine"][k] for k in stamp} == stamp and embedded["evidence"] == "computed"
    assert embedded["embedding"]["method"] == "ETKDGv3" and embedded["embedding"]["succeeded"] is True and isinstance(embedded["embedding"]["random_seed"], int)
    assert embedded["force_field"]["used"] == "MMFF94" and embedded["force_field"]["converged"] is True and embedded["force_field"]["max_iterations"] == 500
    assert embedded["coordinate_unit"] == "angstrom" and embedded["energy_unit"] == "kcal/mol"

    described = client.post("/v1/chem/descriptors", json={"structure": smiles(ASPIRIN)}).json()
    assert {k: described["engine"][k] for k in stamp} == stamp
    for name, value in described["descriptors"].items():
        assert value["method"] and value["evidence"] in ("computed", "rule-based") and isinstance(value["is_estimate"], bool), name
    logp = described["descriptors"]["logp"]
    assert logp["is_estimate"] is True and logp["evidence"] == "rule-based" and "Crippen" in logp["method"], "logP is labelled as an estimate"
    assert described["descriptors"]["molecular_weight"]["unit"] == "g/mol" and described["descriptors"]["molecular_weight"]["is_estimate"] is False
    assert described["descriptors"]["tpsa"]["unit"] == "angstrom^2"

    groups = client.post("/v1/chem/functional-groups", json={"structure": smiles(ASPIRIN)}).json()
    assert groups["evidence"] == "rule-based" and {k: groups["engine"][k] for k in stamp} == stamp


def test_computed_results_record_engine_version_method_settings_and_convergence(client: TestClient, ctx: AppContext, db: Database) -> None:
    jobs = [
        run_job(client, "rdkit.geometry_optimization", {"structure": smiles("CCO")}),
        run_job(client, "rdkit.conformer_search", {"structure": smiles("CCCO")}, {"num_conformers": 5}),
        run_job(client, "rdkit.geometry_optimization", {"structure": smiles(PENTAVALENT_CARBON)}),
        run_job(client, "rdkit.geometry_optimization", {"structure": smiles("F[Xe]F")}),
    ]
    water = {"structure": {"format": "atoms", "atoms": WATER_ATOMS}}
    if ctx.engines.get("xtb").available:
        jobs.append(run_job(client, "xtb.single_point", water))
    if ctx.engines.get("pyscf").available:
        jobs.append(run_job(client, "pyscf.single_point", water))
    assert [job["status"] for job in jobs[:4]] == ["succeeded", "succeeded", "failed", "unsupported"]

    engines = {e["id"]: e for e in client.get("/v1/engines").json()["engines"]}
    for job in jobs:
        where = f"{job['kind']} ({job['status']})"
        engine = engines[job["engine"]["id"]]
        assert job["engine"]["version"] == engine["version"], f"{where}: the version is the one detected at runtime"
        assert len(job["input_hash"]) == 64 and isinstance(job["settings"], dict) and job["settings"], f"{where}: settings are stored with defaults filled in"
        assert job["provenance"]["kind"] == "software" and job["provenance"]["version"] == job["engine"]["version"], where
        assert job["software"]["python"] and job["software"]["matterlab_science"], where
        if job["status"] == "succeeded":
            assert job["method"] and isinstance(job["converged"], bool) and job["result"] is not None and job["error"] is None, where
            if job["engine"]["id"] == "rdkit":
                assert job["result"]["units"]["coordinates"] == "angstrom" and job["result"]["units"]["energy"] == "kcal/mol", where
            else:
                assert "energy_hartree" in job["result"] and "CODATA" in job["result"]["conversions"]["source"], f"{where}: units are in the field names"
        else:
            assert job["result"] is None and job["converged"] is None, f"{where}: no result is invented for a job that did not succeed"
            assert job["error"]["code"] and job["error"]["message"], where

    # The same holds for every calculation this test session has stored, whatever happened to it.
    broken = db.fetch_all(
        """
        SELECT id, kind, status FROM calculations WHERE
             engine IS NULL OR btrim(engine) = '' OR input_hash !~ '^[0-9a-f]{64}$' OR jsonb_typeof(settings) <> 'object'
          OR (status = 'succeeded' AND (result IS NULL OR method IS NULL OR converged IS NULL OR engine_version IS NULL OR finished_at IS NULL OR error IS NOT NULL))
          OR (status IN ('failed', 'unsupported') AND (error IS NULL OR NOT (error ? 'code') OR NOT (error ? 'message') OR result IS NOT NULL))
          OR (status = 'cancelled' AND result IS NOT NULL)
          OR (status IN ('succeeded', 'failed', 'cancelled', 'unsupported') AND finished_at IS NULL)
        """
    )
    assert broken == [], broken

    if len(jobs) == 6:
        xtb, pyscf = jobs[4], jobs[5]
        assert xtb["status"] == "succeeded" and xtb["method"] == "GFN2-xTB" and xtb["converged"] is True and xtb["provenance"]["source_key"] == "xtb-tblite"
        assert xtb["software"]["tblite"] == engines["xtb"]["version"]
        assert pyscf["status"] == "succeeded" and pyscf["method"].startswith("RHF/") and pyscf["converged"] is True and pyscf["provenance"]["source_key"] == "pyscf"
        assert pyscf["software"]["pyscf"] == engines["pyscf"]["version"]
