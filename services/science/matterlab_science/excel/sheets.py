"""The ten worksheets: what each exports and how each row is validated and applied on import."""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

import psycopg
from rdkit import Chem

from .. import discovery
from ..api.reactions import insert_reaction
from ..catalogue.records import StructureRejected, compound_fields, parse_or_reject, role_fields, upsert_compound, upsert_role
from ..chem import rdlog
from ..chem.reactions import parse_reaction
from ..chem.structure import derived_by, identity, parse_structure, standard_mol
from ..db import Jsonb
from ..jobs.hashing import input_hash
from ..jobs.store import TERMINAL_STATUSES
from ..provenance import upsert_data_source
from ..seeding.reference import _upsert_sql
from .spec import EVIDENCE_LEVELS, PROVENANCE_SELECT, Column, compact_json, same_value

# Rows of the Reactions, Experiments and Discoveries sheets may leave the 'ID' cell empty. Their id
# is then derived from the row's own content, so importing the same workbook twice finds the
# records of the first import instead of creating duplicates.
_ROW_ID_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_DNS, "excel-import.matterlab")


def _content_id(sheet: str, row: dict[str, Any], fields: tuple[str, ...]) -> UUID:
    document = compact_json({name: (str(row[name]) if isinstance(row.get(name), UUID) else row.get(name)) for name in fields})
    return uuid.uuid5(_ROW_ID_NAMESPACE, f"{sheet}\n{document}")


