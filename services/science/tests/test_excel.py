"""Tier 6: Excel export and import. These tests use their own database and application instance,
so they are free to change reference data without affecting the other tests."""

from __future__ import annotations

import io
import json
import uuid
from dataclasses import replace
from typing import Any, Callable, Iterator

import pytest
from fastapi.testclient import TestClient
from openpyxl import Workbook, load_workbook
from rdkit import Chem

from matterlab_science.config import Settings
from matterlab_science.db import Database
from matterlab_science.excel.exporter import export_workbook
from matterlab_science.excel.importer import import_workbook
from matterlab_science.excel.spec import SHEET_ORDER
from matterlab_science.jobs.hashing import input_hash
from matterlab_science.main import create_app
from matterlab_science.migrations import migrate
from matterlab_science.seeding.run import seed_all

from .helpers import PENTAVALENT_CARBON, Contract, is_error_shape, run_job, smiles

SHEETS = ["Elements", "Isotopes", "Compounds", "Functional Groups", "Catalysts", "Solvents", "Reactions", "Experiments", "Discoveries", "Calculations"]
TABLES = {
    "Elements": "elements",
    "Isotopes": "isotopes",
    "Compounds": "compounds",
    "Functional Groups": "functional_groups",
    "Catalysts": "catalysts",
    "Solvents": "solvents",
    "Reactions": "reactions",
    "Experiments": "experiments",
    "Discoveries": "discoveries",
    "Calculations": "calculations",
}
PROVENANCE_HEADERS = ["Source key", "Source version", "Source title", "Source URL", "Source retrieved (ISO 8601 date)", "Source licence"]
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
PHENACETIN = "CCOc1ccc(NC(C)=O)cc1"
PHENACETIN_INCHIKEY = "CPJSUEIXXCENMM-UHFFFAOYSA-N"


# ---------------------------------------------------------------------------------------------
# Fixtures and workbook helpers
# ---------------------------------------------------------------------------------------------


@pytest.fixture(scope="module")
def xl(settings: Settings, database_factory: Callable[[], str]) -> Iterator[TestClient]:
    """A second service instance on its own freshly migrated and seeded database."""
    own = replace(settings.with_database(database_factory()), job_workers=2, job_warm_workers=1)
    with TestClient(create_app(own)) as client:
        yield client


@pytest.fixture(scope="module")
def xdb(xl: TestClient) -> Database:
    return xl.app.state.ctx.db  # type: ignore[attr-defined]


@pytest.fixture(scope="module")
def content(xl: TestClient) -> dict[str, Any]:
    """Records of every kind, so that all ten sheets have something to export."""
    optimisation = run_job(xl, "rdkit.geometry_optimization", {"structure": smiles("CCO")})
    unsupported = run_job(xl, "rdkit.geometry_optimization", {"structure": smiles("F[Xe]F")})
    failed = run_job(xl, "rdkit.geometry_optimization", {"structure": smiles(PENTAVALENT_CARBON)})
    assert (optimisation["status"], unsupported["status"], failed["status"]) == ("succeeded", "unsupported", "failed")
    reaction = xl.post("/v1/reactions", json={"name": "Hydrogen combustion", "reaction_smiles": "[H][H].[H][H].O=O>>O.O", "temperature_k": 298.15}).json()
    solvents = {s["name"]: s["id"] for s in xl.get("/v1/solvents", params={"limit": 1000}).json()["items"]}
    catalysts = {c["name"]: c["id"] for c in xl.get("/v1/catalysts", params={"limit": 1000}).json()["items"]}
    hydrogenation = xl.post(
        "/v1/reactions",
        json={
            "name": "Styrene hydrogenation (as planned)",
            "reaction_smiles": "C=Cc1ccccc1.[H][H]>>CCc1ccccc1",
            "solvent_id": solvents["ethanol"],
            "catalyst_id": catalysts["platinum dioxide"],
            "pressure_pa": 101325.0,
        },
    )
    assert hydrogenation.status_code == 201, hydrogenation.text
    experiment = xl.post(
        "/v1/experiments",
        json={
            "title": "Ethanol study",
            "inputs": {"structure": smiles("CCO"), "label": "été – 分子"},
            "settings": {"temperature_k": 298.15},
            "tags": ["demo", "ethanol"],
            "reaction_id": reaction["id"],
            "calculation_ids": [optimisation["id"], failed["id"]],
        },
    ).json()
    candidate = xl.post("/v1/discoveries", json={"title": "Candidate A", "structure": smiles("OC(=O)C1CC1c1ccncc1")}).json()
    job = run_job(xl, "rdkit.geometry_optimization", {"structure": smiles("OC(=O)C1CC1c1ccncc1")})
    xl.post(f"/v1/discoveries/{candidate['id']}/evidence", json={"kind": "calculation", "calculation_id": job["id"]})
    candidate = xl.post(f"/v1/discoveries/{candidate['id']}/status", json={"status": "computationally-plausible", "justification": "converged MMFF94"}).json()
    invalid = xl.post("/v1/discoveries", json={"title": "Impossible carbon", "structure": smiles(PENTAVALENT_CARBON)}).json()
    # A result that does not fit into a worksheet cell (a cell holds at most 32,767 characters).
    long = run_job(xl, "rdkit.geometry_optimization", {"structure": smiles("CCCCCCCCCCCC")}, {"record_trajectory": True, "trajectory_max_frames": 30})
    assert long["status"] == "succeeded" and len(json.dumps(long["result"], separators=(",", ":"))) > 32_767
    return {
        "optimisation": optimisation,
        "unsupported": unsupported,
        "failed": failed,
        "reaction": reaction,
        "hydrogenation": hydrogenation.json(),
        "experiment": experiment,
        "candidate": candidate,
        "invalid": invalid,
        "job": job,
        "long": long,
    }


@pytest.fixture()
def exported(xl: TestClient, content: dict[str, Any]) -> bytes:
    response = xl.get("/v1/excel/export")
    assert response.status_code == 200, response.text
    return response.content


