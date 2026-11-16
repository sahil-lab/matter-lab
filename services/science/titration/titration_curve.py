"""Titration curve generation: the burette/flask setup, equivalence/half-equivalence, the
pH-vs-delivered-volume curve, and the indicator endpoint-vs-equivalence comparison.

Every point of the curve is an independent call to `solver.solve_equilibrium`: there is no
interpolation, shape fitting, or hardcoded curve anywhere in this module. `equivalence_volume`
is the only purely stoichiometric (not equilibrium) quantity here, because it follows from
conservation of moles for a 1:1 monoprotic reaction alone; it is still cross-checked against the
solved curve in the test suite (the pH swings through its steepest gradient at that volume).
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

from . import species as species_registry
from .indicators import IndicatorDefinition
from .solver import solve_equilibrium
from .types import SolveResult, SpeciesAmountInput


@dataclass(frozen=True)
class TitrationSetup:
    """A titration of one analyte (in the flask, already diluted to `analyte_volume_l`) by one
    titrant (delivered from the burette at `titrant_concentration_molar`). Both must be species the
    solver recognises; v1 covers 1:1 monoprotic reactions only (one titrant mole reacts with one
    analyte mole), matching the solver's scope."""

    analyte_species_id: str
    analyte_concentration_molar: float
    analyte_volume_l: float
    titrant_species_id: str
    titrant_concentration_molar: float
    temperature_k: float = 298.15
    #: Extra species present in the flask from the start (e.g. a supporting electrolyte), at fixed
    #: moles that do not change as titrant is delivered.
    additional_analyte_species: Sequence[SpeciesAmountInput] = ()

    def __post_init__(self) -> None:
        if species_registry.lookup(self.analyte_species_id) is None:
            raise ValueError(f"Unknown analyte species id {self.analyte_species_id!r}.")
        if species_registry.lookup(self.titrant_species_id) is None:
            raise ValueError(f"Unknown titrant species id {self.titrant_species_id!r}.")

    @property
    def analyte_moles(self) -> float:
        return self.analyte_concentration_molar * self.analyte_volume_l

    def species_at(self, delivered_volume_l: float) -> list[SpeciesAmountInput]:
        if delivered_volume_l < 0:
            raise ValueError(f"Delivered volume must be non-negative; got {delivered_volume_l!r}.")
        titrant_moles = self.titrant_concentration_molar * delivered_volume_l
        return [
            SpeciesAmountInput(self.analyte_species_id, self.analyte_moles),
            SpeciesAmountInput(self.titrant_species_id, titrant_moles),
            *self.additional_analyte_species,
        ]

    def total_volume_at(self, delivered_volume_l: float) -> float:
        return self.analyte_volume_l + delivered_volume_l


def equivalence_volume_l(setup: TitrationSetup) -> float:
    """Stoichiometric equivalence volume for a 1:1 monoprotic reaction: moles of analyte divided by
    the titrant's concentration. Pure stoichiometry, not an equilibrium calculation -- the solved
    curve is expected to pass through its steepest pH gradient near this volume, which the test
    suite checks explicitly rather than assuming."""
    if setup.titrant_concentration_molar <= 0:
        raise ValueError("Titrant concentration must be positive.")
    return setup.analyte_moles / setup.titrant_concentration_molar


def half_equivalence_volume_l(setup: TitrationSetup) -> float:
    return equivalence_volume_l(setup) / 2.0


@dataclass(frozen=True)
class TitrationPoint:
    delivered_volume_l: float
    total_volume_l: float
    result: SolveResult

    @property
    def pH(self) -> float | None:
        return self.result.pH


def titration_point(setup: TitrationSetup, delivered_volume_l: float) -> TitrationPoint:
    species = setup.species_at(delivered_volume_l)
    total_volume = setup.total_volume_at(delivered_volume_l)
    result = solve_equilibrium(species=species, volume_l=total_volume, temperature_k=setup.temperature_k)
    return TitrationPoint(delivered_volume_l=delivered_volume_l, total_volume_l=total_volume, result=result)


def titration_curve(setup: TitrationSetup, delivered_volumes_l: Sequence[float]) -> list[TitrationPoint]:
    """The pH at each of `delivered_volumes_l`, each an independent equilibrium solve -- the curve
    is whatever shape the chemistry produces, not a shape chosen in advance."""
    return [titration_point(setup, v) for v in delivered_volumes_l]


def steepest_gradient_volume_l(points: Sequence[TitrationPoint]) -> float | None:
    """The midpoint of the delivered-volume interval where |dpH/dV| is largest among `points`
    (sorted by volume); used to confirm the solved curve's steepest rise falls near the
    stoichiometric equivalence volume, instead of assuming it. `None` if fewer than two successful
    points are available."""
    ok = sorted((p for p in points if p.result.is_ok() and p.pH is not None), key=lambda p: p.delivered_volume_l)
    if len(ok) < 2:
        return None
    best_gradient = -1.0
    best_midpoint = None
    for a, b in zip(ok, ok[1:]):
        dv = b.delivered_volume_l - a.delivered_volume_l
        if dv <= 0:
            continue
        gradient = abs((b.pH - a.pH) / dv)  # type: ignore[operator]
        if gradient > best_gradient:
            best_gradient = gradient
            best_midpoint = (a.delivered_volume_l + b.delivered_volume_l) / 2.0
    return best_midpoint


