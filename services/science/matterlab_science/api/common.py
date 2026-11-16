"""Models and helpers shared by the routers."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated, Any, Generic, Literal, TypeVar

from fastapi import Depends, Request
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from ..chem.structure import MAX_STRUCTURE_CHARS, ParsedStructure, derived_by, parse_structure
from ..context import AppContext
from ..errors import ApiError

T = TypeVar("T")

# A title or name: surrounding whitespace is dropped and at least one character must remain.
Title = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=300)]


def get_context(request: Request) -> AppContext:
    return request.app.state.ctx


Ctx = Annotated[AppContext, Depends(get_context)]


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class StructureInput(BaseModel):
    """A molecular structure as text."""

    model_config = ConfigDict(json_schema_extra={"examples": [{"format": "smiles", "data": "CC(=O)Oc1ccccc1C(=O)O"}]})

    format: Literal["smiles", "molblock"] = Field(description="`smiles` for a SMILES string, `molblock` for an MDL molfile (V2000 or V3000).")
    data: str = Field(min_length=1, max_length=MAX_STRUCTURE_CHARS, description="The structure text.")


class EngineStamp(BaseModel):
    """The engine and versions that produced a result."""

    engine: str = Field(examples=["RDKit"])
    version: str = Field(examples=["2026.09.2"])
    inchi_software_version: str | None = Field(default=None, description="Version of the IUPAC InChI software bundled with RDKit.")


def engine_stamp() -> EngineStamp:
    return EngineStamp(**derived_by())


class Page(BaseModel, Generic[T]):
    """One page of a list."""

    items: list[T]
    total: int = Field(description="Number of records matching the request, across all pages.")
    limit: int
    offset: int


def require_structure(structure: StructureInput, *, implicit_hydrogens: bool = True, max_atoms: int | None = None) -> ParsedStructure:
    """Parses a structure or raises the standard `invalid_structure` error carrying RDKit's messages."""
    parsed = parse_structure(structure.format, structure.data, implicit_hydrogens=implicit_hydrogens)
    if not parsed.valid or parsed.mol is None:
        raise ApiError(
            422,
            "invalid_structure",
            f"RDKit could not interpret the structure: {parsed.error_summary()}",
            {
                "stage": parsed.stage,
                "failed_operation": parsed.failed_operation,
                "errors": [problem.as_dict() for problem in parsed.errors],
                "engine": derived_by(),
            },
        )
    if max_atoms is not None:
        total = parsed.mol.GetNumAtoms() + sum(atom.GetTotalNumHs(includeNeighbors=False) for atom in parsed.mol.GetAtoms())
        if total > max_atoms:
            raise ApiError(
                422,
                "structure_too_large",
                f"The structure has {total} atoms including hydrogens; this endpoint accepts at most {max_atoms}. Submit it as a job instead (POST /v1/jobs).",
                {"atom_count": total, "max_atoms": max_atoms},
            )
    return parsed


def page_params(limit: int, offset: int) -> dict[str, Any]:
    return {"limit": limit, "offset": offset}