def book(data: bytes) -> Workbook:
    return load_workbook(io.BytesIO(data))


def to_bytes(workbook: Workbook) -> bytes:
    buffer = io.BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()


def headers(sheet: Any) -> list[str]:
    return [cell.value for cell in sheet[1] if cell.value is not None]


def column(sheet: Any, header: str) -> int:
    return headers(sheet).index(header) + 1


def find_row(sheet: Any, header: str, value: Any) -> int:
    index = column(sheet, header)
    for row in range(2, sheet.max_row + 1):
        if sheet.cell(row=row, column=index).value == value:
            return row
    raise AssertionError(f"no row with {header} = {value!r} in sheet {sheet.title}")


def set_cell(sheet: Any, row: int, header: str, value: Any) -> None:
    sheet.cell(row=row, column=column(sheet, header)).value = value


def add(sheet: Any, values: dict[str, Any]) -> int:
    """Appends a row; texts are stored as text cells, as a spreadsheet user typing them would."""
    names = headers(sheet)
    row = sheet.max_row + 1
    for header, value in values.items():
        assert header in names, header
        cell = sheet.cell(row=row, column=names.index(header) + 1)
        cell.value = value
        if isinstance(value, str):
            cell.data_type = "s"
    return row


def upload(client: TestClient, data: bytes, filename: str = "edited.xlsx", **params: Any) -> Any:
    return client.post("/v1/excel/import", files={"file": (filename, data, XLSX)}, params=params)


def fingerprint(db: Database) -> dict[str, Any]:
    """A cheap but sensitive summary of the database state."""
    state: dict[str, Any] = {}
    for table in (*TABLES.values(), "data_sources"):
        state[table] = db.fetch_one(f"SELECT count(*) AS n, max(updated_at) AS latest FROM {table}")
    for table in ("compound_synonyms", "element_sources", "reaction_participants", "experiment_calculations", "discovery_evidence", "discovery_catalog_searches"):
        state[table] = db.fetch_one(f"SELECT count(*) AS n FROM {table}")
    return state


def problems(report: dict[str, Any]) -> set[tuple[str, int, str | None, str]]:
    return {(e["sheet"], e["row"], e["column"], e["code"]) for e in report["errors"]}


# ---------------------------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------------------------


def test_export_has_exactly_the_ten_sheets_in_order(xl: TestClient, xdb: Database, contract: Contract, content: dict[str, Any]) -> None:
    response = xl.get("/v1/excel/export")
    contract.check("GET", "/v1/excel/export", response)
    assert response.status_code == 200 and response.headers["content-type"] == XLSX
    assert response.headers["content-disposition"].startswith('attachment; filename="matterlab-export-') and response.headers["content-disposition"].endswith('.xlsx"')
    workbook = book(response.content)
    assert workbook.sheetnames == SHEETS == list(SHEET_ORDER), "exactly these worksheets, in this order, and no others"

    schema_version = xdb.fetch_one("SELECT max(version) AS v FROM schema_migrations")["v"]
    assert response.headers["x-matterlab-schema-version"] == schema_version
    properties = workbook.properties
    assert properties.title == "MATTER LAB database export"
    assert f"schema version {schema_version}" in properties.description and response.headers["x-matterlab-exported-at"] in properties.description
    custom = {p.name: p.value for p in workbook.custom_doc_props.props}
    assert custom["matterlab_schema_version"] == schema_version and custom["matterlab_exported_at_utc"] == response.headers["x-matterlab-exported-at"]
    assert custom["matterlab_format"] == "matterlab-workbook/1"

    published = {s["name"]: [c["header"] for c in s["columns"]] for s in contract.check("GET", "/v1/excel/format", xl.get("/v1/excel/format"))["sheets"]}
    assert list(published) == SHEETS
    for name in SHEETS:
        sheet = workbook[name]
        assert headers(sheet) == published[name], name
        assert headers(sheet)[-6:] == PROVENANCE_HEADERS, f"{name} ends with the provenance columns"
        count = xdb.fetch_one(f"SELECT count(*) AS n FROM {TABLES[name]}")["n"]
        assert sheet.max_row - 1 == count, f"{name} has one row per record"
        assert count > 0, f"{name} should not be empty in this test"
    assert workbook["Elements"].max_row - 1 == 118 and workbook["Isotopes"].max_row - 1 > 3000


def test_headers_carry_units(exported: bytes) -> None:
    workbook = book(exported)
    expected = {
        "Elements": ["Standard atomic weight (u)", "Ionisation energy (eV)", "Electron affinity (eV)", "Melting point (K)", "Boiling point (K)", "Density (g/cm^3)", "Covalent radius (angstrom)", "Van der Waals radius (angstrom)", "Most common isotope mass (u)"],
        "Isotopes": ["Atomic mass (u)", "Natural abundance (%)", "Half-life (s)", "Decay branching (%)"],
        "Compounds": ["Molecular weight (g/mol)", "Monoisotopic mass (u)", "Formal charge (e)"],
        "Reactions": ["Temperature (K)", "Pressure (Pa)"],
        "Discoveries": ["Molecular weight (g/mol)", "Monoisotopic mass (u)"],
        "Calculations": ["Timeout (s)", "Created at (UTC)", "Finished at (UTC)", "Input hash (SHA-256)"],
    }
    for name, wanted in expected.items():
        assert set(wanted) <= set(headers(workbook[name])), name


