"""Building and storing catalogue rows. All structure-derived columns come from RDKit."""

from __future__ import annotations

import uuid
from typing import Any

import psycopg
from rdkit import Chem
from rdkit.Chem import rdDepictor

from ..chem import fingerprints
from ..chem.structure import ParsedStructure, derived_by, identity, parse_structure, standard_mol
from ..db import Jsonb

# Catalogue records get name-based (version 5) UUIDs: a compound's id is derived from its InChIKey
# and a solvent's or catalyst's from its name. The same record therefore has the same id in every
# instance and after a re-seed, which keeps references in exported workbooks valid elsewhere.
CATALOGUE_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_DNS, "catalogue.matterlab")


def compound_id_for(inchikey: str) -> uuid.UUID:
    return uuid.uuid5(CATALOGUE_NAMESPACE, f"compound:{inchikey}")


def role_id_for(table: str, name: str) -> uuid.UUID:
    return uuid.uuid5(CATALOGUE_NAMESPACE, f"{table}:{name.strip().lower()}")


class StructureRejected(ValueError):
    """The structure cannot be stored as a catalogue record; the message says why (RDKit's words)."""


def parse_or_reject(fmt: str, data: str) -> ParsedStructure:
    parsed = parse_structure(fmt, data)
    if not parsed.valid:
        raise StructureRejected(parsed.error_summary())
    return parsed


def depiction_molblock(mol: Chem.Mol) -> str:
    """V2000 molfile of the hydrogen-suppressed structure with 2D depiction coordinates."""
    drawing = Chem.Mol(mol)
    rdDepictor.Compute2DCoords(drawing)
    return Chem.MolToMolBlock(drawing)


def compound_fields(mol: Chem.Mol) -> dict[str, Any]:
    """The RDKit-derived columns of a `compounds` row for a sanitised molecule."""
    ident = identity(mol)
    if ident["inchi"] is None or ident["inchikey"] is None:
        raise StructureRejected("; ".join(ident["inchi_messages"]) or "no InChI could be generated for this structure")
    standard = standard_mol(mol)
    return {
        "canonical_smiles": ident["canonical_smiles"],
        "inchi": ident["inchi"],
        "inchikey": ident["inchikey"],
        "molblock": depiction_molblock(standard),
        "molecular_formula": ident["molecular_formula"],
        "molecular_weight_g_per_mol": ident["molecular_weight_g_per_mol"],
        "monoisotopic_mass_u": ident["monoisotopic_mass_u"],
        "formal_charge": ident["formal_charge"],
        "heavy_atom_count": ident["heavy_atom_count"],
        "morgan_fp": fingerprints.to_bytes(fingerprints.morgan(standard)),
        "pattern_fp": fingerprints.to_bytes(fingerprints.pattern(standard)),
        "fingerprint_params": fingerprints.FINGERPRINT_PARAMS,
        "derived_by": derived_by(),
    }


_COMPOUND_COLUMNS = (
    "name",
    "iupac_name",
    "canonical_smiles",
    "inchi",
    "inchikey",
    "molblock",
    "molecular_formula",
    "molecular_weight_g_per_mol",
    "monoisotopic_mass_u",
    "formal_charge",
    "heavy_atom_count",
    "external_ids",
    "morgan_fp",
    "pattern_fp",
    "fingerprint_params",
    "derived_by",
    "source_id",
    "source_url",
    "source_record",
)
_JSON_COLUMNS = {"external_ids", "fingerprint_params", "derived_by", "source_record"}


def upsert_compound(
    conn: psycopg.Connection[Any],
    *,
    name: str,
    fields: dict[str, Any],
    source_id: int,
    iupac_name: str | None = None,
    external_ids: dict[str, Any] | None = None,
    source_url: str | None = None,
    source_record: dict[str, Any] | None = None,
    synonyms: list[tuple[str, str]] | None = None,
    compound_id: Any = None,
) -> tuple[Any, str]:
    """Inserts or updates the compound identified by its InChIKey.

    Returns (compound id, "inserted" | "updated" | "unchanged"). `synonyms` is a list of
    (name, kind) pairs; when given it replaces the stored names of the compound. `compound_id`
    is used as the id of a newly inserted compound (it never renames an existing one); without
    it the id is derived from the InChIKey.
    """
    values = {
        **fields,
        "name": name,
        "iupac_name": iupac_name,
        "external_ids": external_ids or {},
        "source_id": source_id,
        "source_url": source_url,
        "source_record": source_record,
    }
    params = [Jsonb(values[c]) if c in _JSON_COLUMNS and values[c] is not None else values[c] for c in _COMPOUND_COLUMNS]
    existing = conn.execute("SELECT id FROM compounds WHERE inchikey = %s", (values["inchikey"],)).fetchone()
    if existing is None:
        columns = ("id", *_COMPOUND_COLUMNS)
        row = conn.execute(
            f"INSERT INTO compounds ({', '.join(columns)}) VALUES ({', '.join(['%s'] * len(columns))}) ON CONFLICT (id) DO NOTHING RETURNING id",
            [compound_id if compound_id is not None else compound_id_for(values["inchikey"]), *params],
        ).fetchone()
        if row is None:
            # The id is taken by another record: let the database assign a random one.
            row = conn.execute(
                f"INSERT INTO compounds ({', '.join(_COMPOUND_COLUMNS)}) VALUES ({', '.join(['%s'] * len(_COMPOUND_COLUMNS))}) RETURNING id",
                params,
            ).fetchone()
        assert row is not None
        compound_id, outcome = row["id"], "inserted"
    else:
        compound_id = existing["id"]
        assignments = ", ".join(f"{c} = %s" for c in _COMPOUND_COLUMNS)
        distinct = " OR ".join(f"{c} IS DISTINCT FROM %s" for c in _COMPOUND_COLUMNS)
        changed = conn.execute(
            f"UPDATE compounds SET {assignments} WHERE id = %s AND ({distinct})",
            [*params, compound_id, *params],
        ).rowcount
        outcome = "updated" if changed else "unchanged"

    if synonyms is not None:
        wanted: dict[str, tuple[str, str, int]] = {}
        for position, (synonym, kind) in enumerate(synonyms):
            text = synonym.strip()
            if text and text.lower() not in wanted:
                wanted[text.lower()] = (text, kind, position)
        current = {
            r["name_normalized"]: (r["name"], r["kind"], r["position"])
            for r in conn.execute("SELECT name, name_normalized, kind, position FROM compound_synonyms WHERE compound_id = %s", (compound_id,))
        }
        if current != wanted:
            conn.execute("DELETE FROM compound_synonyms WHERE compound_id = %s", (compound_id,))
            with conn.cursor() as cur:
                cur.executemany(
                    "INSERT INTO compound_synonyms (compound_id, name, kind, position) VALUES (%s, %s, %s, %s)",
                    [(compound_id, text, kind, position) for text, kind, position in wanted.values()],
                )
            if outcome == "unchanged":
                outcome = "updated"
    return compound_id, outcome


