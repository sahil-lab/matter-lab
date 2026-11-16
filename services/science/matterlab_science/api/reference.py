"""Reference data: sources, elements, isotopes, functional groups, solvents and catalysts."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Generic, Literal, TypeVar
from uuid import UUID

from fastapi import APIRouter, Path, Query
from pydantic import BaseModel, Field

from ..chem.functional_groups import SET_INFO
from ..errors import error_responses, not_found
from ..provenance import PROVENANCE_COLUMNS, Citation, EvidenceLevel, Provenance, SourceKind, evidence_for, provenance_from_row
from .common import Ctx, EngineStamp

router = APIRouter(prefix="/v1", tags=["reference data"])

T = TypeVar("T")

RECORD_EVIDENCE = (
    "How the record was obtained, from the kind of its source: `reference` for a published dataset or service, "
    "`user-input` for a record that was typed in or imported from a workbook (not verified by the service)."
)


class SourcedPage(BaseModel, Generic[T]):
    """One page of records. Each item names its source in `source`; `sources` holds the full
    provenance of every source referenced on this page, keyed by that name."""

    items: list[T]
    total: int
    limit: int
    offset: int
    sources: dict[str, Provenance]


def source_ref(row: dict[str, Any]) -> str:
    return f"{row['ds_key']}@{row['ds_version']}"


def collect_sources(rows: list[dict[str, Any]]) -> dict[str, Provenance]:
    sources: dict[str, Provenance] = {}
    for row in rows:
        ref = source_ref(row)
        if ref not in sources:
            sources[ref] = provenance_from_row(row)
    return sources


# ---------------------------------------------------------------------------------------------
# Data sources
# ---------------------------------------------------------------------------------------------


class DataSource(BaseModel):
    id: int
    key: str
    version: str
    kind: SourceKind
    title: str
    publisher: str | None
    url: str | None
    license: str | None
    retrieved_on: date | None
    citations: list[Citation]
    notes: str | None
    created_at: datetime


class DataSourcesResponse(BaseModel):
    items: list[DataSource]
    total: int


@router.get("/data-sources", response_model=DataSourcesResponse, summary="Registered data sources (the provenance registry)")
def data_sources(ctx: Ctx) -> DataSourcesResponse:
    rows = ctx.db.fetch_all(
        "SELECT id, key, version, kind, title, publisher, url, license, retrieved_on, citations, notes, created_at FROM data_sources ORDER BY key, version"
    )
    return DataSourcesResponse(items=[DataSource(**row) for row in rows], total=len(rows))


# ---------------------------------------------------------------------------------------------
# Elements
# ---------------------------------------------------------------------------------------------

_ELEMENT_COLUMNS = (
    "e.atomic_number, e.symbol, e.name, e.standard_atomic_weight_u, e.period, e.group_number, e.block, e.table_row, e.table_column, "
    "e.category, e.standard_state, e.standard_state_predicted, e.electron_configuration, e.electron_configuration_predicted, "
    "e.electronegativity_pauling, e.ionization_energy_ev, e.electron_affinity_ev, e.oxidation_states, e.melting_point_k, e.boiling_point_k, "
    "e.density_g_per_cm3, e.year_discovered, e.discovered_in_antiquity, e.covalent_radius_angstrom, e.vdw_radius_angstrom, e.vdw_radius_source, "
    "e.cpk_color_hex, e.color_source, e.valences, e.valence_unconstrained, e.outer_electrons, e.most_common_isotope_mass_number, "
    "e.most_common_isotope_mass_u"
)


class Element(BaseModel):
    atomic_number: int
    symbol: str
    name: str
    standard_atomic_weight_u: float = Field(description="Standard atomic weight in u.")
    period: int
    group_number: int | None = Field(description="IUPAC group 1-18; null for the lanthanide and actinide series.")
    block: Literal["s", "p", "d", "f"]
    table_row: int
    table_column: int
    category: str
    standard_state: Literal["solid", "liquid", "gas"]
    standard_state_predicted: bool
    electron_configuration: str
    electron_configuration_predicted: bool
    electronegativity_pauling: float | None
    ionization_energy_ev: float | None = Field(description="First ionisation energy in eV.")
    electron_affinity_ev: float | None = Field(description="Electron affinity in eV.")
    oxidation_states: list[int]
    melting_point_k: float | None = Field(description="Melting point in K.")
    boiling_point_k: float | None = Field(description="Boiling point in K.")
    density_g_per_cm3: float | None = Field(description="Density in g/cm^3 as listed by the source.")
    year_discovered: int | None
    discovered_in_antiquity: bool
    covalent_radius_angstrom: float
    vdw_radius_angstrom: float
    vdw_radius_source: Literal["pubchem", "rdkit", "import"]
    cpk_color_hex: str
    color_source: Literal["pubchem", "jmol", "fallback", "import"] = Field(
        description="`fallback` marks elements that have no conventional colour; `import` marks a value changed by a workbook import."
    )
    valences: list[int]
    valence_unconstrained: bool
    outer_electrons: int
    most_common_isotope_mass_number: int
    most_common_isotope_mass_u: float
    evidence: EvidenceLevel = Field(description=RECORD_EVIDENCE)
    source: str = Field(description="Primary source, as a key of the page's `sources` map.")


class FieldProvenance(BaseModel):
    fields: list[str] = Field(description="Columns of the element record that were taken from this source.")
    provenance: Provenance


class ElementDetail(Element):
    provenance: Provenance = Field(description="Primary source of the record.")
    field_provenance: list[FieldProvenance] = Field(description="Which fields came from which source.")
    note: str


def _element(row: dict[str, Any]) -> dict[str, Any]:
    data = {key: value for key, value in row.items() if not key.startswith("ds_")}
    return {**data, "evidence": evidence_for(row["ds_kind"]), "source": source_ref(row)}


@router.get("/elements", response_model=SourcedPage[Element], summary="All chemical elements")
def elements(ctx: Ctx) -> SourcedPage[Element]:
    rows = ctx.db.fetch_all(
        f"SELECT {_ELEMENT_COLUMNS}, {PROVENANCE_COLUMNS} FROM elements e JOIN data_sources ds ON ds.id = e.source_id ORDER BY e.atomic_number"
    )
    return SourcedPage[Element](items=[Element(**_element(r)) for r in rows], total=len(rows), limit=len(rows), offset=0, sources=collect_sources(rows))


@router.get(
    "/elements/{element}",
    response_model=ElementDetail,
    responses=error_responses(404, 422),
    summary="One element with field-level provenance",
)
def element(
    ctx: Ctx,
    element: str = Path(pattern=r"^([A-Za-z]{1,3}|[0-9]{1,3})$", description="Atomic number (1-118) or element symbol (case-insensitive)."),
) -> ElementDetail:
    """`element` is an atomic number (1-118) or an element symbol (case-insensitive)."""
    key = element.strip()
    with ctx.db.connection() as conn:
        if key.isdigit():
            row = conn.execute(
                f"SELECT {_ELEMENT_COLUMNS}, {PROVENANCE_COLUMNS} FROM elements e JOIN data_sources ds ON ds.id = e.source_id WHERE e.atomic_number = %s",
                (int(key),),
            ).fetchone()
        else:
            row = conn.execute(
                f"SELECT {_ELEMENT_COLUMNS}, {PROVENANCE_COLUMNS} FROM elements e JOIN data_sources ds ON ds.id = e.source_id WHERE lower(e.symbol) = lower(%s)",
                (key,),
            ).fetchone()
        if row is None:
            raise not_found("element", element)
        fields = conn.execute(
            f"SELECT es.fields, {PROVENANCE_COLUMNS} FROM element_sources es JOIN data_sources ds ON ds.id = es.source_id "
            "WHERE es.atomic_number = %s ORDER BY ds.key",
            (row["atomic_number"],),
        ).fetchall()
    return ElementDetail(
        **_element(row),
        provenance=provenance_from_row(row),
        field_provenance=[FieldProvenance(fields=f["fields"], provenance=provenance_from_row(f)) for f in fields],
        note="period, group_number, block, table_row and table_column follow from the atomic number and are not attributed to a source.",
    )


# ---------------------------------------------------------------------------------------------
# Isotopes
# ---------------------------------------------------------------------------------------------


class Isotope(BaseModel):
    atomic_number: int
    symbol: str
    neutron_number: int
    mass_number: int
    atomic_mass_u: float | None = Field(description="Atomic mass in u; null when not evaluated.")
    mass_from_systematics: bool = Field(description="True when the mass is an estimate from systematics rather than a measurement.")
    natural_abundance_percent: float | None = Field(description="Natural abundance in percent; null when the nuclide does not occur naturally.")
    stability: Literal["S", "R", "U"] = Field(description="S = stable, R = radioactive with an evaluated half-life, U = half-life not evaluated.")
    half_life_seconds: float | None
    half_life_limit: Literal["", "GT", "LT", "GE", "LE", "AP"] = Field(description="Qualifier on the half-life: a bound or an approximate value; empty when exact.")
    decay_mode: str | None = Field(description="Most probable decay mode in ENSDF notation.")
    decay_percent: float | None
    spin_parity: str | None
    evidence: EvidenceLevel = Field(description=RECORD_EVIDENCE)
    source: str


@router.get("/isotopes", response_model=SourcedPage[Isotope], responses=error_responses(422), summary="Evaluated ground-state nuclides")
def isotopes(
    ctx: Ctx,
    atomic_number: int | None = Query(default=None, ge=1, le=118, description="Only nuclides of this element."),
    symbol: str | None = Query(default=None, max_length=3, description="Only nuclides of the element with this symbol."),
    mass_number: int | None = Query(default=None, ge=1, description="Only nuclides with this mass number A."),
    stability: Literal["S", "R", "U"] | None = Query(default=None),
    limit: int = Query(default=500, ge=1, le=5000),
    offset: int = Query(default=0, ge=0),
) -> SourcedPage[Isotope]:
    clauses: list[str] = []
    params: list[Any] = []
    for clause, value in (
        ("i.atomic_number = %s", atomic_number),
        ("lower(e.symbol) = lower(%s)", symbol),
        ("i.mass_number = %s", mass_number),
        ("i.stability = %s", stability),
    ):
        if value is not None:
            clauses.append(clause)
            params.append(value)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    with ctx.db.connection() as conn:
        total = conn.execute(f"SELECT count(*) AS n FROM isotopes i JOIN elements e ON e.atomic_number = i.atomic_number {where}", params).fetchone()
        rows = conn.execute(
            f"""
            SELECT i.atomic_number, e.symbol, i.neutron_number, i.mass_number, i.atomic_mass_u, i.mass_from_systematics,
                   i.natural_abundance_percent, i.stability, i.half_life_seconds, i.half_life_limit, i.decay_mode, i.decay_percent,
                   i.spin_parity, {PROVENANCE_COLUMNS}
            FROM isotopes i JOIN elements e ON e.atomic_number = i.atomic_number JOIN data_sources ds ON ds.id = i.source_id
            {where} ORDER BY i.atomic_number, i.neutron_number LIMIT %s OFFSET %s
            """,
            [*params, limit, offset],
        ).fetchall()
    items = [Isotope(**{k: v for k, v in r.items() if not k.startswith("ds_")}, evidence=evidence_for(r["ds_kind"]), source=source_ref(r)) for r in rows]
    return SourcedPage[Isotope](items=items, total=int(total["n"]) if total else 0, limit=limit, offset=offset, sources=collect_sources(rows))


# ---------------------------------------------------------------------------------------------
# Functional groups
# ---------------------------------------------------------------------------------------------


class FunctionalGroup(BaseModel):
    id: int
    group_set: str
    key: str
    name: str
    smarts: str
    description: str | None
    parent_key: str | None
    source_file: str | None
    evidence: EvidenceLevel = Field(
        description="`rule-based`: a pattern definition shipped with RDKit. `user-input`: a definition that was imported from a workbook."
    )
    source: str


class FunctionalGroupSet(BaseModel):
    group_set: str
    title: str | None
    definition_count: int
    source_file: str | None
    first_atom_is_attachment_point: bool = Field(description="True for substituent patterns whose first SMARTS atom is the attachment point, not part of the group.")


class FunctionalGroupSetsResponse(BaseModel):
    sets: list[FunctionalGroupSet]


@router.get("/functional-groups/sets", response_model=FunctionalGroupSetsResponse, summary="Functional-group definition sets")
def functional_group_sets(ctx: Ctx) -> FunctionalGroupSetsResponse:
    rows = ctx.db.fetch_all("SELECT group_set, count(*) AS n, min(source_file) AS source_file FROM functional_groups GROUP BY group_set ORDER BY group_set")
    return FunctionalGroupSetsResponse(
        sets=[
            FunctionalGroupSet(
                group_set=r["group_set"],
                title=SET_INFO.get(r["group_set"], {}).get("title"),
                definition_count=r["n"],
                source_file=r["source_file"],
                first_atom_is_attachment_point=bool(SET_INFO.get(r["group_set"], {}).get("first_atom_is_attachment_point", False)),
            )
            for r in rows
        ]
    )


@router.get("/functional-groups", response_model=SourcedPage[FunctionalGroup], responses=error_responses(422), summary="Functional-group definitions (SMARTS)")
def functional_groups(
    ctx: Ctx,
    group_set: str | None = Query(default=None, description="Only definitions of this set."),
    limit: int = Query(default=500, ge=1, le=2000),
    offset: int = Query(default=0, ge=0),
) -> SourcedPage[FunctionalGroup]:
    where, params = ("WHERE fg.group_set = %s", [group_set]) if group_set is not None else ("", [])
    with ctx.db.connection() as conn:
        total = conn.execute(f"SELECT count(*) AS n FROM functional_groups fg {where}", params).fetchone()
        rows = conn.execute(
            f"""
            SELECT fg.id, fg.group_set, fg.key, fg.name, fg.smarts, fg.description, fg.parent_key, fg.source_file, {PROVENANCE_COLUMNS}
            FROM functional_groups fg JOIN data_sources ds ON ds.id = fg.source_id
            {where} ORDER BY fg.group_set, fg.position, fg.id LIMIT %s OFFSET %s
            """,
            [*params, limit, offset],
        ).fetchall()
    items = [
        FunctionalGroup(**{k: v for k, v in r.items() if not k.startswith("ds_")}, evidence=evidence_for(r["ds_kind"], software="rule-based"), source=source_ref(r))
        for r in rows
    ]
    return SourcedPage[FunctionalGroup](items=items, total=int(total["n"]) if total else 0, limit=limit, offset=offset, sources=collect_sources(rows))


# ---------------------------------------------------------------------------------------------
# Solvents and catalysts
# ---------------------------------------------------------------------------------------------


class SourcedProperty(BaseModel):
    name: str
    value: float | str
    unit: str | None
    evidence: EvidenceLevel
    source: str = Field(description="Where the value was retrieved from.")
    source_key: str | None = None
    retrieved: date | None = None


class RoleCompound(BaseModel):
    """A solvent or a catalyst: name, identifiers and structure. Properties appear only when they
    were actually retrieved from a cited source."""

    id: UUID
    name: str
    compound_id: UUID | None = Field(description="The catalogue compound with the same InChIKey, when one exists.")
    canonical_smiles: str | None
    inchi: str | None
    inchikey: str | None
    molecular_formula: str | None
    structure_status: Literal["rdkit-validated", "source-only", "none"] = Field(
        description="`rdkit-validated`: identifiers computed by RDKit. `source-only`: RDKit could not validate the structure. `none`: no structure."
    )
    structure_notes: str | None
    external_ids: dict[str, Any]
    properties: list[SourcedProperty]
    source_url: str | None
    evidence: EvidenceLevel = Field(description=RECORD_EVIDENCE + " Identifiers and formula are computed from the structure by RDKit when `structure_status` is `rdkit-validated`.")
    source: str


class RoleCompoundDetail(RoleCompound):
    molblock: str | None = Field(description="2D depiction molfile generated by RDKit (not a 3D geometry).")
    derived_by: EngineStamp | None
    provenance: Provenance
    created_at: datetime
    updated_at: datetime


_ROLE_COLUMNS = (
    "r.id, r.name, r.compound_id, r.canonical_smiles, r.inchi, r.inchikey, r.molecular_formula, r.structure_status, r.structure_notes, "
    "r.external_ids, r.properties, r.source_url"
)


def _role_list(ctx: Any, table: str, limit: int, offset: int) -> SourcedPage[RoleCompound]:
    with ctx.db.connection() as conn:
        total = conn.execute(f"SELECT count(*) AS n FROM {table}").fetchone()
        rows = conn.execute(
            f"SELECT {_ROLE_COLUMNS}, {PROVENANCE_COLUMNS} FROM {table} r JOIN data_sources ds ON ds.id = r.source_id "
            "ORDER BY lower(r.name) LIMIT %s OFFSET %s",
            (limit, offset),
        ).fetchall()
    items = [RoleCompound(**{k: v for k, v in r.items() if not k.startswith("ds_")}, evidence=evidence_for(r["ds_kind"]), source=source_ref(r)) for r in rows]
    return SourcedPage[RoleCompound](items=items, total=int(total["n"]) if total else 0, limit=limit, offset=offset, sources=collect_sources(rows))


def _role_detail(ctx: Any, table: str, what: str, record_id: UUID) -> RoleCompoundDetail:
    row = ctx.db.fetch_one(
        f"SELECT {_ROLE_COLUMNS}, r.molblock, r.derived_by, r.created_at, r.updated_at, {PROVENANCE_COLUMNS} "
        f"FROM {table} r JOIN data_sources ds ON ds.id = r.source_id WHERE r.id = %s",
        (record_id,),
    )
    if row is None:
        raise not_found(what, record_id)
    data = {k: v for k, v in row.items() if not k.startswith("ds_")}
    data["derived_by"] = EngineStamp(**data["derived_by"]) if data["derived_by"] else None
    return RoleCompoundDetail(**data, evidence=evidence_for(row["ds_kind"]), source=source_ref(row), provenance=provenance_from_row(row))


@router.get("/solvents", response_model=SourcedPage[RoleCompound], responses=error_responses(422), summary="Common solvents")
def solvents(ctx: Ctx, limit: int = Query(default=200, ge=1, le=1000), offset: int = Query(default=0, ge=0)) -> SourcedPage[RoleCompound]:
    return _role_list(ctx, "solvents", limit, offset)


@router.get("/solvents/{solvent_id}", response_model=RoleCompoundDetail, responses=error_responses(404, 422), summary="One solvent")
def solvent(solvent_id: UUID, ctx: Ctx) -> RoleCompoundDetail:
    return _role_detail(ctx, "solvents", "solvent", solvent_id)


@router.get("/catalysts", response_model=SourcedPage[RoleCompound], responses=error_responses(422), summary="Common catalysts")
def catalysts(ctx: Ctx, limit: int = Query(default=200, ge=1, le=1000), offset: int = Query(default=0, ge=0)) -> SourcedPage[RoleCompound]:
    return _role_list(ctx, "catalysts", limit, offset)


@router.get("/catalysts/{catalyst_id}", response_model=RoleCompoundDetail, responses=error_responses(404, 422), summary="One catalyst")
def catalyst(catalyst_id: UUID, ctx: Ctx) -> RoleCompoundDetail:
    return _role_detail(ctx, "catalysts", "catalyst", catalyst_id)
