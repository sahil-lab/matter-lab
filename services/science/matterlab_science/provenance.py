"""Provenance: the data_sources registry and the Provenance object attached to API responses."""

from __future__ import annotations

from datetime import date
from typing import Any, Literal

import psycopg
from pydantic import BaseModel, Field

from . import SERVICE_NAME, __version__
from .db import Jsonb

EvidenceLevel = Literal["reference", "computed", "rule-based", "illustrative", "user-input", "unsupported"]

SourceKind = Literal["reference-dataset", "software", "external-service", "user", "import"]

USER_SOURCE_KEY = "matterlab-user"
SERVICE_SOURCE_KEY = SERVICE_NAME


class Citation(BaseModel):
    authors: str | None = None
    title: str
    source: str | None = Field(default=None, description="Journal, publisher or dataset name.")
    year: int | None = None
    doi: str | None = None
    url: str | None = None


class Provenance(BaseModel):
    """Where a record came from. Mirrors the `Provenance` type of the frontend core package."""

    source: str = Field(description="Title of the dataset, software or import that produced the record.")
    source_key: str = Field(description="Stable key of the source in the data_sources registry.")
    kind: SourceKind
    version: str = Field(description="Dataset or software version; unversioned sources carry a snapshot label.")
    publisher: str | None = None
    url: str | None = None
    retrieved: date | None = Field(default=None, description="ISO date on which the source snapshot was retrieved.")
    license: str | None = Field(default=None, description="Licence or usage terms as stated by the source; null when not known.")
    citations: list[Citation] = Field(default_factory=list)
    notes: str | None = None


# Columns to select (with `JOIN data_sources ds`) so that `provenance_from_row` can build a Provenance.
PROVENANCE_COLUMNS = (
    "ds.key AS ds_key, ds.version AS ds_version, ds.kind AS ds_kind, ds.title AS ds_title, "
    "ds.publisher AS ds_publisher, ds.url AS ds_url, ds.license AS ds_license, "
    "ds.retrieved_on AS ds_retrieved_on, ds.citations AS ds_citations, ds.notes AS ds_notes"
)


def provenance_from_row(row: dict[str, Any]) -> Provenance:
    return Provenance(
        source=row["ds_title"],
        source_key=row["ds_key"],
        kind=row["ds_kind"],
        version=row["ds_version"],
        publisher=row["ds_publisher"],
        url=row["ds_url"],
        retrieved=row["ds_retrieved_on"],
        license=row["ds_license"],
        citations=[Citation(**c) for c in (row["ds_citations"] or [])],
        notes=row["ds_notes"],
    )


def evidence_for(source_kind: str, *, software: EvidenceLevel = "computed") -> EvidenceLevel:
    """Evidence label of a stored record, derived from the kind of source it came from.

    A record that a user typed in, or that arrived in a workbook, is `user-input` whatever it
    claims about itself: only records taken from a published dataset or service are `reference`.
    `software` is the label for records produced by software (`computed`, or `rule-based` for
    pattern definitions).
    """
    if source_kind in ("reference-dataset", "external-service"):
        return "reference"
    if source_kind == "software":
        return software
    return "user-input"


def upsert_data_source(
    conn: psycopg.Connection[Any],
    *,
    key: str,
    version: str,
    kind: str,
    title: str,
    publisher: str | None = None,
    url: str | None = None,
    license: str | None = None,
    retrieved_on: date | str | None = None,
    citations: list[dict[str, Any]] | None = None,
    notes: str | None = None,
) -> int:
    """Registers (or refreshes the description of) one versioned source and returns its id."""
    row = conn.execute(
        """
        INSERT INTO data_sources (key, version, kind, title, publisher, url, license, retrieved_on, citations, notes)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (key, version) DO UPDATE SET
          kind = EXCLUDED.kind, title = EXCLUDED.title, publisher = EXCLUDED.publisher, url = EXCLUDED.url,
          license = EXCLUDED.license, retrieved_on = EXCLUDED.retrieved_on, citations = EXCLUDED.citations, notes = EXCLUDED.notes
        WHERE (data_sources.kind, data_sources.title, data_sources.publisher, data_sources.url, data_sources.license,
               data_sources.retrieved_on, data_sources.citations, data_sources.notes)
              IS DISTINCT FROM
              (EXCLUDED.kind, EXCLUDED.title, EXCLUDED.publisher, EXCLUDED.url, EXCLUDED.license,
               EXCLUDED.retrieved_on, EXCLUDED.citations, EXCLUDED.notes)
        RETURNING id
        """,
        (key, version, kind, title, publisher, url, license, retrieved_on, Jsonb(citations or []), notes),
    ).fetchone()
    if row is not None:
        return int(row["id"])
    existing = conn.execute("SELECT id FROM data_sources WHERE key = %s AND version = %s", (key, version)).fetchone()
    assert existing is not None
    return int(existing["id"])


def ensure_user_source(conn: psycopg.Connection[Any]) -> int:
    """Source for records that users create through the API (experiments, discovery candidates, reactions)."""
    return upsert_data_source(
        conn,
        key=USER_SOURCE_KEY,
        version="unversioned",
        kind="user",
        title="MATTER LAB user records",
        notes="Created by a user through the MATTER LAB science API. Not reference data and not verified by the service.",
    )


def ensure_service_source(conn: psycopg.Connection[Any]) -> int:
    """Source for records the service itself produced without a scientific engine (e.g. an unsupported verdict)."""
    return upsert_data_source(
        conn,
        key=SERVICE_SOURCE_KEY,
        version=__version__,
        kind="software",
        title="MATTER LAB science service",
        notes="Records produced by the science service itself.",
    )