def test_exported_values_and_provenance(xl: TestClient, xdb: Database, exported: bytes, content: dict[str, Any]) -> None:
    workbook = book(exported)

    def record(name: str, row: int) -> dict[str, Any]:
        sheet = workbook[name]
        return {header: sheet.cell(row=row, column=index + 1).value for index, header in enumerate(headers(sheet))}

    # Every data row of every sheet names its source.
    for name in SHEETS:
        sheet = workbook[name]
        key, version, title = column(sheet, "Source key"), column(sheet, "Source version"), column(sheet, "Source title")
        for row in range(2, sheet.max_row + 1):
            assert sheet.cell(row=row, column=key).value and sheet.cell(row=row, column=version).value and sheet.cell(row=row, column=title).value, (name, row)

    hydrogen = record("Elements", find_row(workbook["Elements"], "Atomic number", 1))
    stored = xdb.fetch_one("SELECT * FROM elements WHERE atomic_number = 1")
    assert hydrogen["Symbol"] == "H" and hydrogen["Standard atomic weight (u)"] == stored["standard_atomic_weight_u"]
    assert hydrogen["Density (g/cm^3)"] == stored["density_g_per_cm3"] and hydrogen["Oxidation states"] == "1, -1"
    assert hydrogen["Source key"] == "pubchem-periodic-table" and hydrogen["Source URL"] and hydrogen["Source retrieved (ISO 8601 date)"] and hydrogen["Source licence"]

    tritium_row = next(r for r in range(2, 12) if record("Isotopes", r)["Mass number"] == 3 and record("Isotopes", r)["Atomic number"] == 1)
    tritium = record("Isotopes", tritium_row)
    assert tritium["Stability"] == "R" and tritium["Decay mode"] == "B-" and tritium["Half-life (s)"] > 0 and tritium["Source key"] == "iaea-livechart-ground-states"

    aspirin = record("Compounds", find_row(workbook["Compounds"], "Name", "Aspirin"))
    assert aspirin["Canonical SMILES"] == "CC(=O)Oc1ccccc1C(=O)O" and aspirin["InChIKey"] == "BSYNRYMUTXBXSQ-UHFFFAOYSA-N" and aspirin["Molecular formula"] == "C9H8O4"
    assert json.loads(aspirin["External IDs (JSON)"]) == {"pubchem_cid": 2244} and "ACETYLSALICYLIC ACID" in json.loads(aspirin["Synonyms"])
    assert len(aspirin["Morgan fingerprint (hex)"]) == 512, "the stored 2048-bit fingerprint"
    assert aspirin["Source key"] == "pubchem-compound"

    # Text that looks like a formula is exported as text.
    groups = workbook["Functional Groups"]
    double_bond_oxygen = groups.cell(row=find_row(groups, "Key", "=O"), column=column(groups, "Key"))
    assert double_bond_oxygen.data_type == "s" and double_bond_oxygen.value == "=O"

    calculation = record("Calculations", find_row(workbook["Calculations"], "ID", content["optimisation"]["id"]))
    assert calculation["Status"] == "succeeded" and calculation["Input hash (SHA-256)"] == content["optimisation"]["input_hash"]
    assert calculation["Engine"] == "rdkit" and calculation["Method"] == "MMFF94" and calculation["Converged"] is True
    assert json.loads(calculation["Result (JSON)"]) == content["optimisation"]["result"]
    assert json.loads(calculation["Input (JSON)"]) == content["optimisation"]["input"] and calculation["Source key"] == "rdkit"
    failed = record("Calculations", find_row(workbook["Calculations"], "ID", content["failed"]["id"]))
    assert failed["Status"] == "failed" and failed["Result (JSON)"] is None and json.loads(failed["Error (JSON)"])["code"] == "invalid_structure"
    assert failed["Omitted fields"] is None

    # A value that is too long for a cell is left out and named, never truncated.
    long = record("Calculations", find_row(workbook["Calculations"], "ID", content["long"]["id"]))
    assert long["Status"] == "succeeded" and long["Result (JSON)"] is None and long["Omitted fields"] == "Result (JSON)"
    assert all(len(str(cell.value)) <= 32_767 for name in SHEETS for row in workbook[name].iter_rows() for cell in row if cell.value is not None)

    experiment = record("Experiments", find_row(workbook["Experiments"], "ID", content["experiment"]["id"]))
    assert json.loads(experiment["Inputs (JSON)"]) == content["experiment"]["inputs"] and json.loads(experiment["Tags"]) == ["demo", "ethanol"]
    assert json.loads(experiment["Calculation IDs"]) == [content["optimisation"]["id"], content["failed"]["id"]]

    candidate = record("Discoveries", find_row(workbook["Discoveries"], "ID", content["candidate"]["id"]))
    catalogue_size = xdb.fetch_one("SELECT count(*) AS n FROM compounds")["n"]
    assert candidate["Status"] == "computationally-plausible" and f"{catalogue_size} records" in candidate["Catalogues searched"]
    assert len(json.loads(candidate["Evidence (JSON)"])) == len(content["candidate"]["evidence"])
    assert "novel" not in json.dumps([record("Discoveries", r) for r in range(2, workbook["Discoveries"].max_row + 1)], default=str).lower()

    reaction = record("Reactions", find_row(workbook["Reactions"], "ID", content["reaction"]["id"]))
    assert reaction["Reaction SMILES"] == "[H][H].[H][H].O=O>>O.O" and reaction["Balanced"] is True and reaction["Temperature (K)"] == 298.15


# ---------------------------------------------------------------------------------------------
# Import
# ---------------------------------------------------------------------------------------------


def test_reimporting_an_unmodified_export_changes_nothing(xl: TestClient, xdb: Database, contract: Contract, exported: bytes, content: dict[str, Any]) -> None:
    before = fingerprint(xdb)
    response = upload(xl, exported, "roundtrip.xlsx")
    report = contract.check("POST", "/v1/excel/import", response)
    assert response.status_code == 200, report
    assert report["outcome"] == "applied" and report["errors"] == [] and report["error_count"] == 0
    assert report["totals"]["inserted"] == 0 and report["totals"]["updated"] == 0 and report["totals"]["rejected"] == 0
    workbook = book(exported)
    for name in SHEETS:
        rows = workbook[name].max_row - 1
        assert report["sheets"][name] == {"present": True, "rows": rows, "inserted": 0, "updated": 0, "unchanged": rows, "rejected": 0}, name
    assert fingerprint(xdb) == before, "identical rows are not touched, so provenance and timestamps stay as they were"
    # The value that was too long for the workbook is still in the database.
    assert xl.get(f"/v1/jobs/{content['long']['id']}").json()["result"] == content["long"]["result"]
    logged = xdb.fetch_one("SELECT filename, outcome, rows_unchanged, sha256 FROM data_imports WHERE id = %s", (report["import_id"],))
    assert logged["filename"] == "roundtrip.xlsx" and logged["outcome"] == "applied" and logged["rows_unchanged"] == report["totals"]["unchanged"] and logged["sha256"] == report["sha256"]


