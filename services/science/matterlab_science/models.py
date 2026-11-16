"""Result models shared by the synchronous chemistry endpoints and the asynchronous jobs."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class Atom3D(BaseModel):
    """An atom with Cartesian coordinates in angstrom."""

    index: int = Field(description="Zero-based atom index. Indices below the input atom count refer to the input atoms, in input order.")
    element: str = Field(description="Element symbol.")
    atomic_number: int
    formal_charge: int | None = Field(default=None, description="Formal charge in units of e; null when the input carried no bonding information.")
    isotope: int | None = Field(default=None, description="Mass number when a specific isotope is set, otherwise null (natural composition).")
    x: float = Field(description="x coordinate in angstrom.")
    y: float = Field(description="y coordinate in angstrom.")
    z: float = Field(description="z coordinate in angstrom.")
    added_hydrogen: bool | None = Field(default=None, description="True for hydrogens the service added to make implicit hydrogens explicit.")


class Bond3D(BaseModel):
    index: int
    begin_atom_index: int
    end_atom_index: int
    order: float = Field(description="1, 2, 3, or 1.5 for an aromatic bond.")
    aromatic: bool
    rdkit_bond_type: str = Field(description="RDKit's bond type name, e.g. SINGLE, AROMATIC, DATIVE.")


class EmbedAttempt(BaseModel):
    random_initial_coordinates: bool = Field(description="False for the standard ETKDG start, true for the retry from random coordinates.")
    succeeded: bool
    failure_counts: dict[str, int] = Field(description="RDKit's embedding failure counters (EmbedFailureCauses) for this attempt.")
    messages: list[str] = Field(description="Messages RDKit logged during the attempt.")


class EmbeddingInfo(BaseModel):
    method: str = Field(description="Embedding method.", examples=["ETKDGv3"])
    succeeded: bool
    random_seed: int
    used_random_initial_coordinates: bool
    attempts: list[EmbedAttempt]
    explicit_hydrogens_added: int = Field(description="Number of implicit hydrogens that were turned into explicit atoms.")


class GeometrySource(BaseModel):
    """Where the geometry a calculation started from came from."""

    source: Literal["input-coordinates", "generated"]
    description: str
    embedding: EmbeddingInfo | None = None
    cleanup_force_field: str | None = Field(default=None, description="Force field used to clean up a generated geometry.")
    cleanup_converged: bool | None = None
    hydrogens_added: int = Field(default=0, description="Hydrogens added to the input so that every atom is explicit.")
