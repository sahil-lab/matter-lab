"""Reactions: reaction SMILES validated and canonicalised by RDKit, with a balance check."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

import psycopg
from fastapi import APIRouter, Query, Response
from pydantic import BaseModel, ConfigDict, Field

from ..chem.reactions import ReactionParse, parse_reaction
from ..chem.structure import derived_by
from ..db import Jsonb
from ..errors import ApiError, error_responses, not_found
from ..provenance import PROVENANCE_COLUMNS, EvidenceLevel, Provenance, provenance_from_row
from .common import Ctx, EngineStamp, Page, Title

router = APIRouter(prefix="/v1/reactions", tags=["reactions"])


class ReactionCreate(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        json_schema_extra={"examples": [{"name": "Hydrogen combustion", "reaction_smiles": "[H][H].[H][H].O=O>>O.O", "temperature_k": 298.15}]},
    )

    name: Title
    reaction_smiles: str = Field(min_length=3, max_length=20_000, description="`reactants>agents>products`; repeat a species to give it a stoichiometric coefficient above 1.")
    description: str | None = Field(default=None, max_length=10_000)
    temperature_k: float | None = Field(default=None, ge=0, description="Reaction temperature in kelvin.")
    pressure_pa: float | None = Field(default=None, ge=0, description="Reaction pressure in pascal.")
    solvent_id: UUID | None = None
    catalyst_id: UUID | None = None
    conditions: dict[str, Any] = Field(default_factory=dict, description="Free-form additional conditions.")


class ReactionParticipant(BaseModel):
    role: Literal["reactant", "agent", "product"]
    position: int
    canonical_smiles: str
    inchikey: str | None
    molecular_formula: str
    stoichiometric_coefficient: int
    compound_id: UUID | None = Field(description="Catalogue compound with the same InChIKey, when one exists.")


class ReactionSummary(BaseModel):
    id: UUID
    name: str
    reaction_smiles: str = Field(description="Reaction SMILES with every species canonicalised by RDKit.")
    balanced: bool = Field(description="True when every element (hydrogens included) and the total charge balance between reactants and products.")
    evidence: EvidenceLevel
    created_at: datetime
    updated_at: datetime


class Reaction(ReactionSummary):
    description: str | None
    temperature_k: float | None
    pressure_pa: float | None
    solvent_id: UUID | None
    catalyst_id: UUID | None
    conditions: dict[str, Any]
    element_imbalance: dict[str, int] = Field(description="Products minus reactants, per element; empty when balanced.")
    charge_imbalance: int
    participants: list[ReactionParticipant]
    derived_by: EngineStamp
    provenance: Provenance


def checked_reaction(reaction_smiles: str) -> ReactionParse:
    parsed = parse_reaction(reaction_smiles)
    if not parsed.valid:
        raise ApiError(
            422,
            "invalid_reaction",
            f"RDKit could not interpret the reaction SMILES: {'; '.join(parsed.errors)}",
            {"errors": parsed.errors},
        )
    return parsed


def insert_reaction(
    conn: psycopg.Connection[Any],
    *,
    name: str,
    parsed: ReactionParse,
    source_id: int,
    evidence_level: str,
    description: str | None = None,
    temperature_k: float | None = None,
    pressure_pa: float | None = None,
    solvent_id: UUID | None = None,
    catalyst_id: UUID | None = None,
    conditions: dict[str, Any] | None = None,
    reaction_id: UUID | None = None,
) -> UUID:
    """Writes a reaction and its participants. With `reaction_id` an existing reaction is replaced."""
    values = (
        name,
        parsed.reaction_smiles,
        description,
        temperature_k,
        pressure_pa,
        solvent_id,
        catalyst_id,
        Jsonb(conditions or {}),
        parsed.balanced,
        evidence_level,
        Jsonb(derived_by()),
        source_id,
    )
    columns = "name, reaction_smiles, description, temperature_k, pressure_pa, solvent_id, catalyst_id, conditions, balanced, evidence_level, derived_by, source_id"
    if reaction_id is None:
        row = conn.execute(f"INSERT INTO reactions ({columns}) VALUES ({', '.join(['%s'] * 12)}) RETURNING id", values).fetchone()
    else:
        row = conn.execute(
            f"INSERT INTO reactions (id, {columns}) VALUES (%s, {', '.join(['%s'] * 12)}) "
            f"ON CONFLICT (id) DO UPDATE SET {', '.join(f'{c.strip()} = EXCLUDED.{c.strip()}' for c in columns.split(','))} RETURNING id",
            (reaction_id, *values),
        ).fetchone()
    assert row is not None
    conn.execute("DELETE FROM reaction_participants WHERE reaction_id = %s", (row["id"],))
    for species in parsed.participants:
        compound = conn.execute("SELECT id FROM compounds WHERE inchikey = %s", (species.inchikey,)).fetchone() if species.inchikey else None
        conn.execute(
            "INSERT INTO reaction_participants (reaction_id, role, position, canonical_smiles, inchikey, molecular_formula, stoichiometric_coefficient, compound_id) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
            (
                row["id"],
                species.role,
                species.position,
                species.canonical_smiles,
                species.inchikey,
                species.molecular_formula,
                species.stoichiometric_coefficient,
                compound["id"] if compound else None,
            ),
        )
    return row["id"]


def _load(conn: psycopg.Connection[Any], reaction_id: UUID) -> Reaction | None:
    row = conn.execute(
        f"""
        SELECT r.id, r.name, r.reaction_smiles, r.description, r.temperature_k, r.pressure_pa, r.solvent_id, r.catalyst_id, r.conditions,
               r.balanced, r.evidence_level, r.derived_by, r.created_at, r.updated_at, {PROVENANCE_COLUMNS}
        FROM reactions r JOIN data_sources ds ON ds.id = r.source_id WHERE r.id = %s
        """,
        (reaction_id,),
    ).fetchone()
    if row is None:
        return None
    participants = conn.execute(
        "SELECT role, position, canonical_smiles, inchikey, molecular_formula, stoichiometric_coefficient, compound_id FROM reaction_participants "
        "WHERE reaction_id = %s ORDER BY array_position(ARRAY['reactant', 'agent', 'product'], role), position",
        (reaction_id,),
    ).fetchall()
    # The imbalance detail is recomputed from the stored reaction SMILES, so it always agrees with it.
    reparsed = parse_reaction(row["reaction_smiles"])
    return Reaction(
        id=row["id"],
        name=row["name"],
        reaction_smiles=row["reaction_smiles"],
        balanced=row["balanced"],
        evidence=row["evidence_level"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        description=row["description"],
        temperature_k=row["temperature_k"],
        pressure_pa=row["pressure_pa"],
        solvent_id=row["solvent_id"],
        catalyst_id=row["catalyst_id"],
        conditions=row["conditions"],
        element_imbalance=reparsed.element_imbalance if reparsed.valid else {},
        charge_imbalance=reparsed.charge_imbalance if reparsed.valid else 0,
        participants=[ReactionParticipant(**p) for p in participants],
        derived_by=EngineStamp(**row["derived_by"]),
        provenance=provenance_from_row(row),
    )


def _check_reference(conn: psycopg.Connection[Any], table: str, what: str, record_id: UUID | None) -> None:
    if record_id is not None and conn.execute(f"SELECT 1 FROM {table} WHERE id = %s", (record_id,)).fetchone() is None:
        raise ApiError(422, "unknown_reference", f"There is no {what} with id {record_id}.", {"field": f"{what}_id", "id": str(record_id)})


@router.post("", response_model=Reaction, status_code=201, responses=error_responses(422), summary="Create a reaction")
def create_reaction(request: ReactionCreate, ctx: Ctx) -> Reaction:
    """The reaction SMILES is parsed by RDKit; every species is canonicalised, linked to the
    catalogue when its InChIKey is known there, and the element and charge balance is computed.
    The record is stored as user input: the service checks its chemistry, not whether it occurs."""
    parsed = checked_reaction(request.reaction_smiles)
    with ctx.db.connection() as conn:
        _check_reference(conn, "solvents", "solvent", request.solvent_id)
        _check_reference(conn, "catalysts", "catalyst", request.catalyst_id)
        reaction_id = insert_reaction(
            conn,
            name=request.name.strip(),
            parsed=parsed,
            source_id=ctx.user_source_id,
            evidence_level="user-input",
            description=request.description,
            temperature_k=request.temperature_k,
            pressure_pa=request.pressure_pa,
            solvent_id=request.solvent_id,
            catalyst_id=request.catalyst_id,
            conditions=request.conditions,
        )
        reaction = _load(conn, reaction_id)
    assert reaction is not None
    return reaction


@router.get("", response_model=Page[ReactionSummary], responses=error_responses(422), summary="List reactions")
def list_reactions(ctx: Ctx, limit: int = Query(default=50, ge=1, le=500), offset: int = Query(default=0, ge=0)) -> Page[ReactionSummary]:
    with ctx.db.connection() as conn:
        total = conn.execute("SELECT count(*) AS n FROM reactions").fetchone()
        rows = conn.execute(
            "SELECT id, name, reaction_smiles, balanced, evidence_level AS evidence, created_at, updated_at FROM reactions "
            "ORDER BY lower(name), id LIMIT %s OFFSET %s",
            (limit, offset),
        ).fetchall()
    return Page[ReactionSummary](items=[ReactionSummary(**r) for r in rows], total=int(total["n"]) if total else 0, limit=limit, offset=offset)


@router.get("/{reaction_id}", response_model=Reaction, responses=error_responses(404, 422), summary="One reaction with its participants")
def get_reaction(reaction_id: UUID, ctx: Ctx) -> Reaction:
    with ctx.db.connection() as conn:
        reaction = _load(conn, reaction_id)
    if reaction is None:
        raise not_found("reaction", reaction_id)
    return reaction


@router.delete("/{reaction_id}", status_code=204, responses=error_responses(404, 422), summary="Delete a reaction")
def delete_reaction(reaction_id: UUID, ctx: Ctx) -> Response:
    if ctx.db.execute("DELETE FROM reactions WHERE id = %s", (reaction_id,)) == 0:
        raise not_found("reaction", reaction_id)
    return Response(status_code=204)