def _edited_workbook(exported: bytes) -> tuple[bytes, dict[str, int]]:
    """An export with a mixture of valid changes, valid new rows and invalid rows."""
    workbook = book(exported)
    rows: dict[str, int] = {}
    elements = workbook["Elements"]
    rows["hydrogen"] = find_row(elements, "Atomic number", 1)
    set_cell(elements, rows["hydrogen"], "Density (g/cm^3)", 0.123)
    rows["lithium"] = find_row(elements, "Atomic number", 3)
    set_cell(elements, rows["lithium"], "Melting point (K)", "hot")
    rows["beryllium"] = find_row(elements, "Atomic number", 4)
    set_cell(elements, rows["beryllium"], "Block", "x")

    isotopes = workbook["Isotopes"]
    rows["isotope"] = 2
    set_cell(isotopes, 2, "Stability", "R")  # radioactive without a half-life

    compounds = workbook["Compounds"]
    rows["phenacetin"] = add(compounds, {"Name": "Phenacetin (imported)", "Canonical SMILES": "CCOC1=CC=C(C=C1)NC(=O)C", "Synonyms": '["p-acetophenetidide"]', "Source title": "My lab list", "Source key": "lab-list", "Source version": "2026-11"})
    rows["broken"] = add(compounds, {"Name": "Broken", "Canonical SMILES": "C(C"})
    rows["mismatch"] = add(compounds, {"Name": "Mismatch", "Canonical SMILES": "CCCCCCN", "InChIKey": "BSYNRYMUTXBXSQ-UHFFFAOYSA-N"})
    rows["nameless"] = add(compounds, {"Canonical SMILES": "CCCCCCCN"})

    groups = workbook["Functional Groups"]
    rows["nitro"] = add(groups, {"Set": "user-defined", "Key": "nitro", "Name": "nitro group", "SMARTS": "[N+](=O)[O-]"})
    rows["bad_smarts"] = add(groups, {"Set": "user-defined", "Key": "bad", "Name": "bad", "SMARTS": "[#6"})

    solvents = workbook["Solvents"]
    rows["solvent_ok"] = add(
        solvents,
        {"Name": "Test solvent", "Canonical SMILES": "CCOC(C)C", "Properties (JSON)": json.dumps([{"name": "boiling_point", "value": 327.0, "unit": "K", "source": "bench measurement, notebook 3"}])},
    )
    rows["solvent_unsourced"] = add(solvents, {"Name": "Unsourced solvent", "Canonical SMILES": "CCOCCC", "Properties (JSON)": json.dumps([{"name": "boiling_point", "value": 340.0, "unit": "K"}])})

    reactions = workbook["Reactions"]
    rows["reaction_ok"] = add(reactions, {"Name": "Ethene hydrogenation", "Reaction SMILES": "C=C.[H][H]>>CC", "Evidence level": "user-input"})
    rows["reaction_bad"] = add(reactions, {"Name": "Nonsense", "Reaction SMILES": "CC>>C(C", "Evidence level": "user-input"})

    experiments = workbook["Experiments"]
    rows["formula"] = experiments.max_row + 1
    experiments.cell(row=rows["formula"], column=column(experiments, "Title")).value = "=1+1"
    return to_bytes(workbook), rows


