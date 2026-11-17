"""Typed request/response shapes for the pure solver entrypoint (`solver.solve_equilibrium`).

Plain `dataclasses`, not pydantic: this package has no dependency on FastAPI or any web framework,
so it can be called as a local function (by a future Python-side Agent 07 integration, or by the
test suite) with no service running at all. `matterlab_science/api/titration.py` adapts these to
pydantic models for the HTTP surface without changing their meaning.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Literal

from .provenance import EvidenceLevel

SolveStatus = Literal["SUCCEEDED", "UNSUPPORTED", "FAILED"]

#: The model identifier implemented by `solver.solve_equilibrium`. Accepted as an explicit input
#: (per the brief) so that a caller names the model it expects and gets UNSUPPORTED, not a silently
#: different calculation, if it asks for anything else. Named without "monoprotic" since v2 covers
#: polyprotic acids/bases and multiple simultaneous weak systems too (see
#: `services/science/titration/README.md` Section 3); the symbol keeps its original name for
#: import stability, only the string value changed.
MONOPROTIC_ELECTRONEUTRALITY_MODEL_ID = "acid-base-electroneutrality-v1"
METHOD_VERSION = "2.0.0"
SUPPORTED_MODEL_IDS: tuple[str, ...] = (MONOPROTIC_ELECTRONEUTRALITY_MODEL_ID,)

MixingAssumption = Literal["WELL_MIXED", "UNMIXED"]
ActivityModel = Literal["ideal", "davies"]


@dataclass(frozen=True)
class SpeciesAmountInput:
    """One entry of a validated species composition: a `species.SPECIES_BY_ID` key and the total
    moles of it present (conserved inventory, as `00_SHARED_INTEGRATION_CONTRACT.md` Section 4
    describes Agent 7's reducer maintaining it: nominal dosed reagents, not pre-resolved ion
    speciation -- resolving the equilibrium speciation is this solver's job)."""

    species_id: str
    moles: float
    source_id: str | None = None


@dataclass(frozen=True)
class SolveAssumptions:
    mixing: MixingAssumption = "WELL_MIXED"
    activity_model: ActivityModel = "ideal"


@dataclass(frozen=True)
class EquilibriumSpeciesConcentration:
    """Equilibrium concentration of one chemical form, e.g. the "HA" or "A-" form of a weak-acid
    system, or a spectator ion."""

    species_id: str
    form: str
    molar: float
    evidence: EvidenceLevel


@dataclass(frozen=True)
class SolveDiagnostics:
    charge_balance_residual_molar: float | None = None
    mass_balance_residuals_molar: Mapping[str, float] = field(default_factory=dict)
    ionic_strength_molar: float | None = None
    root_finder_method: str = "brentq (Brent's method) on pH = -log10[H+]"
    root_finder_iterations: int | None = None
    root_finder_function_calls: int | None = None
    root_finder_bracket_ph: tuple[float, float] | None = None
    activity_model_iterations: int | None = None
    """Outer self-consistent iterations of the Davies-equation activity correction (None for the
    ideal model, which needs none; see `activity.py`)."""
    input_hash: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "charge_balance_residual_molar": self.charge_balance_residual_molar,
            "mass_balance_residuals_molar": dict(self.mass_balance_residuals_molar),
            "ionic_strength_molar": self.ionic_strength_molar,
            "root_finder_method": self.root_finder_method,
            "root_finder_iterations": self.root_finder_iterations,
            "root_finder_function_calls": self.root_finder_function_calls,
            "root_finder_bracket_ph": list(self.root_finder_bracket_ph) if self.root_finder_bracket_ph else None,
            "activity_model_iterations": self.activity_model_iterations,
            "input_hash": self.input_hash,
        }


@dataclass(frozen=True)
class ReferenceQuantities:
    """Quantities for the scientific explanation panel (brief, "Required implementation" item 5)."""

    total_volume_l: float
    temperature_k: float
    initial_analytical_concentrations_molar: Mapping[str, float]
    kw: float
    pkw: float


@dataclass(frozen=True)
class NumericalUncertainty:
    """Solver-convergence uncertainty only (brief: "Do not invent uncertainty ... include model
    limitations when no validated uncertainty exists"): this is *not* a propagated measurement
    uncertainty from the Ka/Kw sources, which this package does not have in a form it could
    propagate honestly, and says so in `limitations`."""

    ph_numerical_tolerance: float
    basis: str
    limitations: tuple[str, ...]


@dataclass(frozen=True)
class SolveResult:
    status: SolveStatus
    model_id: str
    method_version: str = METHOD_VERSION

    pH: float | None = None
    pOH: float | None = None
    hydrogen_ion_molar: float | None = None
    hydroxide_ion_molar: float | None = None

    equilibrium_concentrations: tuple[EquilibriumSpeciesConcentration, ...] = ()
    reference_quantities: ReferenceQuantities | None = None
    numerical_uncertainty: NumericalUncertainty | None = None

    evidence: EvidenceLevel = "UNSUPPORTED"
    reason: str | None = None
    """Human-readable explanation; always set when status is not SUCCEEDED, optional otherwise."""
    warnings: tuple[str, ...] = ()
    assumptions: tuple[str, ...] = ()
    diagnostics: SolveDiagnostics = field(default_factory=SolveDiagnostics)

    def is_ok(self) -> bool:
        return self.status == "SUCCEEDED"
