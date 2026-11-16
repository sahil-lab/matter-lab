"""Discovery candidates and their evidence trail."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

import psycopg
from fastapi import APIRouter, Query, Response
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .. import discovery
from ..chem.structure import parse_structure
from ..errors import ApiError, error_responses, not_found
from ..provenance import PROVENANCE_COLUMNS, Provenance, provenance_from_row
from .chem import SanitizationStatus, StructureProblem
from .common import Ctx, EngineStamp, Page, StructureInput, Title

router = APIRouter(prefix="/v1/discoveries", tags=["discoveries"])

DiscoveryStatus = Literal[
    "user-created",
    "structurally-validated",
    "no-match-in-searched-catalogs",
    "computationally-plausible",
    "experimentally-observed",
    "independently-validated",
]


class SearchOptions(BaseModel):
    similarity_threshold: float = Field(default=0.7, ge=0.0, le=1.0, description="Minimum Tanimoto similarity for the local similarity search.")
    similarity_limit: int = Field(default=10, ge=1, le=100)
    query_pubchem: bool = Field(
        default=False,
        description="Also ask PubChem (one PUG REST request) whether it has a compound with this InChIKey. The lookup, its time and its outcome are recorded.",
    )


class DiscoveryCreate(SearchOptions):
    model_config = ConfigDict(
        extra="forbid",
        json_schema_extra={"examples": [{"title": "Candidate A", "structure": {"format": "smiles", "data": "OC(=O)C1CC1c1ccncc1"}, "query_pubchem": False}]},
    )

    title: Title
    structure: StructureInput
    notes: str | None = Field(default=None, max_length=100_000)


class DiscoveryPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: Title | None = None
    notes: str | None = Field(default=None, max_length=100_000)


class SearchRequest(SearchOptions):
    model_config = ConfigDict(extra="forbid")


class EvidenceCreate(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        json_schema_extra={"examples": [{"kind": "calculation", "calculation_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6"}]},
    )

    kind: Literal["calculation", "experimental-observation", "independent-validation", "note"]
    summary: str | None = Field(default=None, min_length=1, max_length=5000, description="What the evidence shows. Generated for `calculation`; required otherwise.")
    calculation_id: UUID | None = Field(default=None, description="The job to attach (kind `calculation`).")
    reference: str | None = Field(
        default=None, min_length=1, max_length=2000, description="Citation, DOI, URL or lab-notebook reference. Required for observations and validations."
    )
    details: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _complete(self) -> "EvidenceCreate":
        if self.kind == "calculation":
            if self.calculation_id is None:
                raise ValueError("kind `calculation` needs `calculation_id`")
        else:
            if self.calculation_id is not None:
                raise ValueError("`calculation_id` belongs to kind `calculation` only")
            if not self.summary:
                raise ValueError(f"kind `{self.kind}` needs a `summary`")
            if self.kind in ("experimental-observation", "independent-validation") and not self.reference:
                raise ValueError(f"kind `{self.kind}` needs a `reference` (citation, DOI, URL or lab-notebook entry)")
        return self


class StatusChange(BaseModel):
    model_config = ConfigDict(extra="forbid", json_schema_extra={"examples": [{"status": "computationally-plausible", "justification": "MMFF94 optimisation converged"}]})

    status: DiscoveryStatus
    justification: str = Field(min_length=1, max_length=5000)


class CatalogMatch(BaseModel):
    model_config = ConfigDict(extra="allow")

    catalog: str
    name: str | None = None
    inchikey: str | None = None
    canonical_smiles: str | None = None
    compound_id: UUID | None = None
    similarity: float | None = Field(default=None, description="Tanimoto similarity, for similarity searches.")
    external_id: str | None = None
    url: str | None = None


class CatalogSearch(BaseModel):
    id: UUID
    catalog_key: str
    catalog_title: str
    catalog_scope: Literal["local", "external"]
    search_method: str = Field(description="`exact-inchikey`, `similarity-morgan-tanimoto` or `external-inchikey-lookup`.")
    match_kind: Literal["identity", "similarity"] = Field(description="Whether a hit of this search means the same structure or merely a similar one.")
    parameters: dict[str, Any]
    records_searched: int | None = Field(description="Records in the catalogue at search time; null when an external service does not report it.")
    searched_at: datetime
    outcome: Literal["match", "no-match", "error"] = Field(description="`error` means the search could not be completed; it is not a negative result.")
    matches: list[CatalogMatch]
    detail: str | None
    request_url: str | None = Field(description="URL requested, for external lookups.")
    http_status: int | None


class SearchedCatalog(BaseModel):
    catalog_key: str
    catalog_title: str
    catalog_scope: Literal["local", "external"]
    records_searched: int | None = Field(description="Size of the catalogue at its last completed search; null when the service does not report it.")
    first_searched_at: datetime
    last_searched_at: datetime
    search_count: int
    methods: list[str]
    identity_search_completed: bool = Field(description="True when at least one exact-identity search of this catalogue completed.")
    identical_structure_found: bool
    last_identity_outcome: Literal["match", "no-match", "error"] | None


class Evidence(BaseModel):
    id: UUID
    kind: str
    summary: str
    details: dict[str, Any]
    recorded_by: Literal["service", "user"] = Field(description="`user`: asserted by the user and not verified by the service.")
    calculation_id: UUID | None
    catalog_search_id: UUID | None
    reference: str | None
    status_before: str | None
    status_after: str | None
    created_at: datetime


class DiscoveryValidation(BaseModel):
    valid: bool
    stage: Literal["parse", "sanitization", "complete"]
    sanitization: SanitizationStatus
    errors: list[StructureProblem]
    warnings: list[str]
    engine: EngineStamp


class DiscoverySummary(BaseModel):
    id: UUID
    title: str
    status: DiscoveryStatus
    structure_valid: bool
    canonical_smiles: str | None
    inchikey: str | None
    molecular_formula: str | None
    created_at: datetime
    updated_at: datetime


class Discovery(DiscoverySummary):
    notes: str | None
    status_meaning: str = Field(description="What the current status does and does not say.")
    status_ladder: list[DiscoveryStatus] = Field(description="All statuses, lowest rung first.")
    input: StructureInput = Field(description="The structure exactly as submitted.")
    validation: DiscoveryValidation
    inchi: str | None
    molblock: str | None = Field(description="2D depiction molfile generated by RDKit.")
    molecular_weight_g_per_mol: float | None
    monoisotopic_mass_u: float | None
    identical_structure_found: bool = Field(description="True when the latest completed identity search of any catalogue found the same InChIKey.")
    searched_catalogs: list[SearchedCatalog] = Field(description="Which catalogues were searched, how many records they held, and when.")
    catalog_searches: list[CatalogSearch] = Field(description="Every individual search, oldest first.")
    statement: str = Field(description="Plain-language reading of the state. It never claims more than the recorded searches support.")
    evidence: list[Evidence] = Field(description="The evidence trail, oldest first. It is append-only.")
    derived_by: EngineStamp | None
    provenance: Provenance


def _load(conn: psycopg.Connection[Any], discovery_id: UUID) -> Discovery | None:
    row = conn.execute(
        f"""
        SELECT d.id, d.title, d.notes, d.status, d.input_format, d.input_structure, d.structure_valid, d.validation, d.canonical_smiles,
               d.inchi, d.inchikey, d.molecular_formula, d.molblock, d.molecular_weight_g_per_mol, d.monoisotopic_mass_u, d.derived_by,
               d.created_at, d.updated_at, {PROVENANCE_COLUMNS}
        FROM discoveries d JOIN data_sources ds ON ds.id = d.source_id WHERE d.id = %s
        """,
        (discovery_id,),
    ).fetchone()
    if row is None:
        return None
    searches = conn.execute(
        """
        SELECT id, catalog_key, catalog_title, catalog_scope, search_method, parameters, records_searched, searched_at, outcome, matches,
               detail, request_url, http_status
        FROM discovery_catalog_searches WHERE discovery_id = %s ORDER BY searched_at, created_at, id
        """,
        (discovery_id,),
    ).fetchall()
    evidence = conn.execute(
        """
        SELECT id, kind, summary, details, recorded_by, calculation_id, catalog_search_id, reference, status_before, status_after, created_at
        FROM discovery_evidence WHERE discovery_id = %s ORDER BY created_at, id
        """,
        (discovery_id,),
    ).fetchall()
    found, _completed, where = discovery.identity_state(conn, discovery_id)
    catalogs = discovery.searched_catalogs(searches)
    return Discovery(
        id=row["id"],
        title=row["title"],
        status=row["status"],
        structure_valid=row["structure_valid"],
        canonical_smiles=row["canonical_smiles"],
        inchikey=row["inchikey"],
        molecular_formula=row["molecular_formula"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        notes=row["notes"],
        status_meaning=discovery.STATUS_MEANING[row["status"]],
        status_ladder=list(discovery.LADDER),
        input=StructureInput(format=row["input_format"], data=row["input_structure"]),
        validation=DiscoveryValidation(**row["validation"]),
        inchi=row["inchi"],
        molblock=row["molblock"],
        molecular_weight_g_per_mol=row["molecular_weight_g_per_mol"],
        monoisotopic_mass_u=row["monoisotopic_mass_u"],
        identical_structure_found=found,
        searched_catalogs=[SearchedCatalog(**c) for c in catalogs],
        catalog_searches=[
            CatalogSearch(**s, match_kind="identity" if s["search_method"] in discovery.IDENTITY_METHODS else "similarity") for s in searches
        ],
        statement=discovery.statement(row, catalogs, found, where),
        evidence=[Evidence(**e) for e in evidence],
        derived_by=EngineStamp(**row["derived_by"]) if row["derived_by"] else None,
        provenance=provenance_from_row(row),
    )


def _require(conn: psycopg.Connection[Any], discovery_id: UUID) -> dict[str, Any]:
    row = conn.execute(
        "SELECT id, status, structure_valid, inchikey, input_format, input_structure FROM discoveries WHERE id = %s", (discovery_id,)
    ).fetchone()
    if row is None:
        raise not_found("discovery candidate", discovery_id)
    return row


def _searches(ctx: Any, parsed: Any, inchikey: str, options: SearchOptions) -> list[dict[str, Any]]:
    if options.query_pubchem and not ctx.settings.external_lookups_enabled:
        raise ApiError(
            422,
            "external_lookups_disabled",
            "External lookups are disabled in this service instance (MATTERLAB_EXTERNAL_LOOKUPS_ENABLED=false); submit the request with query_pubchem=false.",
            {"field": "query_pubchem"},
        )
    return discovery.perform_searches(
        ctx.catalogue,
        parsed,
        inchikey,
        similarity_threshold=options.similarity_threshold,
        similarity_limit=options.similarity_limit,
        query_pubchem=options.query_pubchem,
        pubchem_base_url=ctx.settings.pubchem_base_url,
        pubchem_timeout_seconds=ctx.settings.pubchem_timeout_seconds,
    )


@router.post("", response_model=Discovery, status_code=201, responses=error_responses(422), summary="Create a discovery candidate from a structure")
def create_discovery(request: DiscoveryCreate, ctx: Ctx) -> Discovery:
    """The service validates the structure with RDKit, searches the local catalogue (exact
    InChIKey and Morgan/Tanimoto similarity) and, only when `query_pubchem` is true, asks PubChem
    for the InChIKey. Each step is written to the evidence trail. An invalid structure is still
    stored (status `user-created`) together with RDKit's messages."""
    from ..chem.structure import identity

    parsed = parse_structure(request.structure.format, request.structure.data)
    records: list[dict[str, Any]] = []
    if parsed.valid and parsed.mol is not None:
        inchikey = identity(parsed.mol)["inchikey"]
        if inchikey is not None:
            records = _searches(ctx, parsed, inchikey, request)
    with ctx.db.connection() as conn:
        discovery_id = discovery.create(
            conn,
            title=request.title.strip(),
            notes=request.notes,
            input_format=request.structure.format,
            input_structure=request.structure.data,
            parsed=parsed,
            search_records=records,
            source_id=ctx.user_source_id,
        )
        document = _load(conn, discovery_id)
    assert document is not None
    return document