def test_import_applies_valid_rows_and_reports_invalid_ones(xl: TestClient, xdb: Database, contract: Contract, exported: bytes) -> None:
    data, rows = _edited_workbook(exported)
    lithium_before = xdb.fetch_one("SELECT melting_point_k, updated_at, source_id FROM elements WHERE atomic_number = 3")
    counts_before = {name: xdb.fetch_one(f"SELECT count(*) AS n FROM {table}")["n"] for name, table in TABLES.items()}

    response = upload(xl, data, "lab-update.xlsx")
    report = contract.check("POST", "/v1/excel/import", response)
    assert response.status_code == 200 and report["outcome"] == "applied" and report["written"] is True

    # The row-level error report: sheet, row, column and reason for every rejected row.
    assert problems(report) == {
        ("Elements", rows["lithium"], "Melting point (K)", "wrong_type"),
        ("Elements", rows["beryllium"], "Block", "invalid_value"),
        ("Isotopes", rows["isotope"], "Half-life (s)", "inconsistent_values"),
        ("Compounds", rows["broken"], "Canonical SMILES", "invalid_structure"),
        ("Compounds", rows["mismatch"], "InChIKey", "inchikey_mismatch"),
        ("Compounds", rows["nameless"], "Name", "missing_value"),
        ("Functional Groups", rows["bad_smarts"], "SMARTS", "invalid_smarts"),
        ("Solvents", rows["solvent_unsourced"], "Properties (JSON)", "property_without_source"),
        ("Reactions", rows["reaction_bad"], "Reaction SMILES", "invalid_reaction"),
        ("Experiments", rows["formula"], "Title", "formula_not_allowed"),
    }
    by_code = {e["code"]: e["message"] for e in report["errors"]}
    assert "'Melting point (K)' must be a number" in by_code["wrong_type"]
    assert "SMILES Parse Error" in by_code["invalid_structure"], "RDKit's own reason is reported"
    assert "CPJSUEIXXCENMM" not in by_code["inchikey_mismatch"] and "RDKit computes" in by_code["inchikey_mismatch"]
    assert "only stored together with where it was obtained" in by_code["property_without_source"]

    assert report["sheets"]["Elements"]["updated"] == 1 and report["sheets"]["Elements"]["rejected"] == 2 and report["sheets"]["Elements"]["unchanged"] == 115
    assert report["sheets"]["Isotopes"]["rejected"] == 1 and report["sheets"]["Isotopes"]["updated"] == 0
    assert report["sheets"]["Compounds"]["inserted"] == 1 and report["sheets"]["Compounds"]["rejected"] == 3
    assert report["sheets"]["Functional Groups"]["inserted"] == 1 and report["sheets"]["Solvents"]["inserted"] == 1 and report["sheets"]["Reactions"]["inserted"] == 1
    assert report["totals"] == {"rows": report["totals"]["rows"], "inserted": 4, "updated": 1, "unchanged": report["totals"]["rows"] - 15, "rejected": 10}

    # Valid rows are in the database, with the workbook as their provenance.
    hydrogen = xl.get("/v1/elements/1").json()
    assert hydrogen["density_g_per_cm3"] == 0.123
    assert hydrogen["provenance"]["kind"] == "import" and hydrogen["provenance"]["source_key"] == "excel-import"
    assert hydrogen["evidence"] == "user-input", "a record changed by a workbook is no longer labelled as reference data"
    assert xl.get("/v1/elements/2").json()["evidence"] == "reference"
    assert "lab-update.xlsx" in hydrogen["provenance"]["source"] and "PubChem Periodic Table" in hydrogen["provenance"]["source"]
    assert report["sha256"] in hydrogen["provenance"]["notes"] and "not verified" in hydrogen["provenance"]["notes"]
    fields = {p["provenance"]["source_key"]: set(p["fields"]) for p in hydrogen["field_provenance"]}
    assert fields["excel-import"] == {"density_g_per_cm3"} and "density_g_per_cm3" not in fields["pubchem-periodic-table"]
    assert "standard_atomic_weight_u" in fields["pubchem-periodic-table"], "fields the workbook did not change keep their source"

    found = xl.post("/v1/compounds/search/exact", json={"structure": smiles(PHENACETIN)}).json()
    assert [m["name"] for m in found["matches"]] == ["Phenacetin (imported)"], "the imported compound is searchable at once"
    compound = xl.get(f"/v1/compounds/{found['matches'][0]['id']}").json()
    assert compound["inchikey"] == PHENACETIN_INCHIKEY and compound["canonical_smiles"] == PHENACETIN, "identifiers are recomputed by RDKit"
    assert Chem.MolToInchiKey(Chem.MolFromMolBlock(compound["molblock"])) == PHENACETIN_INCHIKEY
    assert {"name": "p-acetophenetidide", "kind": "synonym"} in compound["synonyms"]
    assert compound["provenance"]["kind"] == "import" and "declared source: My lab list 2026-11" in compound["provenance"]["source"]
    assert compound["evidence"] == "user-input" and found["matches"][0]["evidence"] == "user-input"
    assert xl.get("/v1/compounds", params={"name": "p-acetophenetidide"}).json()["total"] == 1

    detected = xl.post("/v1/chem/functional-groups", json={"structure": smiles("O=[N+]([O-])c1ccccc1"), "sets": ["user-defined"]}).json()
    assert [(g["key"], g["match_count"]) for g in detected["groups"]] == [("nitro", 1)]
    solvent = next(s for s in xl.get("/v1/solvents", params={"limit": 1000}).json()["items"] if s["name"] == "Test solvent")
    assert solvent["properties"] == [{"name": "boiling_point", "value": 327.0, "unit": "K", "evidence": "reference", "source": "bench measurement, notebook 3", "source_key": None, "retrieved": None}]
    assert solvent["structure_status"] == "rdkit-validated" and solvent["inchikey"]
    reaction = next(r for r in xl.get("/v1/reactions").json()["items"] if r["name"] == "Ethene hydrogenation")
    assert reaction["balanced"] is True and reaction["evidence"] == "user-input"

    # Invalid rows left no trace.
    lithium_after = xdb.fetch_one("SELECT melting_point_k, updated_at, source_id FROM elements WHERE atomic_number = 3")
    assert lithium_after == lithium_before
    assert xdb.fetch_one("SELECT block FROM elements WHERE atomic_number = 4")["block"] == "s"
    assert xdb.fetch_one("SELECT stability FROM isotopes WHERE atomic_number = 1 AND neutron_number = 0")["stability"] == "S"
    for name in ("Broken", "Mismatch", "Unsourced solvent", "Nonsense"):
        assert xdb.fetch_one(
            "SELECT (SELECT count(*) FROM compounds WHERE name = %s) + (SELECT count(*) FROM solvents WHERE name = %s) + (SELECT count(*) FROM reactions WHERE name = %s) AS n",
            (name, name, name),
        )["n"] == 0
    assert xdb.fetch_one("SELECT count(*) AS n FROM functional_groups WHERE key = 'bad'")["n"] == 0
    counts_after = {name: xdb.fetch_one(f"SELECT count(*) AS n FROM {table}")["n"] for name, table in TABLES.items()}
    assert {n: counts_after[n] - counts_before[n] for n in TABLES} == {
        "Elements": 0, "Isotopes": 0, "Compounds": 1, "Functional Groups": 1, "Catalysts": 0, "Solvents": 1, "Reactions": 1, "Experiments": 0, "Discoveries": 0, "Calculations": 0,
    }

    # Importing the same workbook again finds the applied rows unchanged and rejects the same invalid ones.
    again = upload(xl, data, "lab-update.xlsx").json()
    assert again["totals"]["inserted"] == 0 and again["totals"]["updated"] == 0 and again["totals"]["rejected"] == 10
    assert problems(again) == problems(report)