def indicator_endpoint_volume_l(setup: TitrationSetup, indicator: IndicatorDefinition, *, search_high_l: float | None = None) -> float | None:
    """Delivered volume at which the titration curve's pH crosses the indicator's `pKin` (the
    colour-change midpoint), found by the same bracketing root-finding idiom as the equilibrium
    solver itself (monotonic pH vs. volume for the single-analyte/single-titrant setups this
    package supports), evaluated with the real solver at each trial volume -- not read off a
    pre-computed curve or interpolated from a table. `None` if the search range never crosses
    `pKin` (e.g. the indicator is not suited to this titration)."""
    equivalence = equivalence_volume_l(setup)
    high = search_high_l if search_high_l is not None else max(equivalence * 4.0, equivalence + 1e-6)

    def ph_minus_pkin(volume_l: float) -> float:
        point = titration_point(setup, max(volume_l, 0.0))
        if point.pH is None:
            raise RuntimeError(f"solve_equilibrium did not succeed at delivered volume {volume_l} L: {point.result.reason}")
        return point.pH - indicator.pKin

    f_low = ph_minus_pkin(0.0)
    f_high = ph_minus_pkin(high)
    if (f_low > 0) == (f_high > 0):
        return None  # the indicator's pKin is never crossed in this search range

    from scipy.optimize import brentq

    root, _ = brentq(ph_minus_pkin, 0.0, high, xtol=1e-10, rtol=1e-12, full_output=True)
    return float(root)


@dataclass(frozen=True)
class EndpointComparison:
    equivalence_volume_l: float
    indicator_endpoint_volume_l: float | None
    difference_l: float | None
    """`indicator_endpoint_volume_l - equivalence_volume_l`; positive means the colour change is
    seen after the stoichiometric equivalence point."""
    explanation: str


def compare_endpoint_to_equivalence(setup: TitrationSetup, indicator: IndicatorDefinition) -> EndpointComparison:
    equivalence = equivalence_volume_l(setup)
    endpoint = indicator_endpoint_volume_l(setup, indicator)
    if endpoint is None:
        return EndpointComparison(
            equivalence_volume_l=equivalence,
            indicator_endpoint_volume_l=None,
            difference_l=None,
            explanation=(
                f"{indicator.name} (pKin {indicator.pKin:.2g}) never reaches its colour-change midpoint in this titration's pH range: "
                "it is not a suitable indicator for this combination of analyte and titrant."
            ),
        )
    difference = endpoint - equivalence
    explanation = (
        f"The equivalence point ({equivalence * 1000:.4f} mL) is defined by stoichiometry alone (moles of titrant delivered equal moles of analyte). "
        f"{indicator.name} changes colour where the solution's own pH crosses the indicator's pKin ({indicator.pKin:.2g}), which the solved curve places at "
        f"{endpoint * 1000:.4f} mL -- a difference of {difference * 1000:+.4f} mL. The two differ because the indicator's colour change is a property of the "
        "dye's own acid/base equilibrium, not of the titration; they coincide only when pKin equals the pH at equivalence."
    )
    return EndpointComparison(equivalence_volume_l=equivalence, indicator_endpoint_volume_l=endpoint, difference_l=difference, explanation=explanation)


@dataclass(frozen=True)
class ScientificPanel:
    """Reference quantities for the scientific explanation panel (brief, "Required implementation"
    item 5): initial concentrations, delivered volume, equivalence estimate, half-equivalence,
    pH, assumptions, units and source ids, gathered from one titration point."""

    delivered_volume_l: float
    total_volume_l: float
    equivalence_volume_l: float
    half_equivalence_volume_l: float
    at_half_equivalence: bool
    pH: float | None
    status: str
    initial_analyte_concentration_molar: float
    initial_titrant_concentration_molar: float
    assumptions: tuple[str, ...]
    units: dict[str, str]
    source_ids: tuple[str, ...]


def scientific_panel(setup: TitrationSetup, delivered_volume_l: float) -> ScientificPanel:
    point = titration_point(setup, delivered_volume_l)
    equivalence = equivalence_volume_l(setup)
    half_equivalence = equivalence / 2.0
    analyte = species_registry.lookup(setup.analyte_species_id)
    titrant = species_registry.lookup(setup.titrant_species_id)
    source_ids = tuple(sorted({s.species_id for s in (analyte, titrant) if s is not None and s.provenance is not None}))
    return ScientificPanel(
        delivered_volume_l=delivered_volume_l,
        total_volume_l=point.total_volume_l,
        equivalence_volume_l=equivalence,
        half_equivalence_volume_l=half_equivalence,
        at_half_equivalence=math.isclose(delivered_volume_l, half_equivalence, rel_tol=1e-6, abs_tol=1e-9),
        pH=point.pH,
        status=point.result.status,
        initial_analyte_concentration_molar=setup.analyte_concentration_molar,
        initial_titrant_concentration_molar=setup.titrant_concentration_molar,
        assumptions=point.result.assumptions,
        units={"volume": "L", "concentration": "mol/L", "temperature": "K", "pH": "dimensionless (-log10 a(H+), ideal: a = [H+])"},
        source_ids=source_ids,
    )
