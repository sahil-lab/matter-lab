"""HTTP surface for the titration engine (Agent 06), for Agent 07's apparatus reducer and Agent 09's
lab API to call. Thin, typed adapters over the pure functions in `titration/*`: every endpoint here
is synchronous, needs no database and does no I/O of its own (unlike the rest of this service's
routers, none of these need `Ctx`/PostgreSQL -- see `main.py`, where this router is grouped with
`chem.router` for that reason).

A syntactically valid request always answers 200 with a body whose `status` field is `SUCCEEDED`,
`UNSUPPORTED` or `FAILED` (mirroring `00_SHARED_INTEGRATION_CONTRACT.md`'s `RunResult.status`):
this is not "HTTP 200 with a fake value" (which the shared contract forbids) because the body
always says, explicitly, whether the number is usable. A request that cannot even be classified
(an unresolvable titration setup, e.g. an unknown species id for the curve endpoints) is a 422
with the service's standard `{"error": {"code","message","details"}}` shape.
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field

from titration import species as species_registry
from titration.indicators import INDICATORS, fraction_basic_form, indicator_color, indicator_state_label, lookup_indicator
from titration.provenance import Citation, EvidenceLevel, Provenance
from titration.solver import solve_equilibrium
from titration.titration_curve import TitrationSetup, compare_endpoint_to_equivalence, equivalence_volume_l, half_equivalence_volume_l, titration_curve
from titration.types import MONOPROTIC_ELECTRONEUTRALITY_MODEL_ID, SolveAssumptions, SolveResult, SpeciesAmountInput

from ..errors import ApiError

router = APIRouter(prefix="/v1/titration", tags=["titration"])


# ---------------------------------------------------------------------------------------------
# Shared response fragments (provenance, citations)
# ---------------------------------------------------------------------------------------------


class CitationOut(BaseModel):
    title: str
    authors: str | None = None
    source: str | None = None
    year: int | None = None
    doi: str | None = None
    url: str | None = None


class ProvenanceOut(BaseModel):
    source: str
    evidence: EvidenceLevel
    citations: list[CitationOut] = Field(default_factory=list)
    retrieved: str | None = None
    notes: str | None = None


def _citation_out(c: Citation) -> CitationOut:
    return CitationOut(title=c.title, authors=c.authors, source=c.source, year=c.year, doi=c.doi, url=c.url)


def _provenance_out(p: Provenance | None) -> ProvenanceOut | None:
    if p is None:
        return None
    return ProvenanceOut(source=p.source, evidence=p.evidence, citations=[_citation_out(c) for c in p.citations], retrieved=p.retrieved, notes=p.notes)


# ---------------------------------------------------------------------------------------------
# POST /v1/titration/solve
# ---------------------------------------------------------------------------------------------


class SpeciesAmountIn(BaseModel):
    model_config = ConfigDict(json_schema_extra={"examples": [{"species_id": "hydrochloric-acid", "moles": 0.0025}]})

    species_id: str = Field(description="Key into the species registry (GET /v1/titration/species lists every supported and explicitly-unsupported id).")
    moles: float = Field(ge=0, description="Total moles of this species present (conserved inventory; see 00_SHARED_INTEGRATION_CONTRACT.md Section 4).")
    source_id: str | None = Field(default=None, description="Opaque identifier of the apparatus/transfer this amount came from, echoed back nowhere but kept for the caller's own bookkeeping.")


class SolveAssumptionsIn(BaseModel):
    mixing: Literal["WELL_MIXED", "UNMIXED"] = "WELL_MIXED"
    activity_model: Literal["ideal"] = "ideal"


class SolveRequest(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "examples": [
                {
                    "species": [{"species_id": "hydrochloric-acid", "moles": 0.0025}, {"species_id": "sodium-hydroxide", "moles": 0.0025}],
                    "volume_l": 0.05,
                    "temperature_k": 298.15,
                }
            ]
        }
    )

    species: list[SpeciesAmountIn] = Field(default_factory=list)
    volume_l: float = Field(description="Total solution volume in litres.")
    temperature_k: float = Field(default=298.15, description="Kelvin.")
    model_id: str = Field(default=MONOPROTIC_ELECTRONEUTRALITY_MODEL_ID, description="Must name a model this solver implements; anything else answers UNSUPPORTED.")
    assumptions: SolveAssumptionsIn = Field(default_factory=SolveAssumptionsIn)


class EquilibriumConcentrationOut(BaseModel):
    species_id: str
    form: str
    molar: float
    evidence: EvidenceLevel


class SolveDiagnosticsOut(BaseModel):
    charge_balance_residual_molar: float | None
    mass_balance_residuals_molar: dict[str, float]
    ionic_strength_molar: float | None
    root_finder_method: str
    root_finder_iterations: int | None
    root_finder_function_calls: int | None
    root_finder_bracket_ph: list[float] | None
    input_hash: str | None


class ReferenceQuantitiesOut(BaseModel):
    total_volume_l: float
    temperature_k: float
    initial_analytical_concentrations_molar: dict[str, float]
    kw: float
    pkw: float


class NumericalUncertaintyOut(BaseModel):
    ph_numerical_tolerance: float
    basis: str
    limitations: list[str]


class SolveResponse(BaseModel):
    status: Literal["SUCCEEDED", "UNSUPPORTED", "FAILED"]
    model_id: str
    method_version: str
    pH: float | None
    pOH: float | None
    hydrogen_ion_molar: float | None
    hydroxide_ion_molar: float | None
    equilibrium_concentrations: list[EquilibriumConcentrationOut]
    reference_quantities: ReferenceQuantitiesOut | None
    numerical_uncertainty: NumericalUncertaintyOut | None
    evidence: EvidenceLevel
    reason: str | None
    warnings: list[str]
    assumptions: list[str]
    diagnostics: SolveDiagnosticsOut


def _solve_response(result: SolveResult) -> SolveResponse:
    diag = result.diagnostics
    return SolveResponse(
        status=result.status,
        model_id=result.model_id,
        method_version=result.method_version,
        pH=result.pH,
        pOH=result.pOH,
        hydrogen_ion_molar=result.hydrogen_ion_molar,
        hydroxide_ion_molar=result.hydroxide_ion_molar,
        equilibrium_concentrations=[EquilibriumConcentrationOut(species_id=c.species_id, form=c.form, molar=c.molar, evidence=c.evidence) for c in result.equilibrium_concentrations],
        reference_quantities=(
            ReferenceQuantitiesOut(
                total_volume_l=result.reference_quantities.total_volume_l,
                temperature_k=result.reference_quantities.temperature_k,
                initial_analytical_concentrations_molar=dict(result.reference_quantities.initial_analytical_concentrations_molar),
                kw=result.reference_quantities.kw,
                pkw=result.reference_quantities.pkw,
            )
            if result.reference_quantities
            else None
        ),
        numerical_uncertainty=(
            NumericalUncertaintyOut(
                ph_numerical_tolerance=result.numerical_uncertainty.ph_numerical_tolerance,
                basis=result.numerical_uncertainty.basis,
                limitations=list(result.numerical_uncertainty.limitations),
            )
            if result.numerical_uncertainty
            else None
        ),
        evidence=result.evidence,
        reason=result.reason,
        warnings=list(result.warnings),
        assumptions=list(result.assumptions),
        diagnostics=SolveDiagnosticsOut(
            charge_balance_residual_molar=diag.charge_balance_residual_molar,
            mass_balance_residuals_molar=dict(diag.mass_balance_residuals_molar),
            ionic_strength_molar=diag.ionic_strength_molar,
            root_finder_method=diag.root_finder_method,
            root_finder_iterations=diag.root_finder_iterations,
            root_finder_function_calls=diag.root_finder_function_calls,
            root_finder_bracket_ph=list(diag.root_finder_bracket_ph) if diag.root_finder_bracket_ph else None,
            input_hash=diag.input_hash,
        ),
    )


@router.post("/solve", response_model=SolveResponse, summary="Solve one acid/base equilibrium snapshot")
def solve(request: SolveRequest) -> SolveResponse:
    """Pure calculation (see `titration/solver.py`): a validated species composition, volume and
    temperature in, an explicit `SUCCEEDED`/`UNSUPPORTED`/`FAILED` result out. Deterministic:
    identical requests (`diagnostics.input_hash` equal) always produce an identical response."""
    result = solve_equilibrium(
        species=[SpeciesAmountInput(s.species_id, s.moles, s.source_id) for s in request.species],
        volume_l=request.volume_l,
        temperature_k=request.temperature_k,
        model_id=request.model_id,
        assumptions=SolveAssumptions(mixing=request.assumptions.mixing, activity_model=request.assumptions.activity_model),
    )
    return _solve_response(result)


# ---------------------------------------------------------------------------------------------
# POST /v1/titration/curve
# ---------------------------------------------------------------------------------------------


class TitrationSetupIn(BaseModel):
    model_config = ConfigDict(
        json_schema_extra={
            "examples": [
                {
                    "analyte_species_id": "hydrochloric-acid",
                    "analyte_concentration_molar": 0.100,
                    "analyte_volume_l": 0.02500,
                    "titrant_species_id": "sodium-hydroxide",
                    "titrant_concentration_molar": 0.100,
                    "temperature_k": 298.15,
                }
            ]
        }
    )

    analyte_species_id: str
    analyte_concentration_molar: float = Field(gt=0)
    analyte_volume_l: float = Field(gt=0)
    titrant_species_id: str
    titrant_concentration_molar: float = Field(gt=0)
    temperature_k: float = 298.15


def _build_setup(setup_in: TitrationSetupIn) -> TitrationSetup:
    try:
        return TitrationSetup(
            analyte_species_id=setup_in.analyte_species_id,
            analyte_concentration_molar=setup_in.analyte_concentration_molar,
            analyte_volume_l=setup_in.analyte_volume_l,
            titrant_species_id=setup_in.titrant_species_id,
            titrant_concentration_molar=setup_in.titrant_concentration_molar,
            temperature_k=setup_in.temperature_k,
        )
    except ValueError as exc:
        raise ApiError(422, "unresolved_titration_species", str(exc)) from exc


class TitrationCurveRequest(BaseModel):
    setup: TitrationSetupIn
    delivered_volumes_l: list[float] | None = Field(default=None, description="Explicit delivered volumes to solve at, in litres. If omitted, an evenly spaced grid from 0 to 1.5x the stoichiometric equivalence volume is used.")
    num_points: int = Field(default=61, ge=2, le=2000, description="Number of points of the auto-generated grid; ignored if delivered_volumes_l is given.")


class TitrationPointOut(BaseModel):
    delivered_volume_l: float
    total_volume_l: float
    pH: float | None
    status: Literal["SUCCEEDED", "UNSUPPORTED", "FAILED"]
    reason: str | None


class TitrationCurveResponse(BaseModel):
    equivalence_volume_l: float
    half_equivalence_volume_l: float
    points: list[TitrationPointOut]


@router.post("/curve", response_model=TitrationCurveResponse, summary="Solve a pH-vs-delivered-volume titration curve")
def curve(request: TitrationCurveRequest) -> TitrationCurveResponse:
    """Every point is an independent call to the equilibrium solver (`titration/titration_curve.py`):
    no interpolation or precomputed shape. `422 unresolved_titration_species` if either species id
    does not resolve."""
    setup = _build_setup(request.setup)
    if request.delivered_volumes_l is not None:
        volumes = request.delivered_volumes_l
    else:
        equivalence = equivalence_volume_l(setup)
        span = equivalence * 1.5
        volumes = [span * i / (request.num_points - 1) for i in range(request.num_points)]
    points = titration_curve(setup, volumes)
    return TitrationCurveResponse(
        equivalence_volume_l=equivalence_volume_l(setup),
        half_equivalence_volume_l=half_equivalence_volume_l(setup),
        points=[TitrationPointOut(delivered_volume_l=p.delivered_volume_l, total_volume_l=p.total_volume_l, pH=p.pH, status=p.result.status, reason=p.result.reason) for p in points],
    )


# ---------------------------------------------------------------------------------------------
# GET /v1/titration/species
# ---------------------------------------------------------------------------------------------


class SpeciesInfoOut(BaseModel):
    species_id: str
    name: str
    formula: str
    role: str
    charge_as_dosed: int
    pKa_298_15k: float | None
    system_id: str | None
    unsupported_reason: str | None
    provenance: ProvenanceOut | None


@router.get("/species", response_model=list[SpeciesInfoOut], summary="List every species the solver recognises, supported or not")
def species() -> list[SpeciesInfoOut]:
    return [
        SpeciesInfoOut(
            species_id=s.species_id,
            name=s.name,
            formula=s.formula,
            role=s.role,
            charge_as_dosed=s.charge_as_dosed,
            pKa_298_15k=s.pKa_298_15k,
            system_id=s.system_id,
            unsupported_reason=s.unsupported_reason,
            provenance=_provenance_out(s.provenance),
        )
        for s in species_registry.all_species()
    ]


# ---------------------------------------------------------------------------------------------
# GET /v1/titration/indicators, POST /v1/titration/indicators/{id}/state
# ---------------------------------------------------------------------------------------------


class IndicatorOut(BaseModel):
    indicator_id: str
    name: str
    pKin: float
    acid_color_name: str
    acid_color_hex: str
    base_color_name: str
    base_color_hex: str
    visual_range: list[float]
    provenance: ProvenanceOut | None


def _indicator_out(i: Any) -> IndicatorOut:
    return IndicatorOut(
        indicator_id=i.indicator_id,
        name=i.name,
        pKin=i.pKin,
        acid_color_name=i.acid_color_name,
        acid_color_hex=i.acid_color.as_hex(),
        base_color_name=i.base_color_name,
        base_color_hex=i.base_color.as_hex(),
        visual_range=list(i.visual_range),
        provenance=_provenance_out(i.provenance),
    )


@router.get("/indicators", response_model=list[IndicatorOut], summary="List the shipped acid/base indicators")
def indicators() -> list[IndicatorOut]:
    return [_indicator_out(i) for i in INDICATORS]


class IndicatorStateOut(BaseModel):
    indicator_id: str
    pH: float
    fraction_base_form: float
    color_hex: str
    state_label: str


@router.get("/indicators/{indicator_id}/state", response_model=IndicatorStateOut, summary="Indicator colour/state at a given pH")
def indicator_state(indicator_id: str, pH: float) -> IndicatorStateOut:
    indicator = lookup_indicator(indicator_id)
    if indicator is None:
        raise ApiError(404, "not_found", f"Indicator {indicator_id!r} does not exist.", {"resource": "indicator", "id": indicator_id})
    return IndicatorStateOut(
        indicator_id=indicator_id,
        pH=pH,
        fraction_base_form=fraction_basic_form(indicator, pH),
        color_hex=indicator_color(indicator, pH).as_hex(),
        state_label=indicator_state_label(indicator, pH),
    )


# ---------------------------------------------------------------------------------------------
# POST /v1/titration/endpoint-comparison
# ---------------------------------------------------------------------------------------------


class EndpointComparisonRequest(BaseModel):
    setup: TitrationSetupIn
    indicator_id: str


class EndpointComparisonResponse(BaseModel):
    equivalence_volume_l: float
    indicator_endpoint_volume_l: float | None
    difference_l: float | None
    explanation: str


@router.post("/endpoint-comparison", response_model=EndpointComparisonResponse, summary="Compare an indicator's colour-change volume to the stoichiometric equivalence volume")
def endpoint_comparison(request: EndpointComparisonRequest) -> EndpointComparisonResponse:
    indicator = lookup_indicator(request.indicator_id)
    if indicator is None:
        raise ApiError(404, "not_found", f"Indicator {request.indicator_id!r} does not exist.", {"resource": "indicator", "id": request.indicator_id})
    setup = _build_setup(request.setup)
    comparison = compare_endpoint_to_equivalence(setup, indicator)
    return EndpointComparisonResponse(
        equivalence_volume_l=comparison.equivalence_volume_l,
        indicator_endpoint_volume_l=comparison.indicator_endpoint_volume_l,
        difference_l=comparison.difference_l,
        explanation=comparison.explanation,
    )