def test_dry_run_reports_without_writing(xl: TestClient, xdb: Database, exported: bytes) -> None:
    workbook = book(exported)
    elements = workbook["Elements"]
    set_cell(elements, find_row(elements, "Atomic number", 2), "Boiling point (K)", 5.0)
    add(workbook["Compounds"], {"Name": "Dry run compound", "Canonical SMILES": "CCCCCCCCCCN"})
    add(workbook["Compounds"], {"Name": "Dry run broken", "Canonical SMILES": PENTAVALENT_CARBON})
    before = fingerprint(xdb)
    response = upload(xl, to_bytes(workbook), "dry.xlsx", dry_run=True)
    report = response.json()
    assert response.status_code == 200 and report["outcome"] == "dry-run" and report["written"] is False and report["dry_run"] is True
    assert report["totals"]["updated"] == 1 and report["totals"]["inserted"] == 1 and report["totals"]["rejected"] == 1, "the report says what an import would do"
    assert report["errors"][0]["code"] == "invalid_structure" and "Explicit valence for atom # 1 C, 5" in report["errors"][0]["message"]
    assert "nothing was written" in report["summary"]
    assert fingerprint(xdb) == before
    assert xl.get("/v1/compounds", params={"name": "Dry run compound"}).json()["total"] == 0
    assert xdb.fetch_one("SELECT outcome, dry_run, rows_inserted FROM data_imports WHERE id = %s", (report["import_id"],)) == {"outcome": "dry-run", "dry_run": True, "rows_inserted": 0}


def test_atomic_import_is_all_or_nothing(xl: TestClient, xdb: Database, contract: Contract, exported: bytes) -> None:
    workbook = book(exported)
    add(workbook["Compounds"], {"Name": "Atomic good", "Canonical SMILES": "CCCCCCCCCCCN"})
    add(workbook["Compounds"], {"Name": "Atomic bad", "Canonical SMILES": "C(C"})
    before = fingerprint(xdb)
    response = upload(xl, to_bytes(workbook), "atomic.xlsx", atomic=True)
    body = contract.check("POST", "/v1/excel/import", response)
    assert response.status_code == 422 and is_error_shape(body) and body["error"]["code"] == "workbook_rejected"
    report = body["error"]["details"]
    assert report["outcome"] == "rejected" and report["written"] is False and report["totals"]["rejected"] == 1
    assert report["errors"][0]["sheet"] == "Compounds" and report["errors"][0]["code"] == "invalid_structure"
    assert fingerprint(xdb) == before, "one invalid row keeps the whole workbook out"
    assert xl.get("/v1/compounds", params={"name": "Atomic good"}).json()["total"] == 0

    # Without atomic mode the valid row goes in.
    assert upload(xl, to_bytes(workbook), "atomic.xlsx").json()["totals"]["inserted"] == 1
    assert xl.get("/v1/compounds", params={"name": "Atomic good"}).json()["total"] == 1


def test_sheet_names_headers_and_units_are_validated(xl: TestClient, xdb: Database, contract: Contract, exported: bytes) -> None:
    before = fingerprint(xdb)

    def rejected(data: bytes) -> dict[str, Any]:
        response = upload(xl, data, "bad.xlsx")
        body = contract.check("POST", "/v1/excel/import", response)
        assert response.status_code == 422 and body["error"]["code"] == "workbook_rejected", body
        assert body["error"]["details"]["written"] is False and body["error"]["details"]["totals"]["inserted"] == 0
        return body["error"]["details"]

    # A column in another unit is refused, even though every other header is right.
    workbook = book(exported)
    elements = workbook["Elements"]
    elements.cell(row=1, column=column(elements, "Melting point (K)")).value = "Melting point (C)"
    set_cell(elements, find_row(elements, "Atomic number", 1), "Density (g/cm^3)", 99.0)
    report = rejected(to_bytes(workbook))
    codes = {(e["sheet"], e["column"], e["code"]) for e in report["errors"]}
    assert ("Elements", "Melting point (C)", "unit_mismatch") in codes and ("Elements", "Melting point (K)", "missing_column") in codes
    assert "values must be in K, not C" in next(e["message"] for e in report["errors"] if e["code"] == "unit_mismatch")

    workbook = book(exported)
    isotopes = workbook["Isotopes"]
    isotopes.cell(row=1, column=len(headers(isotopes)) + 1).value = "Comment"
    assert {(e["sheet"], e["column"], e["code"]) for e in rejected(to_bytes(workbook))["errors"]} == {("Isotopes", "Comment", "unknown_column")}

    workbook = book(exported)
    workbook["Compounds"].delete_cols(column(workbook["Compounds"], "Canonical SMILES"))
    assert ("Compounds", "Canonical SMILES", "missing_column") in {(e["sheet"], e["column"], e["code"]) for e in rejected(to_bytes(workbook))["errors"]}

    workbook = book(exported)
    workbook.create_sheet("Notes")
    workbook.copy_worksheet(workbook["Solvents"]).title = "Compound"  # a misspelt sheet name is not guessed at
    unknown = {(e["sheet"], e["code"]) for e in rejected(to_bytes(workbook))["errors"]}
    assert {("Notes", "unknown_sheet"), ("Compound", "unknown_sheet")} <= unknown

    for junk, code in ((b"this is not a workbook", "workbook_rejected"), (b"", "empty_upload")):
        response = upload(xl, junk, "junk.xlsx")
        body = contract.check("POST", "/v1/excel/import", response)
        assert response.status_code == 422 and is_error_shape(body) and body["error"]["code"] == code
    assert xl.post("/v1/excel/import").status_code == 422, "the file part is required"
    assert fingerprint(xdb) == before, "a rejected workbook writes nothing"