class RowError(Exception):
    def __init__(self, code: str, message: str, column: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.column = column


@dataclass
class ImportContext:
    conn: psycopg.Connection[Any]
    filename: str
    sha256: str
    started_at: datetime
    _sources: dict[tuple[Any, ...], int] = field(default_factory=dict)
    _elements: set[int] | None = None

    def element_exists(self, atomic_number: int) -> bool:
        if self._elements is None:
            self._elements = {r["atomic_number"] for r in self.conn.execute("SELECT atomic_number FROM elements").fetchall()}
        return atomic_number in self._elements

    def elements_changed(self) -> None:
        self._elements = None

    def source_id(self, row: dict[str, Any]) -> int:
        """Provenance of a row written by this import: the workbook, plus the source the row declares.

        The declared source is recorded as a claim of the workbook. Rows that are identical to the
        database keep their existing provenance and never reach this function.
        """
        declared = (
            row.get("source_key"),
            row.get("source_version"),
            row.get("source_title"),
            row.get("source_url_declared"),
            row.get("source_retrieved"),
            row.get("source_license"),
        )
        if declared in self._sources:
            return self._sources[declared]
        stamp = f"{self.started_at.strftime('%Y%m%dT%H%M%SZ')}-{self.sha256[:12]}"
        base_note = f"Imported from the workbook {self.filename!r} (SHA-256 {self.sha256}) at {self.started_at.isoformat(timespec='seconds').replace('+00:00', 'Z')}."
        key, version, title, url, retrieved, license_text = declared
        if not any(declared):
            source = upsert_data_source(
                self.conn,
                key="excel-import",
                version=stamp,
                kind="import",
                title=f"Excel import: {self.filename}",
                notes=f"{base_note} The workbook declares no source for these rows.",
            )
        else:
            label = " ".join(str(part) for part in (title or key, version) if part)
            source = upsert_data_source(
                self.conn,
                key="excel-import",
                version=f"{stamp}/{key or 'undeclared'}@{version or 'undeclared'}",
                kind="import",
                title=f"Excel import: {self.filename} (declared source: {label})",
                url=url,
                license=license_text,
                retrieved_on=retrieved,
                notes=f"{base_note} The source named here is as declared in the workbook and was not verified by this service.",
            )
        self._sources[declared] = source
        return source


class Sheet:
    name: str = ""
    columns: tuple[Column, ...] = ()
    key_fields: tuple[str, ...] = ()

    def export_rows(self, conn: psycopg.Connection[Any]) -> list[dict[str, Any]]:
        raise NotImplementedError

    def prepare(self, row: dict[str, Any], ctx: ImportContext) -> dict[str, Any]:
        """Row-level validation and derivation. Raises RowError; returns the row to compare and apply."""
        return row

    def key(self, row: dict[str, Any]) -> tuple[Any, ...]:
        return tuple(str(row[f]).lower() if isinstance(row[f], (str, UUID)) else row[f] for f in self.key_fields)

    def compared_columns(self) -> list[Column]:
        return [c for c in self.columns if not c.read_only and c.field not in self.key_fields]

    def differs(self, row: dict[str, Any], existing: dict[str, Any], omitted: set[str]) -> list[str]:
        """Fields whose value in the row differs from the stored record."""
        return [c.field for c in self.compared_columns() if c.field not in omitted and not same_value(c, row.get(c.field), existing.get(c.field))]

    def apply(self, ctx: ImportContext, row: dict[str, Any], existing: dict[str, Any] | None, changed: list[str]) -> None:
        raise NotImplementedError


def _require(row: dict[str, Any], columns: tuple[Column, ...]) -> None:
    for column in columns:
        if column.required and not column.read_only and row.get(column.field) in (None, "", []):
            raise RowError("missing_value", f"'{column.header}' is required", column.header)


def _exists(conn: psycopg.Connection[Any], table: str, record_id: Any) -> bool:
    return conn.execute(f"SELECT 1 FROM {table} WHERE id = %s", (record_id,)).fetchone() is not None


# ---------------------------------------------------------------------------------------------
# Elements
# ---------------------------------------------------------------------------------------------


class ElementsSheet(Sheet):
    name = "Elements"
    key_fields = ("atomic_number",)
    columns = (
        Column("Atomic number", "atomic_number", "int", required=True, width=10),
        Column("Symbol", "symbol", "str", required=True, width=8),
        Column("Name", "name", "str", required=True),
        Column("Standard atomic weight (u)", "standard_atomic_weight_u", "float", required=True),
        Column("Period", "period", "int", required=True, width=8),
        Column("Group", "group_number", "int", width=8),
        Column("Block", "block", "str", required=True, width=8, choices=("s", "p", "d", "f")),
        Column("Table row", "table_row", "int", required=True, width=10),
        Column("Table column", "table_column", "int", required=True, width=12),
        Column("Category", "category", "str", required=True, width=22),
        Column("Standard state", "standard_state", "str", required=True, choices=("solid", "liquid", "gas")),
        Column("Standard state predicted", "standard_state_predicted", "bool", required=True),
        Column("Electron configuration", "electron_configuration", "str", required=True, width=26),
        Column("Electron configuration predicted", "electron_configuration_predicted", "bool", required=True),
        Column("Electronegativity (Pauling)", "electronegativity_pauling", "float"),
        Column("Ionisation energy (eV)", "ionization_energy_ev", "float"),
        Column("Electron affinity (eV)", "electron_affinity_ev", "float"),
        Column("Oxidation states", "oxidation_states", "int_list"),
        Column("Melting point (K)", "melting_point_k", "float"),
        Column("Boiling point (K)", "boiling_point_k", "float"),
        Column("Density (g/cm^3)", "density_g_per_cm3", "float"),
        Column("Year discovered", "year_discovered", "int"),
        Column("Discovered in antiquity", "discovered_in_antiquity", "bool", required=True),
        Column("Covalent radius (angstrom)", "covalent_radius_angstrom", "float", required=True),
        Column("Van der Waals radius (angstrom)", "vdw_radius_angstrom", "float", required=True),
        Column("Van der Waals radius source", "vdw_radius_source", "str", required=True, choices=("pubchem", "rdkit", "import")),
        Column("CPK colour (hex)", "cpk_color_hex", "str", required=True),
        Column("Colour source", "color_source", "str", required=True, choices=("pubchem", "jmol", "fallback", "import")),
        Column("Valences", "valences", "int_list"),
        Column("Valence unconstrained", "valence_unconstrained", "bool", required=True),
        Column("Outer electrons", "outer_electrons", "int", required=True),
        Column("Most common isotope (mass number)", "most_common_isotope_mass_number", "int", required=True),
        Column("Most common isotope mass (u)", "most_common_isotope_mass_u", "float", required=True),
    )

    def export_rows(self, conn: psycopg.Connection[Any]) -> list[dict[str, Any]]:
        fields = ", ".join(f"e.{c.field}" for c in self.columns)
        return conn.execute(f"SELECT {fields}, {PROVENANCE_SELECT} FROM elements e JOIN data_sources ds ON ds.id = e.source_id ORDER BY e.atomic_number").fetchall()

    def prepare(self, row: dict[str, Any], ctx: ImportContext) -> dict[str, Any]:
        _require(row, self.columns)
        if not 1 <= row["atomic_number"] <= 118:
            raise RowError("out_of_range", "'Atomic number' must be between 1 and 118", "Atomic number")
        row["cpk_color_hex"] = str(row["cpk_color_hex"]).upper()
        return row

    def apply(self, ctx: ImportContext, row: dict[str, Any], existing: dict[str, Any] | None, changed: list[str]) -> None:
        if existing is not None:
            # A value changed by the workbook is no longer the value of its original source.
            if "vdw_radius_angstrom" in changed:
                row["vdw_radius_source"] = "import"
            if "cpk_color_hex" in changed:
                row["color_source"] = "import"
        source_id = ctx.source_id(row)
        fields = tuple(c.field for c in self.columns)
        ctx.elements_changed()
        ctx.conn.execute(_upsert_sql("elements", (*fields, "source_id"), ("atomic_number",)), [row[f] for f in fields] + [source_id])
        touched = changed if existing is not None else [f for f in fields if f != "atomic_number"]
        for current in ctx.conn.execute("SELECT source_id, fields FROM element_sources WHERE atomic_number = %s", (row["atomic_number"],)).fetchall():
            remaining = [f for f in current["fields"] if f not in touched]
            if not remaining:
                ctx.conn.execute("DELETE FROM element_sources WHERE atomic_number = %s AND source_id = %s", (row["atomic_number"], current["source_id"]))
            elif remaining != current["fields"]:
                ctx.conn.execute(
                    "UPDATE element_sources SET fields = %s WHERE atomic_number = %s AND source_id = %s",
                    (remaining, row["atomic_number"], current["source_id"]),
                )
        if touched:
            ctx.conn.execute(
                "INSERT INTO element_sources (atomic_number, source_id, fields) VALUES (%s, %s, %s) "
                "ON CONFLICT (atomic_number, source_id) DO UPDATE SET fields = EXCLUDED.fields",
                (row["atomic_number"], source_id, touched),
            )


# ---------------------------------------------------------------------------------------------
# Isotopes
# ---------------------------------------------------------------------------------------------


class IsotopesSheet(Sheet):
    name = "Isotopes"
    key_fields = ("atomic_number", "neutron_number")
    columns = (
        Column("Atomic number", "atomic_number", "int", required=True, width=10),
        Column("Symbol", "symbol", "str", read_only=True, width=8),
        Column("Neutron number", "neutron_number", "int", required=True, width=10),
        Column("Mass number", "mass_number", "int", read_only=True, width=10),
        Column("Atomic mass (u)", "atomic_mass_u", "float"),
        Column("Mass from systematics", "mass_from_systematics", "bool", required=True),
        Column("Natural abundance (%)", "natural_abundance_percent", "float"),
        Column("Stability", "stability", "str", required=True, width=10, choices=("S", "R", "U")),
        Column("Half-life (s)", "half_life_seconds", "float", width=22),
        Column("Half-life limit", "half_life_limit", "str", width=10, choices=("GT", "LT", "GE", "LE", "AP")),
        Column("Decay mode", "decay_mode", "str", width=12),
        Column("Decay branching (%)", "decay_percent", "float"),
        Column("Spin and parity", "spin_parity", "str", width=14),
    )
    _writable = ("atomic_number", "neutron_number", "atomic_mass_u", "mass_from_systematics", "natural_abundance_percent", "stability", "half_life_seconds", "half_life_limit", "decay_mode", "decay_percent", "spin_parity")

    def export_rows(self, conn: psycopg.Connection[Any]) -> list[dict[str, Any]]:
        return conn.execute(
            f"""
            SELECT i.atomic_number, e.symbol, i.neutron_number, i.mass_number, i.atomic_mass_u, i.mass_from_systematics,
                   i.natural_abundance_percent, i.stability, i.half_life_seconds, NULLIF(i.half_life_limit, '') AS half_life_limit,
                   i.decay_mode, i.decay_percent, i.spin_parity, {PROVENANCE_SELECT}
            FROM isotopes i JOIN elements e ON e.atomic_number = i.atomic_number JOIN data_sources ds ON ds.id = i.source_id
            ORDER BY i.atomic_number, i.neutron_number
            """
        ).fetchall()

    def prepare(self, row: dict[str, Any], ctx: ImportContext) -> dict[str, Any]:
        _require(row, self.columns)
        if not ctx.element_exists(row["atomic_number"]):
            raise RowError("unknown_reference", f"there is no element with atomic number {row['atomic_number']}", "Atomic number")
        if row["neutron_number"] < 0:
            raise RowError("out_of_range", "'Neutron number' cannot be negative", "Neutron number")
        if (row["stability"] == "R") != (row.get("half_life_seconds") is not None):
            raise RowError(
                "inconsistent_values",
                "'Half-life (s)' must be given exactly when 'Stability' is R (radioactive with an evaluated half-life)",
                "Half-life (s)",
            )
        return row

    def apply(self, ctx: ImportContext, row: dict[str, Any], existing: dict[str, Any] | None, changed: list[str]) -> None:
        values = [row.get(f) if f != "half_life_limit" else (row.get(f) or "") for f in self._writable]
        ctx.conn.execute(_upsert_sql("isotopes", (*self._writable, "source_id"), ("atomic_number", "neutron_number")), values + [ctx.source_id(row)])


# ---------------------------------------------------------------------------------------------
# Compounds
# ---------------------------------------------------------------------------------------------


class CompoundsSheet(Sheet):
    name = "Compounds"
    key_fields = ("inchikey",)
    columns = (
        Column("ID", "id", "uuid", width=38),
        Column("Name", "name", "str", required=True, width=30),
        Column("IUPAC name", "iupac_name", "str", width=40),
        Column("Canonical SMILES", "canonical_smiles", "str", required=True, width=40),
        Column("InChI", "inchi", "str", read_only=True, width=50),
        Column("InChIKey", "inchikey", "str", width=30),
        Column("Molecular formula", "molecular_formula", "str", read_only=True),
        Column("Molecular weight (g/mol)", "molecular_weight_g_per_mol", "float", read_only=True),
        Column("Monoisotopic mass (u)", "monoisotopic_mass_u", "float", read_only=True),
        Column("Formal charge (e)", "formal_charge", "int", read_only=True),
        Column("Heavy atom count", "heavy_atom_count", "int", read_only=True),
        Column("Synonyms", "synonyms", "str_list", width=40),
        Column("External IDs (JSON)", "external_ids", "json", json_type="object", width=24),
        Column("Molblock (V2000, 2D depiction)", "molblock", "str", read_only=True, width=20),
        Column("Morgan fingerprint (hex)", "morgan_fp_hex", "str", read_only=True, width=20),
        Column("Fingerprint parameters (JSON)", "fingerprint_params", "json", read_only=True, width=20),
        Column("Derived by (JSON)", "derived_by", "json", read_only=True, width=20),
        Column("Record URL", "source_url", "str", width=40),
    )

    def export_rows(self, conn: psycopg.Connection[Any]) -> list[dict[str, Any]]:
        return conn.execute(
            f"""
            SELECT c.id, c.name, c.iupac_name, c.canonical_smiles, c.inchi, c.inchikey, c.molecular_formula, c.molecular_weight_g_per_mol,
                   c.monoisotopic_mass_u, c.formal_charge, c.heavy_atom_count,
                   COALESCE((SELECT array_agg(s.name ORDER BY s.position, s.name) FROM compound_synonyms s
                             WHERE s.compound_id = c.id AND s.kind IN ('query', 'synonym')), '{{}}') AS synonyms,
                   c.external_ids, c.molblock, encode(c.morgan_fp, 'hex') AS morgan_fp_hex, c.fingerprint_params, c.derived_by, c.source_url,
                   {PROVENANCE_SELECT}
            FROM compounds c JOIN data_sources ds ON ds.id = c.source_id ORDER BY lower(c.name), c.id
            """
        ).fetchall()

    def compared_columns(self) -> list[Column]:
        return [c for c in self.columns if not c.read_only and c.field not in ("id", "inchikey")]

    def prepare(self, row: dict[str, Any], ctx: ImportContext) -> dict[str, Any]:
        _require(row, self.columns)
        try:
            parsed = parse_or_reject("smiles", row["canonical_smiles"])
            fields = compound_fields(parsed.mol)
        except StructureRejected as exc:
            raise RowError("invalid_structure", f"RDKit rejected the structure: {exc}", "Canonical SMILES") from None
        if row.get("inchikey") and row["inchikey"] != fields["inchikey"]:
            raise RowError(
                "inchikey_mismatch",
                f"the 'InChIKey' cell says {row['inchikey']} but RDKit computes {fields['inchikey']} for this structure",
                "InChIKey",
            )
        row["canonical_smiles"] = fields["canonical_smiles"]
        row["inchikey"] = fields["inchikey"]
        row["_fields"] = fields
        # A compound is identified by its InChIKey. The 'ID' cell matters only in two cases: it is
        # kept as the id of a compound that is new to this database, and it must not point at a
        # compound with another structure. An id from another instance is otherwise ignored.
        if row.get("id") is not None:
            by_id = ctx.conn.execute("SELECT inchikey FROM compounds WHERE id = %s", (row["id"],)).fetchone()
            if by_id is not None and by_id["inchikey"] != row["inchikey"]:
                raise RowError(
                    "structure_change_not_allowed",
                    f"compound {row['id']} has InChIKey {by_id['inchikey']}; the row's structure has {row['inchikey']}. "
                    "The structure of an existing compound cannot be changed by import; clear the 'ID' cell to add it as a new compound.",
                    "Canonical SMILES",
                )
        return row

    def apply(self, ctx: ImportContext, row: dict[str, Any], existing: dict[str, Any] | None, changed: list[str]) -> None:
        names = [(row["name"], "preferred")]
        if row.get("iupac_name"):
            names.append((row["iupac_name"], "iupac"))
        names.extend((s, "synonym") for s in row.get("synonyms") or [])
        upsert_compound(
            ctx.conn,
            name=row["name"],
            iupac_name=row.get("iupac_name"),
            fields=row["_fields"],
            source_id=ctx.source_id(row),
            external_ids=row.get("external_ids") or {},
            source_url=row.get("source_url"),
            source_record=None,
            synonyms=names,
            compound_id=row.get("id") if existing is None else None,
        )


# ---------------------------------------------------------------------------------------------
# Functional groups
# ---------------------------------------------------------------------------------------------


class FunctionalGroupsSheet(Sheet):
    name = "Functional Groups"
    key_fields = ("group_set", "key")
    columns = (
        Column("Set", "group_set", "str", required=True, width=34),
        Column("Key", "key", "str", required=True, width=28),
        Column("Name", "name", "str", required=True, width=36),
        Column("SMARTS", "smarts", "str", required=True, width=50),
        Column("Description", "description", "str", width=50),
        Column("Parent key", "parent_key", "str", width=24),
        Column("Position", "position", "int", width=10),
        Column("Source file", "source_file", "str", width=30),
    )

    def key(self, row: dict[str, Any]) -> tuple[Any, ...]:
        return (row["group_set"], row["key"])

    def export_rows(self, conn: psycopg.Connection[Any]) -> list[dict[str, Any]]:
        fields = ", ".join(f"fg.{c.field}" for c in self.columns)
        return conn.execute(
            f"SELECT {fields}, {PROVENANCE_SELECT} FROM functional_groups fg JOIN data_sources ds ON ds.id = fg.source_id "
            "ORDER BY fg.group_set, fg.position, fg.id"
        ).fetchall()

    def prepare(self, row: dict[str, Any], ctx: ImportContext) -> dict[str, Any]:
        _require(row, self.columns)
        with rdlog.capture() as log:
            pattern = Chem.MolFromSmarts(row["smarts"])
        if pattern is None:
            said = "; ".join(rdlog.messages(log)) or "RDKit could not parse the SMARTS"
            raise RowError("invalid_smarts", f"RDKit rejected the SMARTS: {said}", "SMARTS")
        if row.get("position") is None:
            row["position"] = 0
        return row

    def apply(self, ctx: ImportContext, row: dict[str, Any], existing: dict[str, Any] | None, changed: list[str]) -> None:
        fields = tuple(c.field for c in self.columns)
        ctx.conn.execute(_upsert_sql("functional_groups", (*fields, "source_id"), ("group_set", "key")), [row.get(f) for f in fields] + [ctx.source_id(row)])


# ---------------------------------------------------------------------------------------------
# Solvents and catalysts
# ---------------------------------------------------------------------------------------------


def _check_properties(properties: Any) -> None:
    for index, item in enumerate(properties or [], start=1):
        if not isinstance(item, dict):
            raise RowError("invalid_property", f"property {index} must be a JSON object", "Properties (JSON)")
        if not isinstance(item.get("name"), str) or not item["name"].strip():
            raise RowError("invalid_property", f"property {index} needs a 'name'", "Properties (JSON)")
        if "value" not in item or isinstance(item["value"], (dict, list)) or item["value"] is None:
            raise RowError("invalid_property", f"property {index} ({item['name']}) needs a 'value' that is a number or a text", "Properties (JSON)")
        if not isinstance(item.get("source"), str) or not item["source"].strip():
            raise RowError(
                "property_without_source",
                f"property {index} ({item['name']}) has no 'source'. A property is only stored together with where it was obtained.",
                "Properties (JSON)",
            )
        if isinstance(item["value"], (int, float)) and not isinstance(item["value"], bool) and "unit" not in item:
            raise RowError("property_without_unit", f"property {index} ({item['name']}) is a number without a 'unit' (use null for a dimensionless value)", "Properties (JSON)")
        if item.get("evidence", "reference") not in EVIDENCE_LEVELS:
            raise RowError("invalid_property", f"property {index} ({item['name']}) has an unknown 'evidence' level", "Properties (JSON)")
        item.setdefault("evidence", "reference")
        item.setdefault("unit", None)


class RoleSheet(Sheet):
    table = ""
    key_fields = ("name",)
    columns = (
        Column("ID", "id", "uuid", read_only=True, width=38),
        Column("Name", "name", "str", required=True, width=40),
        Column("Canonical SMILES", "canonical_smiles", "str", width=50),
        Column("InChI", "inchi", "str", read_only=True, width=50),
        Column("InChIKey", "inchikey", "str", width=30),
        Column("Molecular formula", "molecular_formula", "str", read_only=True),
        Column("Structure status", "structure_status", "str", read_only=True),
        Column("Structure notes", "structure_notes", "str", read_only=True, width=30),
        Column("External IDs (JSON)", "external_ids", "json", json_type="object", width=30),
        Column("Properties (JSON)", "properties", "json", json_type="array", width=50),
        Column("Linked compound ID", "compound_id", "uuid", read_only=True, width=38),
        Column("Record URL", "source_url", "str", width=40),
    )

    def compared_columns(self) -> list[Column]:
        return [c for c in self.columns if not c.read_only and c.field not in ("name", "inchikey")]

    def export_rows(self, conn: psycopg.Connection[Any]) -> list[dict[str, Any]]:
        fields = ", ".join(f"r.{c.field}" for c in self.columns)
        return conn.execute(f"SELECT {fields}, {PROVENANCE_SELECT} FROM {self.table} r JOIN data_sources ds ON ds.id = r.source_id ORDER BY lower(r.name)").fetchall()

    def prepare(self, row: dict[str, Any], ctx: ImportContext) -> dict[str, Any]:
        _require(row, self.columns)
        structure = role_fields("smiles", row.get("canonical_smiles"))
        if row.get("canonical_smiles") and structure["structure_status"] != "rdkit-validated":
            raise RowError("invalid_structure", structure["structure_notes"] or "RDKit rejected the structure", "Canonical SMILES")
        if row.get("inchikey") and structure["inchikey"] and row["inchikey"] != structure["inchikey"]:
            raise RowError("inchikey_mismatch", f"the 'InChIKey' cell says {row['inchikey']} but RDKit computes {structure['inchikey']} for this structure", "InChIKey")
        if row.get("inchikey") and not row.get("canonical_smiles"):
            raise RowError("missing_value", "an 'InChIKey' needs the structure it belongs to in 'Canonical SMILES'", "Canonical SMILES")
        _check_properties(row.get("properties"))
        row["canonical_smiles"] = structure["canonical_smiles"]
        row["_structure"] = structure
        return row

    def apply(self, ctx: ImportContext, row: dict[str, Any], existing: dict[str, Any] | None, changed: list[str]) -> None:
        upsert_role(
            ctx.conn,
            self.table,
            {
                "name": row["name"],
                **row["_structure"],
                "external_ids": row.get("external_ids") or {},
                "properties": row.get("properties") or [],
                "source_id": ctx.source_id(row),
                "source_url": row.get("source_url"),
                "source_record": None,
            },
        )


class CatalystsSheet(RoleSheet):
    name = "Catalysts"
    table = "catalysts"


class SolventsSheet(RoleSheet):
    name = "Solvents"
    table = "solvents"


# ---------------------------------------------------------------------------------------------
# Reactions
# ---------------------------------------------------------------------------------------------


class ReactionsSheet(Sheet):
    name = "Reactions"
    key_fields = ("id",)
    columns = (
        Column("ID", "id", "uuid", width=38),
        Column("Name", "name", "str", required=True, width=36),
        Column("Reaction SMILES", "reaction_smiles", "str", required=True, width=60),
        Column("Description", "description", "str", width=40),
        Column("Temperature (K)", "temperature_k", "float"),
        Column("Pressure (Pa)", "pressure_pa", "float"),
        Column("Solvent ID", "solvent_id", "uuid", width=38),
        Column("Catalyst ID", "catalyst_id", "uuid", width=38),
        Column("Conditions (JSON)", "conditions", "json", json_type="object", width=30),
        Column("Balanced", "balanced", "bool", read_only=True, width=10),
        Column("Evidence level", "evidence_level", "str", required=True, choices=EVIDENCE_LEVELS),
    )

    def export_rows(self, conn: psycopg.Connection[Any]) -> list[dict[str, Any]]:
        fields = ", ".join(f"r.{c.field}" for c in self.columns)
        return conn.execute(f"SELECT {fields}, {PROVENANCE_SELECT} FROM reactions r JOIN data_sources ds ON ds.id = r.source_id ORDER BY lower(r.name), r.id").fetchall()

    def prepare(self, row: dict[str, Any], ctx: ImportContext) -> dict[str, Any]:
        _require(row, self.columns)
        parsed = parse_reaction(row["reaction_smiles"])
        if not parsed.valid:
            raise RowError("invalid_reaction", f"RDKit rejected the reaction SMILES: {'; '.join(parsed.errors)}", "Reaction SMILES")
        for label, table, value in (("Solvent ID", "solvents", row.get("solvent_id")), ("Catalyst ID", "catalysts", row.get("catalyst_id"))):
            if value is not None and not _exists(ctx.conn, table, value):
                raise RowError("unknown_reference", f"'{label}' {value} does not exist", label)
        for label, value in (("Temperature (K)", row.get("temperature_k")), ("Pressure (Pa)", row.get("pressure_pa"))):
            if value is not None and value < 0:
                raise RowError("out_of_range", f"'{label}' cannot be negative", label)
        row["reaction_smiles"] = parsed.reaction_smiles
        row["_parsed"] = parsed
        if row.get("id") is None:
            row["id"] = _content_id(self.name, row, ("name", "reaction_smiles", "description", "temperature_k", "pressure_pa", "solvent_id", "catalyst_id", "conditions", "evidence_level"))
        return row

    def apply(self, ctx: ImportContext, row: dict[str, Any], existing: dict[str, Any] | None, changed: list[str]) -> None:
        insert_reaction(
            ctx.conn,
            name=row["name"],
            parsed=row["_parsed"],
            source_id=ctx.source_id(row),
            evidence_level=row["evidence_level"],
            description=row.get("description"),
            temperature_k=row.get("temperature_k"),
            pressure_pa=row.get("pressure_pa"),
            solvent_id=row.get("solvent_id"),
            catalyst_id=row.get("catalyst_id"),
            conditions=row.get("conditions") or {},
            reaction_id=row["id"],
        )


# ---------------------------------------------------------------------------------------------
# Calculations
# ---------------------------------------------------------------------------------------------

_JOB_STATUSES = ("queued", "running", "succeeded", "failed", "cancelled", "unsupported")


class CalculationsSheet(Sheet):
    name = "Calculations"
    key_fields = ("id",)
    columns = (
        Column("ID", "id", "uuid", required=True, width=38),
        Column("Kind", "kind", "str", required=True, width=30),
        Column("Status", "status", "str", required=True, width=14, choices=_JOB_STATUSES),
        Column("Input hash (SHA-256)", "input_hash", "str", required=True, width=66),
        Column("Engine", "engine", "str", required=True, width=10),
        Column("Engine version", "engine_version", "str", width=14),
        Column("Method", "method", "str", width=26),
        Column("Converged", "converged", "bool", width=10),
        Column("Progress (0-1)", "progress", "float", required=True, width=12),
        Column("Input (JSON)", "input", "json", required=True, json_type="object", width=50),
        Column("Settings (JSON)", "settings", "json", json_type="object", width=40),
        Column("Result (JSON)", "result", "json", json_type="object", width=50),
        Column("Error (JSON)", "error", "json", json_type="object", width=40),
        Column("Software versions (JSON)", "software", "json", json_type="object", width=40),
        Column("Messages (JSON)", "messages", "json", json_type="array", width=40),
        Column("Timeout (s)", "timeout_seconds", "float", required=True, width=12),
        Column("Origin", "origin", "str", read_only=True, width=10),
        Column("Created at (UTC)", "created_at", "datetime", required=True, width=30),
        Column("Started at (UTC)", "started_at", "datetime", width=30),
        Column("Finished at (UTC)", "finished_at", "datetime", width=30),
    )

    def differs(self, row: dict[str, Any], existing: dict[str, Any], omitted: set[str]) -> list[str]:
        changed = super().differs(row, existing, omitted)
        # result and error are null for some statuses: an empty cell and a missing document are the same thing.
        return [f for f in changed if not (f in ("result", "error") and not row.get(f) and not existing.get(f))]

    def export_rows(self, conn: psycopg.Connection[Any]) -> list[dict[str, Any]]:
        fields = ", ".join(f"c.{c.field}" for c in self.columns)
        return conn.execute(f"SELECT {fields}, {PROVENANCE_SELECT} FROM calculations c JOIN data_sources ds ON ds.id = c.source_id ORDER BY c.created_at, c.id").fetchall()

    def prepare(self, row: dict[str, Any], ctx: ImportContext) -> dict[str, Any]:
        _require(row, self.columns)
        row["settings"] = row.get("settings") or {}
        row["software"] = row.get("software") or {}
        row["messages"] = row.get("messages") or []
        return row

    def apply(self, ctx: ImportContext, row: dict[str, Any], existing: dict[str, Any] | None, changed: list[str]) -> None:
        if existing is not None:
            raise RowError(
                "immutable_record",
                f"calculation {row['id']} already exists and differs in: {', '.join(changed)}. A calculation is the record of a run and cannot be changed by import.",
            )
        if row["status"] not in TERMINAL_STATUSES:
            raise RowError("not_importable", f"only finished calculations can be imported; this one is '{row['status']}'", "Status")
        if row.get("finished_at") is None:
            raise RowError("missing_value", "'Finished at (UTC)' is required for a finished calculation", "Finished at (UTC)")
        expected = input_hash(row["kind"], row["input"], row["settings"])
        if expected != row["input_hash"]:
            raise RowError(
                "input_hash_mismatch",
                f"the 'Input hash (SHA-256)' cell does not match the kind, input and settings of the row (computed {expected})",
                "Input hash (SHA-256)",
            )
        if row["status"] == "succeeded" and not row.get("result"):
            raise RowError("missing_value", "a succeeded calculation needs its 'Result (JSON)'", "Result (JSON)")
        if row["status"] in ("failed", "unsupported") and not row.get("error"):
            raise RowError("missing_value", f"a {row['status']} calculation needs its 'Error (JSON)'", "Error (JSON)")
        ctx.conn.execute(
            """
            INSERT INTO calculations (id, kind, status, input, settings, input_hash, engine, engine_version, software, method, progress,
                                      messages, result, converged, error, timeout_seconds, origin, source_id, created_at, started_at, finished_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 'import', %s, %s, %s, %s)
            """,
            (
                row["id"],
                row["kind"],
                row["status"],
                Jsonb(row["input"]),
                Jsonb(row["settings"]),
                row["input_hash"],
                row["engine"],
                row.get("engine_version"),
                Jsonb(row["software"]),
                row.get("method"),
                row["progress"],
                Jsonb(row["messages"]),
                Jsonb(row["result"]) if row["status"] == "succeeded" else None,
                row.get("converged") if row["status"] == "succeeded" else None,
                Jsonb(row["error"]) if row["status"] in ("failed", "unsupported") else None,
                row["timeout_seconds"],
                ctx.source_id(row),
                row["created_at"],
                row.get("started_at"),
                row["finished_at"],
            ),
        )


# ---------------------------------------------------------------------------------------------
# Experiments
# ---------------------------------------------------------------------------------------------


class ExperimentsSheet(Sheet):
    name = "Experiments"
    key_fields = ("id",)
    columns = (
        Column("ID", "id", "uuid", width=38),
        Column("Title", "title", "str", required=True, width=36),
        Column("Description", "description", "str", width=40),
        Column("Kind", "kind", "str"),
        Column("Inputs (JSON)", "inputs", "json", json_type="object", width=50),
        Column("Settings (JSON)", "settings", "json", json_type="object", width=40),
        Column("Results (JSON)", "results", "json", json_type="object", width=40),
        Column("Notes", "notes", "str", width=40),
        Column("Tags", "tags", "str_list", width=24),
        Column("Reaction ID", "reaction_id", "uuid", width=38),
        Column("Calculation IDs", "calculation_ids", "str_list", width=40),
        Column("Revision", "revision", "int", read_only=True, width=10),
        Column("Created at (UTC)", "created_at", "datetime", read_only=True, width=30),
        Column("Updated at (UTC)", "updated_at", "datetime", read_only=True, width=30),
    )

    def export_rows(self, conn: psycopg.Connection[Any]) -> list[dict[str, Any]]:
        return conn.execute(
            f"""
            SELECT x.id, x.title, x.description, x.kind, x.inputs, x.settings, x.results, x.notes, x.tags, x.reaction_id,
                   COALESCE((SELECT array_agg(l.calculation_id::text ORDER BY l.position, l.linked_at, l.calculation_id)
                             FROM experiment_calculations l WHERE l.experiment_id = x.id), '{{}}') AS calculation_ids,
                   x.revision, x.created_at, x.updated_at, {PROVENANCE_SELECT}
            FROM experiments x JOIN data_sources ds ON ds.id = x.source_id ORDER BY x.created_at, x.id
            """
        ).fetchall()

    def prepare(self, row: dict[str, Any], ctx: ImportContext) -> dict[str, Any]:
        _require(row, self.columns)
        if row.get("reaction_id") is not None and not _exists(ctx.conn, "reactions", row["reaction_id"]):
            raise RowError("unknown_reference", f"'Reaction ID' {row['reaction_id']} does not exist", "Reaction ID")
        calculation_ids = []
        for text in row.get("calculation_ids") or []:
            try:
                calculation_id = UUID(text)
            except ValueError:
                raise RowError("wrong_type", f"'Calculation IDs' contains {text!r}, which is not a UUID", "Calculation IDs") from None
            if not _exists(ctx.conn, "calculations", calculation_id):
                raise RowError("unknown_reference", f"'Calculation IDs' refers to calculation {text}, which does not exist", "Calculation IDs")
            calculation_ids.append(str(calculation_id))
        row["calculation_ids"] = calculation_ids
        if row.get("id") is None:
            row["id"] = _content_id(
                self.name, row, ("title", "description", "kind", "inputs", "settings", "results", "notes", "tags", "reaction_id", "calculation_ids")
            )
        return row

    def apply(self, ctx: ImportContext, row: dict[str, Any], existing: dict[str, Any] | None, changed: list[str]) -> None:
        conn = ctx.conn
        values = (
            row["title"],
            row.get("description"),
            row.get("kind"),
            Jsonb(row.get("inputs") or {}),
            Jsonb(row.get("settings") or {}),
            Jsonb(row.get("results") or {}),
            row.get("notes"),
            list(dict.fromkeys(row.get("tags") or [])),
            row.get("reaction_id"),
            ctx.source_id(row),
        )
        if existing is None:
            conn.execute(
                "INSERT INTO experiments (id, title, description, kind, inputs, settings, results, notes, tags, reaction_id, source_id) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                (row["id"], *values),
            )
        else:
            conn.execute(
                "UPDATE experiments SET title = %s, description = %s, kind = %s, inputs = %s, settings = %s, results = %s, notes = %s, "
                "tags = %s, reaction_id = %s, source_id = %s, revision = revision + 1 WHERE id = %s",
                (*values, row["id"]),
            )
        conn.execute("DELETE FROM experiment_calculations WHERE experiment_id = %s", (row["id"],))
        for position, calculation_id in enumerate(row["calculation_ids"]):
            conn.execute(
                "INSERT INTO experiment_calculations (experiment_id, calculation_id, position) VALUES (%s, %s, %s) ON CONFLICT DO NOTHING",
                (row["id"], calculation_id, position),
            )


# ---------------------------------------------------------------------------------------------
# Discoveries
# ---------------------------------------------------------------------------------------------

_SEARCH_KEYS = ("catalog_key", "catalog_title", "catalog_scope", "search_method", "searched_at", "outcome")
_EVIDENCE_KINDS = (
    "structure-validation",
    "catalog-search",
    "external-lookup",
    "calculation",
    "experimental-observation",
    "independent-validation",
    "status-change",
    "note",
    "import",
)


def _timestamp(value: Any, what: str, column: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        raise RowError("wrong_type", f"{what} must be an ISO 8601 timestamp, found {value!r}", column) from None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _instant(value: Any) -> Any:
    """A timestamp text in one spelling, for comparison; anything unparseable is left as it is."""
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return value
    return (parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)).astimezone(timezone.utc).isoformat()


def _search_form(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": str(item.get("id") or "").lower(),
        **{key: item.get(key) for key in ("catalog_key", "catalog_title", "catalog_scope", "search_method", "records_searched", "outcome", "detail", "request_url", "http_status")},
        "parameters": item.get("parameters") or {},
        "matches": item.get("matches") or [],
        "searched_at": _instant(item.get("searched_at")),
    }


def _evidence_form(item: dict[str, Any]) -> dict[str, Any] | None:
    # The note this service adds when it imports a candidate is bookkeeping of the importing
    # instance, not part of the trail a workbook carries.
    if item.get("kind") == "import":
        return None
    details = dict(item.get("details") or {})
    # A link to a calculation that did not exist here at import time is kept in the details.
    calculation_id = item.get("calculation_id") or details.pop("calculation_id_at_origin", None)
    return {
        **{key: item.get(key) for key in ("kind", "summary", "recorded_by", "reference", "status_before", "status_after")},
        "details": details,
        "calculation_id": str(calculation_id).lower() if calculation_id else None,
        "catalog_search_id": str(item["catalog_search_id"]).lower() if item.get("catalog_search_id") else None,
        "created_at": _instant(item.get("created_at")),
    }


def _trail(items: Any, form: Any) -> list[str]:
    """Order-independent normal form of a list of search or evidence records."""
    if not isinstance(items, list):
        return []
    documents = []
    for item in items:
        if not isinstance(item, dict):
            documents.append(compact_json(item))
            continue
        normal = form(item)
        if normal is not None:
            documents.append(compact_json(normal))
    return sorted(documents)


class DiscoveriesSheet(Sheet):
    name = "Discoveries"
    key_fields = ("id",)
    columns = (
        Column("ID", "id", "uuid", width=38),
        Column("Title", "title", "str", required=True, width=36),
        Column("Notes", "notes", "str", width=40),
        Column("Status", "status", "str", required=True, width=32, choices=discovery.LADDER),
        Column("Input format", "input_format", "str", required=True, width=12, choices=("smiles", "molblock")),
        Column("Input structure", "input_structure", "str", required=True, width=40),
        Column("Structure valid", "structure_valid", "bool", read_only=True, width=12),
        Column("Canonical SMILES", "canonical_smiles", "str", read_only=True, width=40),
        Column("InChI", "inchi", "str", read_only=True, width=40),
        Column("InChIKey", "inchikey", "str", read_only=True, width=30),
        Column("Molecular formula", "molecular_formula", "str", read_only=True),
        Column("Molecular weight (g/mol)", "molecular_weight_g_per_mol", "float", read_only=True),
        Column("Monoisotopic mass (u)", "monoisotopic_mass_u", "float", read_only=True),
        Column("Catalogues searched", "catalogues_searched", "str", read_only=True, width=60),
        Column("Catalogue searches (JSON)", "catalog_searches", "json", json_type="array", width=50),
        Column("Evidence (JSON)", "evidence", "json", json_type="array", width=50),
        Column("Created at (UTC)", "created_at", "datetime", read_only=True, width=30),
        Column("Updated at (UTC)", "updated_at", "datetime", read_only=True, width=30),
    )
    _immutable = ("status", "input_format", "input_structure", "catalog_searches", "evidence")

    def export_rows(self, conn: psycopg.Connection[Any]) -> list[dict[str, Any]]:
        rows = conn.execute(
            f"""
            SELECT d.id, d.title, d.notes, d.status, d.input_format, d.input_structure, d.structure_valid, d.canonical_smiles, d.inchi,
                   d.inchikey, d.molecular_formula, d.molecular_weight_g_per_mol, d.monoisotopic_mass_u, d.created_at, d.updated_at,
                   {PROVENANCE_SELECT}
            FROM discoveries d JOIN data_sources ds ON ds.id = d.source_id ORDER BY d.created_at, d.id
            """
        ).fetchall()
        for row in rows:
            searches = conn.execute(
                """
                SELECT id, catalog_key, catalog_title, catalog_scope, search_method, parameters, records_searched, searched_at, outcome,
                       matches, detail, request_url, http_status
                FROM discovery_catalog_searches WHERE discovery_id = %s ORDER BY searched_at, created_at, id
                """,
                (row["id"],),
            ).fetchall()
            evidence = conn.execute(
                """
                SELECT kind, summary, details, recorded_by, calculation_id, catalog_search_id, reference, status_before, status_after, created_at
                FROM discovery_evidence WHERE discovery_id = %s ORDER BY created_at, id
                """,
                (row["id"],),
            ).fetchall()
            catalogs = discovery.searched_catalogs(searches)
            row["catalogues_searched"] = "; ".join(
                f"{c['catalog_title']}: "
                + (f"{c['records_searched']} records" if c["records_searched"] is not None else "record count not reported")
                + f", last searched {c['last_searched_at'].isoformat(timespec='seconds').replace('+00:00', 'Z')}"
                for c in catalogs
            ) or None
            row["catalog_searches"] = [_plain(s) for s in searches]
            row["evidence"] = [_plain(e) for e in evidence]
        return rows

    def prepare(self, row: dict[str, Any], ctx: ImportContext) -> dict[str, Any]:
        _require(row, self.columns)
        row["catalog_searches"] = row.get("catalog_searches") or []
        row["evidence"] = row.get("evidence") or []
        if row.get("id") is None:
            row["id"] = _content_id(self.name, row, ("title", "notes", "status", "input_format", "input_structure", "catalog_searches", "evidence"))
        return row

    def differs(self, row: dict[str, Any], existing: dict[str, Any], omitted: set[str]) -> list[str]:
        changed = [f for f in super().differs(row, existing, omitted) if f not in ("catalog_searches", "evidence")]
        if "catalog_searches" not in omitted and _trail(row.get("catalog_searches"), _search_form) != _trail(existing.get("catalog_searches"), _search_form):
            changed.append("catalog_searches")
        if "evidence" not in omitted and _trail(row.get("evidence"), _evidence_form) != _trail(existing.get("evidence"), _evidence_form):
            changed.append("evidence")
        return changed

    def apply(self, ctx: ImportContext, row: dict[str, Any], existing: dict[str, Any] | None, changed: list[str]) -> None:
        conn = ctx.conn
        if existing is not None:
            locked = [f for f in changed if f in self._immutable]
            if locked:
                headers = ", ".join(c.header for c in self.columns if c.field in locked)
                raise RowError(
                    "immutable_field",
                    f"candidate {row['id']} already exists; {headers} cannot be changed by import. "
                    "The structure is fixed, and the status and evidence trail change only through the API, where the evidence rules apply.",
                )
            conn.execute("UPDATE discoveries SET title = %s, notes = %s WHERE id = %s", (row["title"], row.get("notes"), row["id"]))
            return

        parsed = parse_structure(row["input_format"], row["input_structure"])
        usable = False
        ident: dict[str, Any] = {}
        if parsed.valid and parsed.mol is not None:
            ident = identity(parsed.mol)
            usable = ident["inchikey"] is not None
        if not usable and row["status"] != "user-created":
            raise RowError(
                "invalid_structure",
                f"RDKit does not accept the structure ({parsed.error_summary()}), so the candidate cannot have status '{row['status']}'",
                "Input structure",
            )
        from ..chem.structure import validation_report
        from ..catalogue.records import depiction_molblock

        report = validation_report(parsed)
        validation = {key: report[key] for key in ("valid", "stage", "sanitization", "errors", "warnings", "engine")}
        conn.execute(
            """
            INSERT INTO discoveries (id, title, notes, status, input_format, input_structure, structure_valid, validation, canonical_smiles,
                                     inchi, inchikey, molecular_formula, molblock, molecular_weight_g_per_mol, monoisotopic_mass_u,
                                     derived_by, source_id)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                row["id"],
                row["title"],
                row.get("notes"),
                row["status"],
                row["input_format"],
                row["input_structure"],
                usable,
                Jsonb(validation),
                ident.get("canonical_smiles") if usable else None,
                ident.get("inchi") if usable else None,
                ident.get("inchikey") if usable else None,
                ident.get("molecular_formula") if usable else None,
                depiction_molblock(standard_mol(parsed.mol)) if usable and parsed.mol is not None else None,
                ident.get("molecular_weight_g_per_mol") if usable else None,
                ident.get("monoisotopic_mass_u") if usable else None,
                Jsonb(derived_by()) if usable else None,
                ctx.source_id(row),
            ),
        )

        search_ids: dict[str, UUID] = {}
        for index, item in enumerate(row["catalog_searches"], start=1):
            if not isinstance(item, dict) or any(key not in item for key in _SEARCH_KEYS):
                raise RowError("invalid_value", f"catalogue search {index} must be an object with {', '.join(_SEARCH_KEYS)}", "Catalogue searches (JSON)")
            # The id of the search is kept, so that the evidence records that refer to it still do.
            try:
                search_id = UUID(str(item["id"])) if item.get("id") else uuid.uuid4()
            except ValueError:
                raise RowError("wrong_type", f"'id' of catalogue search {index} is not a UUID", "Catalogue searches (JSON)") from None
            conn.execute(
                """
                INSERT INTO discovery_catalog_searches (id, discovery_id, catalog_key, catalog_title, catalog_scope, search_method, parameters,
                                                        records_searched, searched_at, outcome, matches, detail, request_url, http_status)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    search_id,
                    row["id"],
                    item["catalog_key"],
                    item["catalog_title"],
                    item["catalog_scope"],
                    item["search_method"],
                    Jsonb(item.get("parameters") or {}),
                    item.get("records_searched"),
                    _timestamp(item["searched_at"], f"'searched_at' of catalogue search {index}", "Catalogue searches (JSON)"),
                    item["outcome"],
                    Jsonb(item.get("matches") or []),
                    item.get("detail"),
                    item.get("request_url"),
                    item.get("http_status"),
                ),
            )
            if item.get("id"):
                search_ids[str(item["id"]).lower()] = search_id

        for index, item in enumerate(row["evidence"], start=1):
            if not isinstance(item, dict) or item.get("kind") not in _EVIDENCE_KINDS or not item.get("summary") or item.get("recorded_by") not in ("service", "user"):
                raise RowError("invalid_value", f"evidence record {index} needs a known 'kind', a 'summary' and 'recorded_by' (service or user)", "Evidence (JSON)")
            details = dict(item.get("details") or {})
            calculation_id = item.get("calculation_id")
            if calculation_id:
                try:
                    known = _exists(conn, "calculations", UUID(str(calculation_id)))
                except ValueError:
                    raise RowError("wrong_type", f"'calculation_id' of evidence record {index} is not a UUID", "Evidence (JSON)") from None
                if not known:
                    details["calculation_id_at_origin"] = calculation_id
                    calculation_id = None
            conn.execute(
                """
                INSERT INTO discovery_evidence (discovery_id, kind, summary, details, recorded_by, calculation_id, catalog_search_id,
                                                reference, status_before, status_after, created_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    row["id"],
                    item["kind"],
                    item["summary"],
                    Jsonb(details),
                    item["recorded_by"],
                    calculation_id,
                    search_ids.get(str(item["catalog_search_id"]).lower()) if item.get("catalog_search_id") else None,
                    item.get("reference"),
                    item.get("status_before"),
                    item.get("status_after"),
                    _timestamp(item.get("created_at"), f"'created_at' of evidence record {index}", "Evidence (JSON)"),
                ),
            )
        discovery.add_evidence(
            conn,
            row["id"],
            kind="import",
            summary=(
                f"Imported from the workbook {ctx.filename!r} with status '{row['status']}'. The status, searches and evidence above are as recorded "
                "in the workbook; this service validated the structure but did not repeat the searches or verify the evidence."
            ),
            recorded_by="service",
            details={"workbook": ctx.filename, "sha256": ctx.sha256, "structure_valid": usable},
            status_after=row["status"],
        )


def _plain(record: dict[str, Any]) -> dict[str, Any]:
    """A database row as a JSON-ready document (UUIDs and timestamps as text)."""
    out: dict[str, Any] = {}
    for key, value in record.items():
        if isinstance(value, datetime):
            out[key] = value.isoformat().replace("+00:00", "Z")
        elif isinstance(value, UUID):
            out[key] = str(value)
        else:
            out[key] = value
    return out


SHEETS: dict[str, Sheet] = {
    sheet.name: sheet
    for sheet in (
        ElementsSheet(),
        IsotopesSheet(),
        CompoundsSheet(),
        FunctionalGroupsSheet(),
        CatalystsSheet(),
        SolventsSheet(),
        ReactionsSheet(),
        ExperimentsSheet(),
        DiscoveriesSheet(),
        CalculationsSheet(),
    )
}

# Sheets are imported in dependency order: a row may refer to rows of the sheets before it.
IMPORT_ORDER = ("Elements", "Isotopes", "Compounds", "Functional Groups", "Solvents", "Catalysts", "Reactions", "Calculations", "Experiments", "Discoveries")

__all__ = ["SHEETS", "IMPORT_ORDER", "ImportContext", "RowError", "Sheet", "compact_json"]