@router.get("", response_model=Page[DiscoverySummary], responses=error_responses(422), summary="List discovery candidates, most recently updated first")
def list_discoveries(
    ctx: Ctx,
    status: DiscoveryStatus | None = Query(default=None),
    inchikey: str | None = Query(default=None, pattern="^[A-Z]{14}-[A-Z]{10}-[A-Z]$"),
    limit: int = Query(default=50, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> Page[DiscoverySummary]:
    clauses: list[str] = []
    params: list[Any] = []
    for column, value in (("status", status), ("inchikey", inchikey)):
        if value is not None:
            clauses.append(f"{column} = %s")
            params.append(value)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with ctx.db.connection() as conn:
        total = conn.execute(f"SELECT count(*) AS n FROM discoveries {where}", params).fetchone()
        rows = conn.execute(
            f"SELECT id, title, status, structure_valid, canonical_smiles, inchikey, molecular_formula, created_at, updated_at FROM discoveries {where} "
            "ORDER BY updated_at DESC, id LIMIT %s OFFSET %s",
            [*params, limit, offset],
        ).fetchall()
    return Page[DiscoverySummary](items=[DiscoverySummary(**r) for r in rows], total=int(total["n"]) if total else 0, limit=limit, offset=offset)


@router.get("/{discovery_id}", response_model=Discovery, responses=error_responses(404, 422), summary="One candidate with searches and evidence")
def get_discovery(discovery_id: UUID, ctx: Ctx) -> Discovery:
    with ctx.db.connection() as conn:
        document = _load(conn, discovery_id)
    if document is None:
        raise not_found("discovery candidate", discovery_id)
    return document


@router.patch("/{discovery_id}", response_model=Discovery, responses=error_responses(404, 422), summary="Change the title or notes")
def patch_discovery(discovery_id: UUID, request: DiscoveryPatch, ctx: Ctx) -> Discovery:
    """The structure of a candidate cannot be changed: its searches and evidence refer to it. Create a new candidate instead."""
    changes = request.model_dump(exclude_unset=True)
    if "title" in changes and changes["title"] is None:
        raise ApiError(422, "validation_error", "`title` cannot be set to null.", [{"location": ["body", "title"], "message": "must not be null", "type": "null_not_allowed"}])
    with ctx.db.connection() as conn:
        _require(conn, discovery_id)
        if changes:
            assignments = ", ".join(f"{column} = %s" for column in changes)
            values = [value.strip() if column == "title" else value for column, value in changes.items()]
            conn.execute(f"UPDATE discoveries SET {assignments} WHERE id = %s", [*values, discovery_id])
        document = _load(conn, discovery_id)
    assert document is not None
    return document


@router.delete("/{discovery_id}", status_code=204, responses=error_responses(404, 422), summary="Delete a candidate with its searches and evidence")
def delete_discovery(discovery_id: UUID, ctx: Ctx) -> Response:
    if ctx.db.execute("DELETE FROM discoveries WHERE id = %s", (discovery_id,)) == 0:
        raise not_found("discovery candidate", discovery_id)
    return Response(status_code=204)


@router.post(
    "/{discovery_id}/searches",
    response_model=Discovery,
    responses=error_responses(404, 409, 422),
    summary="Search the catalogues again",
)
def search_again(discovery_id: UUID, request: SearchRequest, ctx: Ctx) -> Discovery:
    """Repeats the local searches (the catalogue may have changed) and optionally the PubChem
    lookup. The new searches are added to the trail; the status follows what they find: an
    identical structure in any searched catalogue returns the candidate to `structurally-validated`."""
    with ctx.db.connection() as conn:
        row = _require(conn, discovery_id)
    if not row["structure_valid"] or row["inchikey"] is None:
        raise ApiError(409, "structure_not_valid", "This candidate has no valid structure, so there is nothing to search for.", {"status": row["status"]})
    parsed = parse_structure(row["input_format"], row["input_structure"])
    if not parsed.valid:
        raise ApiError(409, "structure_not_valid", f"RDKit no longer accepts the stored structure: {parsed.error_summary()}", {"status": row["status"]})
    records = _searches(ctx, parsed, row["inchikey"], request)
    with ctx.db.connection() as conn:
        _require(conn, discovery_id)
        discovery.store_searches(conn, discovery_id, records)
        discovery.apply_search_outcome(conn, discovery_id)
        document = _load(conn, discovery_id)
    assert document is not None
    return document


@router.post(
    "/{discovery_id}/evidence",
    response_model=Discovery,
    status_code=201,
    responses=error_responses(404, 422),
    summary="Attach evidence",
)
def attach_evidence(discovery_id: UUID, request: EvidenceCreate, ctx: Ctx) -> Discovery:
    """Adds a record to the evidence trail: a calculation (an existing job), an experimental
    observation, an independent validation or a note. Observations and validations are recorded
    as asserted by the user; the service does not verify them. Attaching evidence never changes
    the status by itself; request a status change explicitly."""
    with ctx.db.connection() as conn:
        row = _require(conn, discovery_id)
        if request.kind == "calculation":
            assert request.calculation_id is not None
            summary, details = discovery.calculation_evidence(conn, row, request.calculation_id)
            if request.summary:
                summary = f"{request.summary} [{summary}]"
            discovery.add_evidence(
                conn,
                discovery_id,
                kind="calculation",
                summary=summary,
                recorded_by="service",
                details={**request.details, **details},
                calculation_id=request.calculation_id,
                reference=request.reference,
            )
        else:
            assert request.summary is not None
            discovery.add_evidence(
                conn,
                discovery_id,
                kind=request.kind,
                summary=request.summary,
                recorded_by="user",
                details={**request.details, "verified_by_service": False},
                reference=request.reference,
            )
        conn.execute("UPDATE discoveries SET updated_at = now() WHERE id = %s", (discovery_id,))
        document = _load(conn, discovery_id)
    assert document is not None
    return document


@router.post(
    "/{discovery_id}/status",
    response_model=Discovery,
    responses=error_responses(404, 409, 422),
    summary="Move a candidate on the status ladder",
)
def change_status(discovery_id: UUID, request: StatusChange, ctx: Ctx) -> Discovery:
    """The ladder is climbed one rung at a time and each rung needs its evidence:
    `computationally-plausible` needs an attached calculation that succeeded, converged and was run
    on the candidate's structure (and no identical structure in the searched catalogues);
    `experimentally-observed` and `independently-validated` need the matching evidence record with
    a reference. `structurally-validated` and `no-match-in-searched-catalogs` are set only by the
    service. A status can be lowered, but not below what validation and the searches established.
    A refused transition answers 409 and says what is missing."""
    with ctx.db.connection() as conn:
        _require(conn, discovery_id)
        discovery.change_status(conn, discovery_id, request.status, request.justification.strip())
        document = _load(conn, discovery_id)
    assert document is not None
    return document