def test_a_workbook_may_contain_a_subset_of_the_sheets(xl: TestClient, exported: bytes) -> None:
    workbook = book(exported)
    for name in SHEETS:
        if name != "Compounds":
            del workbook[name]
    add(workbook["Compounds"], {"Name": "Subset compound", "Canonical SMILES": "CCCCCCCCCCCCN"})
    for header in ("InChI", "Molecular formula", "Molblock (V2000, 2D depiction)", "Morgan fingerprint (hex)"):  # informational columns may be left out
        workbook["Compounds"].delete_cols(column(workbook["Compounds"], header))
    report = upload(xl, to_bytes(workbook), "compounds-only.xlsx").json()
    assert report["outcome"] == "applied" and report["totals"]["inserted"] == 1 and report["totals"]["rejected"] == 0
    assert report["sheets"]["Compounds"]["present"] is True and report["sheets"]["Elements"] == {"present": False, "rows": 0, "inserted": 0, "updated": 0, "unchanged": 0, "rejected": 0}
    stored = xl.get("/v1/compounds", params={"name": "Subset compound"}).json()["items"][0]
    assert stored["molecular_formula"] == "C12H27N", "derived values come from RDKit, not from the workbook"


def test_calculations_are_immutable_and_hash_checked(xl: TestClient, xdb: Database, exported: bytes, content: dict[str, Any]) -> None:
    workbook = book(exported)
    sheet = workbook["Calculations"]
    original = find_row(sheet, "ID", content["optimisation"]["id"])
    names = headers(sheet)
    values = {h: sheet.cell(row=original, column=i + 1).value for i, h in enumerate(names)}

    # 1. tamper with the result of an existing calculation
    tampered = json.loads(values["Result (JSON)"])
    tampered["energy_final_kcal_per_mol"] = -999.0
    set_cell(sheet, original, "Result (JSON)", json.dumps(tampered))
    # 2. a copy under a new id: a legitimate import of a finished calculation
    copy_id = str(uuid.uuid4())
    rows = {"copy": add(sheet, {**{k: v for k, v in values.items() if v is not None}, "ID": copy_id})}
    # 3. a copy whose input no longer matches its hash
    changed_input = json.loads(values["Input (JSON)"])
    changed_input["structure"]["data"] = "CCCO"
    rows["hash"] = add(sheet, {**{k: v for k, v in values.items() if v is not None}, "ID": str(uuid.uuid4()), "Input (JSON)": json.dumps(changed_input)})
    # 4. a job that never finished cannot be imported
    rows["queued"] = add(sheet, {**{k: v for k, v in values.items() if v is not None and k not in ("Result (JSON)", "Finished at (UTC)", "Converged")}, "ID": str(uuid.uuid4()), "Status": "queued"})

    report = upload(xl, to_bytes(workbook), "calculations.xlsx").json()
    assert problems(report) == {
        ("Calculations", original, None, "immutable_record"),
        ("Calculations", rows["hash"], "Input hash (SHA-256)", "input_hash_mismatch"),
        ("Calculations", rows["queued"], "Status", "not_importable"),
    }
    assert report["sheets"]["Calculations"]["inserted"] == 1
    untouched = xl.get(f"/v1/jobs/{content['optimisation']['id']}").json()
    assert untouched["result"] == content["optimisation"]["result"], "the record of a run cannot be rewritten from a spreadsheet"

    imported = xl.get(f"/v1/jobs/{copy_id}").json()
    assert imported["origin"] == "import" and imported["status"] == "succeeded" and imported["result"] == content["optimisation"]["result"]
    assert imported["input_hash"] == content["optimisation"]["input_hash"] == input_hash(imported["kind"], imported["input"], imported["settings"])
    assert imported["provenance"]["kind"] == "import" and "calculations.xlsx" in imported["provenance"]["source"]
    assert imported["created_at"] == content["optimisation"]["created_at"] and imported["finished_at"] == content["optimisation"]["finished_at"]
    assert xdb.fetch_one("SELECT count(*) AS n FROM calculations WHERE status IN ('queued', 'running')")["n"] == 0, "an import never schedules work"


def test_discovery_trail_cannot_be_rewritten_by_import(xl: TestClient, exported: bytes, content: dict[str, Any]) -> None:
    workbook = book(exported)
    sheet = workbook["Discoveries"]
    candidate = find_row(sheet, "ID", content["candidate"]["id"])
    invalid = find_row(sheet, "ID", content["invalid"]["id"])
    set_cell(sheet, candidate, "Status", "independently-validated")
    set_cell(sheet, invalid, "Title", "Impossible carbon (renamed)")
    report = upload(xl, to_bytes(workbook), "discoveries.xlsx").json()
    assert problems(report) == {("Discoveries", candidate, None, "immutable_field")}
    assert "evidence rules apply" in report["errors"][0]["message"]
    assert report["sheets"]["Discoveries"]["updated"] == 1
    assert xl.get(f"/v1/discoveries/{content['candidate']['id']}").json()["status"] == "computationally-plausible"
    renamed = xl.get(f"/v1/discoveries/{content['invalid']['id']}").json()
    assert renamed["title"] == "Impossible carbon (renamed)" and renamed["status"] == "user-created" and renamed["evidence"] == content["invalid"]["evidence"]

    workbook = book(exported)
    sheet = workbook["Discoveries"]
    set_cell(sheet, find_row(sheet, "ID", content["candidate"]["id"]), "Status", "novel")
    report = upload(xl, to_bytes(workbook), "discoveries.xlsx").json()
    assert [(e["column"], e["code"]) for e in report["errors"]] == [("Status", "invalid_value")]