_ROLE_COLUMNS = (
    "name",
    "compound_id",
    "canonical_smiles",
    "inchi",
    "inchikey",
    "molecular_formula",
    "molblock",
    "structure_status",
    "structure_notes",
    "external_ids",
    "properties",
    "derived_by",
    "source_id",
    "source_url",
    "source_record",
)
_ROLE_JSON = {"external_ids", "properties", "derived_by", "source_record"}


def role_fields(fmt: str | None, data: str | None) -> dict[str, Any]:
    """Structure columns of a solvents/catalysts row. An unparseable structure is kept as given by
    the caller (status `source-only`) together with RDKit's reason, never silently dropped."""
    if not data or fmt is None:
        return {
            "canonical_smiles": None,
            "inchi": None,
            "inchikey": None,
            "molecular_formula": None,
            "molblock": None,
            "structure_status": "none",
            "structure_notes": None,
            "derived_by": None,
        }
    parsed = parse_structure(fmt, data)
    if parsed.valid and parsed.mol is not None:
        ident = identity(parsed.mol)
        if ident["inchikey"] is not None:
            return {
                "canonical_smiles": ident["canonical_smiles"],
                "inchi": ident["inchi"],
                "inchikey": ident["inchikey"],
                "molecular_formula": ident["molecular_formula"],
                "molblock": depiction_molblock(standard_mol(parsed.mol)),
                "structure_status": "rdkit-validated",
                "structure_notes": None,
                "derived_by": derived_by(),
            }
        reason = "; ".join(ident["inchi_messages"]) or "no InChI could be generated"
    else:
        reason = parsed.error_summary()
    return {
        "canonical_smiles": None,
        "inchi": None,
        "inchikey": None,
        "molecular_formula": None,
        "molblock": None,
        "structure_status": "source-only",
        "structure_notes": f"RDKit could not validate the structure: {reason}",
        "derived_by": None,
    }


def upsert_role(conn: psycopg.Connection[Any], table: str, values: dict[str, Any]) -> tuple[Any, str]:
    """Inserts or updates a solvents/catalysts row identified by its (case-insensitive) name."""
    if table not in ("solvents", "catalysts"):
        raise ValueError(table)
    if values.get("inchikey") and not values.get("compound_id"):
        match = conn.execute("SELECT id FROM compounds WHERE inchikey = %s", (values["inchikey"],)).fetchone()
        values = {**values, "compound_id": match["id"] if match else None}
    params = [Jsonb(values.get(c)) if c in _ROLE_JSON and values.get(c) is not None else values.get(c) for c in _ROLE_COLUMNS]
    existing = conn.execute(f"SELECT id FROM {table} WHERE lower(name) = lower(%s)", (values["name"],)).fetchone()
    if existing is None:
        row = conn.execute(
            f"INSERT INTO {table} (id, {', '.join(_ROLE_COLUMNS)}) VALUES (%s, {', '.join(['%s'] * len(_ROLE_COLUMNS))}) "
            "ON CONFLICT (id) DO NOTHING RETURNING id",
            [role_id_for(table, values["name"]), *params],
        ).fetchone()
        if row is None:
            # The name-based id is taken by a record that has since been renamed: fall back to a random id.
            row = conn.execute(
                f"INSERT INTO {table} ({', '.join(_ROLE_COLUMNS)}) VALUES ({', '.join(['%s'] * len(_ROLE_COLUMNS))}) RETURNING id",
                params,
            ).fetchone()
        assert row is not None
        return row["id"], "inserted"
    assignments = ", ".join(f"{c} = %s" for c in _ROLE_COLUMNS)
    distinct = " OR ".join(f"{c} IS DISTINCT FROM %s" for c in _ROLE_COLUMNS)
    changed = conn.execute(f"UPDATE {table} SET {assignments} WHERE id = %s AND ({distinct})", [*params, existing["id"], *params]).rowcount
    return existing["id"], "updated" if changed else "unchanged"