def test_import_into_another_database_keeps_records_and_their_history(
    xl: TestClient, settings: Settings, database_factory: Callable[[], str], exported: bytes, content: dict[str, Any]
) -> None:
    """The workbook as an interchange format between two instances."""
    other_settings = settings.with_database(database_factory())
    migrate(other_settings.database_conninfo, other_settings.migrations_dir)
    seed_all(other_settings)
    other = Database(other_settings.database_conninfo, max_size=2)
    other.open()
    try:
        assert other.fetch_one("SELECT count(*) AS n FROM calculations")["n"] == 0
        report = import_workbook(other, exported, filename="from-instance-a.xlsx")
        workbook = book(exported)
        # One record cannot travel in a workbook: its result was too long for a cell. It is refused, not imported without its result.
        long_row = find_row(workbook["Calculations"], "ID", content["long"]["id"])
        assert report["outcome"] == "applied" and problems(report) == {("Calculations", long_row, "Omitted fields", "omitted_field")}, report["errors"][:3]
        assert "Result (JSON) was left out of the workbook" in report["errors"][0]["message"]
        assert other.fetch_one("SELECT count(*) AS n FROM calculations WHERE id = %s", (content["long"]["id"],))["n"] == 0
        for name in ("Reactions", "Experiments", "Discoveries"):
            assert report["sheets"][name]["inserted"] == workbook[name].max_row - 1 and report["sheets"][name]["rejected"] == 0, name
        assert report["sheets"]["Calculations"]["inserted"] == workbook["Calculations"].max_row - 2 and report["sheets"]["Calculations"]["rejected"] == 1
        for name in ("Isotopes", "Catalysts"):
            assert report["sheets"][name]["unchanged"] == workbook[name].max_row - 1, f"{name}: both instances were seeded from the same sources"
        # Compounds are matched by InChIKey: the ids of the other instance do not matter.
        seeded = other.fetch_one("SELECT count(*) AS n FROM compounds c JOIN data_sources ds ON ds.id = c.source_id WHERE ds.key = 'pubchem-compound'")["n"]
        assert report["sheets"]["Compounds"]["unchanged"] == seeded and report["sheets"]["Compounds"]["updated"] == 0
        assert report["sheets"]["Compounds"]["inserted"] == workbook["Compounds"].max_row - 1 - seeded
        assert report["sheets"]["Elements"]["inserted"] == 0 and report["sheets"]["Elements"]["updated"] + report["sheets"]["Elements"]["unchanged"] == 118
        ours = xl.app.state.ctx.db.fetch_one("SELECT density_g_per_cm3 FROM elements WHERE atomic_number = 1")  # type: ignore[attr-defined]
        assert other.fetch_one("SELECT density_g_per_cm3 FROM elements WHERE atomic_number = 1") == ours

        job = other.fetch_one("SELECT status, origin, input_hash, result, engine, engine_version FROM calculations WHERE id = %s", (content["optimisation"]["id"],))
        assert job["origin"] == "import" and job["status"] == "succeeded" and job["input_hash"] == content["optimisation"]["input_hash"]
        assert job["result"] == content["optimisation"]["result"] and job["engine_version"] == content["optimisation"]["engine"]["version"]

        experiment = other.fetch_one("SELECT title, inputs, settings, tags, reaction_id FROM experiments WHERE id = %s", (content["experiment"]["id"],))
        assert experiment["inputs"] == content["experiment"]["inputs"] and experiment["tags"] == ["demo", "ethanol"]
        assert str(experiment["reaction_id"]) == content["reaction"]["id"]
        links = other.fetch_all("SELECT calculation_id FROM experiment_calculations WHERE experiment_id = %s ORDER BY position", (content["experiment"]["id"],))
        assert [str(link["calculation_id"]) for link in links] == [content["optimisation"]["id"], content["failed"]["id"]]

        # Catalogue ids are derived from the InChIKey or the name, so references to solvents and catalysts hold in the other instance.
        aspirin = "SELECT id FROM compounds WHERE inchikey = 'BSYNRYMUTXBXSQ-UHFFFAOYSA-N'"
        assert other.fetch_one(aspirin) == xl.app.state.ctx.db.fetch_one(aspirin)  # type: ignore[attr-defined]
        linked = other.fetch_one(
            "SELECT s.name AS solvent, c.name AS catalyst, r.pressure_pa FROM reactions r JOIN solvents s ON s.id = r.solvent_id "
            "JOIN catalysts c ON c.id = r.catalyst_id WHERE r.id = %s",
            (content["hydrogenation"]["id"],),
        )
        assert linked == {"solvent": "ethanol", "catalyst": "platinum dioxide", "pressure_pa": 101325.0}

        candidate = other.fetch_one("SELECT status, inchikey, structure_valid FROM discoveries WHERE id = %s", (content["candidate"]["id"],))
        assert candidate["status"] == "computationally-plausible" and candidate["inchikey"] == content["candidate"]["inchikey"] and candidate["structure_valid"] is True
        trail = other.fetch_all("SELECT kind, summary, recorded_by, calculation_id FROM discovery_evidence WHERE discovery_id = %s ORDER BY created_at, id", (content["candidate"]["id"],))
        assert [e["kind"] for e in trail] == [e["kind"] for e in content["candidate"]["evidence"]] + ["import"]
        assert [e["summary"] for e in trail[:-1]] == [e["summary"] for e in content["candidate"]["evidence"]]
        assert "did not repeat the searches or verify the evidence" in trail[-1]["summary"]
        assert str(next(e["calculation_id"] for e in trail if e["kind"] == "calculation")) == content["job"]["id"]
        searches = other.fetch_one("SELECT count(*) AS n FROM discovery_catalog_searches WHERE discovery_id = %s", (content["candidate"]["id"],))
        assert searches["n"] == len(content["candidate"]["catalog_searches"])
        invalid = other.fetch_one("SELECT status, structure_valid FROM discoveries WHERE id = %s", (content["invalid"]["id"],))
        assert invalid == {"status": "user-created", "structure_valid": False}

        # A second import of the same workbook finds everything in place and writes nothing.
        before = fingerprint(other)
        again = import_workbook(other, exported, filename="from-instance-a.xlsx")
        assert problems(again) == problems(report) and again["totals"]["inserted"] == 0 and again["totals"]["updated"] == 0
        assert again["totals"]["unchanged"] == again["totals"]["rows"] - 1 and again["totals"]["rows"] == report["totals"]["rows"]
        assert fingerprint(other) == before

        # And the copy exports the same science back out.
        copy, summary = export_workbook(other)
        assert summary["sheets"]["Calculations"] == workbook["Calculations"].max_row - 2
        assert book(copy).sheetnames == SHEETS
    finally:
        other.close()
