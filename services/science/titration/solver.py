"""The pure solver entrypoint (`solve_equilibrium`): validation, species classification and
dispatch to the root-finder in `equilibrium.py`, packaged into a `types.SolveResult`.

This is the one function other agents should call (directly in Python, or through the HTTP
wrapper in `matterlab_science/api/titration.py`): it is deterministic, does no I/O, and never
returns a plausible-looking number for a system outside its validated scope -- it returns
`UNSUPPORTED` (well-formed input, unsupported chemistry/conditions) or `FAILED` (malformed input,
or a genuine numerical failure) with a human-readable `reason` and structured `diagnostics`
instead.
"""

from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Mapping, Sequence
from dataclasses import asdict

from . import species as species_registry
from .constants import MAX_VALID_CONCENTRATION_MOLAR, MAX_VOLUME_L, MIN_VOLUME_L
from .equilibrium import SystemTotals, solve_hydrogen_ion
from .provenance import weakest
from .species import SpeciesDefinition
from .types import (
    MONOPROTIC_ELECTRONEUTRALITY_MODEL_ID,
    SUPPORTED_MODEL_IDS,
    EquilibriumSpeciesConcentration,
    NumericalUncertainty,
    ReferenceQuantities,
    SolveAssumptions,
    SolveDiagnostics,
    SolveResult,
    SpeciesAmountInput,
)
from .water import kw_at_temperature, validate_temperature_k

#: Weak-acid/weak-base Ka/Kb values are tabulated at 298.15 K and are *not* given their own
#: temperature model in v1 (only Kw(T) is, in `water.py`); they are held constant within this band
#: around the reference temperature, with a warning, and the system is UNSUPPORTED outside it.
WEAK_SYSTEM_VALID_TEMPERATURE_RANGE_K = (288.15, 308.15)

#: Ionic strength above which the ideal-activity assumption (activity coefficient = 1) is flagged
#: as increasingly approximate (roughly the upper edge of where the Debye-Huckel limiting law is
#: still a reasonable guide); a diagnostic warning, not a rejection.
IONIC_STRENGTH_WARNING_THRESHOLD_MOLAR = 0.1


def _result(status: str, model_id: str, *, reason: str | None = None, warnings: Sequence[str] = (), diagnostics: SolveDiagnostics | None = None) -> SolveResult:
    return SolveResult(status=status, model_id=model_id, evidence="UNSUPPORTED", reason=reason, warnings=tuple(warnings), diagnostics=diagnostics or SolveDiagnostics())


def _resolve_assumptions(assumptions: SolveAssumptions | Mapping[str, object] | None) -> SolveAssumptions:
    if assumptions is None:
        return SolveAssumptions()
    if isinstance(assumptions, SolveAssumptions):
        return assumptions
    return SolveAssumptions(**dict(assumptions))


def _input_hash(species: Sequence[SpeciesAmountInput], volume_l: float, temperature_k: float, model_id: str, assumptions: SolveAssumptions) -> str:
    payload = {
        "species": sorted(({"species_id": s.species_id, "moles": s.moles} for s in species), key=lambda d: str(d["species_id"])),
        "volume_l": volume_l,
        "temperature_k": temperature_k,
        "model_id": model_id,
        "assumptions": asdict(assumptions),
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def solve_equilibrium(
    species: Sequence[SpeciesAmountInput],
    volume_l: float,
    temperature_k: float = 298.15,
    model_id: str = MONOPROTIC_ELECTRONEUTRALITY_MODEL_ID,
    assumptions: SolveAssumptions | Mapping[str, object] | None = None,
) -> SolveResult:
    """Validated species composition (moles) + total volume (L) + temperature (K) + model id +
    explicit assumptions -> pH, equilibrium concentrations, status, diagnostics, method/version
    and numerical uncertainty. Pure and deterministic: identical inputs always give an identical
    result, and nothing is read from or written to a database, the network or the filesystem.
    """
    resolved_assumptions = _resolve_assumptions(assumptions)
    diagnostics = SolveDiagnostics(input_hash=_input_hash(species, volume_l, temperature_k, model_id, resolved_assumptions))
    assumption_notes = [
        "Ideal dilute solution: ionic activity coefficients are taken as 1 (activity = molar concentration).",
        "Instantaneous, complete mixing (WELL_MIXED): the solution is homogeneous at the moment the equilibrium is evaluated.",
        "Strong acids and strong bases are modelled as completely dissociated (no residual undissociated form).",
    ]

    if model_id not in SUPPORTED_MODEL_IDS:
        return _result("UNSUPPORTED", model_id, reason=f"Model id {model_id!r} is not implemented by this solver; supported model ids: {', '.join(SUPPORTED_MODEL_IDS)}.", diagnostics=diagnostics)
    if resolved_assumptions.mixing != "WELL_MIXED":
        return _result("UNSUPPORTED", model_id, reason=f"mixing={resolved_assumptions.mixing!r} is not supported in v1; only WELL_MIXED is implemented.", diagnostics=diagnostics)
    if resolved_assumptions.activity_model != "ideal":
        return _result(
            "UNSUPPORTED", model_id, reason=f"activity_model={resolved_assumptions.activity_model!r} is not implemented in v1; only 'ideal' (activity = concentration) is available.", diagnostics=diagnostics
        )

    # --- physical input validation: malformed request -> FAILED, not "unsupported chemistry" -----
    if not math.isfinite(volume_l) or volume_l <= 0:
        return _result("FAILED", model_id, reason=f"Total volume must be a positive, finite number of litres; got {volume_l!r}.", diagnostics=diagnostics)
    if not (MIN_VOLUME_L <= volume_l <= MAX_VOLUME_L):
        return _result("FAILED", model_id, reason=f"Total volume {volume_l:.6g} L is outside the accepted range ({MIN_VOLUME_L:g} L to {MAX_VOLUME_L:g} L).", diagnostics=diagnostics)
    for amount in species:
        if not math.isfinite(amount.moles) or amount.moles < 0:
            return _result("FAILED", model_id, reason=f"Species {amount.species_id!r}: moles must be a non-negative, finite number; got {amount.moles!r}.", diagnostics=diagnostics)

    # --- temperature: outside the validated aqueous equilibrium model range -> UNSUPPORTED --------
    temperature_reason = validate_temperature_k(temperature_k)
    if temperature_reason is not None:
        return _result("UNSUPPORTED", model_id, reason=temperature_reason, diagnostics=diagnostics)
    water = kw_at_temperature(temperature_k)

    # --- species resolution: unknown identity or explicitly out-of-scope chemistry -> UNSUPPORTED
    resolved: list[tuple[SpeciesAmountInput, SpeciesDefinition]] = []
    for amount in species:
        if amount.moles == 0:
            continue  # zero moles cannot change the equilibrium; not an error
        definition = species_registry.lookup(amount.species_id)
        if definition is None:
            return _result("UNSUPPORTED", model_id, reason=f"Species id {amount.species_id!r} is not a resolved chemical species known to this solver.", diagnostics=diagnostics)
        if definition.unsupported_reason is not None:
            return _result(
                "UNSUPPORTED", model_id, reason=f"{definition.name} ({definition.formula}) is outside the v1 titration solver's scope: {definition.unsupported_reason}", diagnostics=diagnostics
            )
        resolved.append((amount, definition))

    # --- classify and aggregate, enforcing the v1 scope (at most one weak-acid system, at most one
    #     weak-base system, not both at once, no strong+weak mixture of the same acid/base type) --
    strong_acid_moles = strong_base_moles = 0.0
    weak_acid_system_id: str | None = None
    weak_acid_Ka: float | None = None
    weak_acid_moles = 0.0
    weak_base_system_id: str | None = None
    weak_base_Ka_conj: float | None = None
    weak_base_moles = 0.0
    extra_cation_moles = extra_anion_moles = 0.0
    initial_moles_by_species: dict[str, float] = {}

    for amount, definition in resolved:
        initial_moles_by_species[definition.species_id] = initial_moles_by_species.get(definition.species_id, 0.0) + amount.moles
        if definition.role == "strong_acid":
            strong_acid_moles += amount.moles * definition.strong_acid_equivalent_per_mole
        elif definition.role == "strong_base":
            strong_base_moles += amount.moles * definition.strong_base_equivalent_per_mole
        elif definition.role in ("weak_acid", "weak_acid_conjugate_salt"):
            if weak_acid_system_id is None:
                weak_acid_system_id, weak_acid_Ka = definition.system_id, definition.Ka_298_15k
            elif weak_acid_system_id != definition.system_id:
                return _result(
                    "UNSUPPORTED",
                    model_id,
                    reason=f"Dosing two distinct weak-acid systems together ({weak_acid_system_id!r} and {definition.system_id!r}) is outside the v1 solver's scope (one weak-acid system per solve).",
                    diagnostics=diagnostics,
                )
            weak_acid_moles += amount.moles * definition.system_total_per_mole
            extra_cation_moles += amount.moles * definition.extra_spectator_cation_per_mole
            extra_anion_moles += amount.moles * definition.extra_spectator_anion_per_mole
        elif definition.role in ("weak_base", "weak_base_conjugate_salt"):
            if weak_base_system_id is None:
                weak_base_system_id, weak_base_Ka_conj = definition.system_id, definition.Ka_298_15k
            elif weak_base_system_id != definition.system_id:
                return _result(
                    "UNSUPPORTED",
                    model_id,
                    reason=f"Dosing two distinct weak-base systems together ({weak_base_system_id!r} and {definition.system_id!r}) is outside the v1 solver's scope (one weak-base system per solve).",
                    diagnostics=diagnostics,
                )
            weak_base_moles += amount.moles * definition.system_total_per_mole
            extra_cation_moles += amount.moles * definition.extra_spectator_cation_per_mole
            extra_anion_moles += amount.moles * definition.extra_spectator_anion_per_mole
        elif definition.role == "neutral_electrolyte":
            extra_cation_moles += amount.moles * definition.extra_spectator_cation_per_mole
            extra_anion_moles += amount.moles * definition.extra_spectator_anion_per_mole
        elif definition.role == "water":
            continue
        else:
            return _result("UNSUPPORTED", model_id, reason=f"Species role {definition.role!r} of {definition.species_id!r} is not handled by the v1 solver.", diagnostics=diagnostics)

    if weak_acid_system_id is not None and weak_base_system_id is not None:
        return _result(
            "UNSUPPORTED",
            model_id,
            reason=f"A weak-acid system ({weak_acid_system_id!r}) and a weak-base system ({weak_base_system_id!r}) dosed together are outside the v1 solver's validated scope.",
            diagnostics=diagnostics,
        )
    if strong_acid_moles > 0 and weak_acid_system_id is not None:
        return _result("UNSUPPORTED", model_id, reason="A strong acid and a weak acid dosed together are outside the v1 solver's validated scope (mixtures of acid strengths are not a v1 system).", diagnostics=diagnostics)
    if strong_base_moles > 0 and weak_base_system_id is not None:
        return _result("UNSUPPORTED", model_id, reason="A strong base and a weak base dosed together are outside the v1 solver's validated scope (mixtures of base strengths are not a v1 system).", diagnostics=diagnostics)

    has_weak_system = weak_acid_system_id is not None or weak_base_system_id is not None
    if has_weak_system and not (WEAK_SYSTEM_VALID_TEMPERATURE_RANGE_K[0] <= temperature_k <= WEAK_SYSTEM_VALID_TEMPERATURE_RANGE_K[1]):
        lo, hi = WEAK_SYSTEM_VALID_TEMPERATURE_RANGE_K
        return _result(
            "UNSUPPORTED",
            model_id,
            reason=(
                f"The dissociation constant of {(weak_acid_system_id or weak_base_system_id)!r} is tabulated at 25 degC (298.15 K) and is not given its own "
                f"temperature model in v1; it is held constant only for {lo:.2f} K to {hi:.2f} K, and {temperature_k:.2f} K is outside that band."
            ),
            diagnostics=diagnostics,
        )
    if has_weak_system and abs(temperature_k - 298.15) > 1e-9:
        assumption_notes.append(
            f"The dissociation constant of {(weak_acid_system_id or weak_base_system_id)!r} is tabulated at 25 degC and is held constant with temperature in this model "
            "(only Kw(T) is temperature-corrected); its true temperature dependence is not modelled."
        )

    # --- concentrations, with the ideal-dilute-solution validated range -----------------------------
    def molar(total_moles: float) -> float:
        return total_moles / volume_l

    named_concentrations = {
        "strong acid": molar(strong_acid_moles),
        "strong base": molar(strong_base_moles),
        "weak-acid system": molar(weak_acid_moles),
        "weak-base system": molar(weak_base_moles),
        "extra spectator cation": molar(extra_cation_moles),
        "extra spectator anion": molar(extra_anion_moles),
    }
    for label, value in named_concentrations.items():
        if value > MAX_VALID_CONCENTRATION_MOLAR:
            return _result(
                "UNSUPPORTED", model_id, reason=f"{label} concentration {value:.4g} mol/L exceeds the ideal-dilute-solution model's validated range (0 to {MAX_VALID_CONCENTRATION_MOLAR:g} mol/L).", diagnostics=diagnostics
            )

    totals = SystemTotals(
        kw=water.kw,
        strong_acid_molar=named_concentrations["strong acid"],
        strong_base_molar=named_concentrations["strong base"],
        weak_acid_system_molar=named_concentrations["weak-acid system"],
        weak_acid_system_Ka=weak_acid_Ka,
        weak_base_system_molar=named_concentrations["weak-base system"],
        weak_base_system_Ka_conjugate=weak_base_Ka_conj,
        extra_spectator_cation_molar=named_concentrations["extra spectator cation"],
        extra_spectator_anion_molar=named_concentrations["extra spectator anion"],
    )

    root = solve_hydrogen_ion(totals)
    if not root.converged or root.hydrogen_ion_molar is None or root.pH is None:
        diagnostics = SolveDiagnostics(
            input_hash=diagnostics.input_hash,
            root_finder_bracket_ph=root.bracket_ph,
            root_finder_iterations=root.iterations,
            root_finder_function_calls=root.function_calls,
        )
        return _result("FAILED", model_id, reason=f"The equilibrium root finder did not converge: {root.failure_reason or 'no further detail available.'}", diagnostics=diagnostics)

    h = root.hydrogen_ion_molar
    oh = totals.kw / h
    ph = -math.log10(h)
    poh = -math.log10(oh)

    eq_concentrations: list[EquilibriumSpeciesConcentration] = [
        EquilibriumSpeciesConcentration("water", "H+", h, water.evidence),
        EquilibriumSpeciesConcentration("water", "OH-", oh, water.evidence),
    ]
    mass_balance_resid: dict[str, float] = {}
    if weak_acid_system_id is not None and weak_acid_Ka is not None:
        alpha_a_minus = weak_acid_Ka / (weak_acid_Ka + h)
        ha = totals.weak_acid_system_molar * (1.0 - alpha_a_minus)
        a_minus = totals.weak_acid_system_molar * alpha_a_minus
        eq_concentrations.append(EquilibriumSpeciesConcentration(weak_acid_system_id, "HA (protonated/neutral form)", ha, "MODEL_CALCULATED"))
        eq_concentrations.append(EquilibriumSpeciesConcentration(weak_acid_system_id, "A- (conjugate base)", a_minus, "MODEL_CALCULATED"))
        mass_balance_resid[weak_acid_system_id] = (ha + a_minus) - totals.weak_acid_system_molar
    if weak_base_system_id is not None and weak_base_Ka_conj is not None:
        alpha_bh_plus = h / (h + weak_base_Ka_conj)
        bh_plus = totals.weak_base_system_molar * alpha_bh_plus
        b = totals.weak_base_system_molar * (1.0 - alpha_bh_plus)
        eq_concentrations.append(EquilibriumSpeciesConcentration(weak_base_system_id, "BH+ (protonated/conjugate acid)", bh_plus, "MODEL_CALCULATED"))
        eq_concentrations.append(EquilibriumSpeciesConcentration(weak_base_system_id, "B (free base form)", b, "MODEL_CALCULATED"))
        mass_balance_resid[weak_base_system_id] = (bh_plus + b) - totals.weak_base_system_molar
    if totals.strong_acid_molar > 0:
        eq_concentrations.append(EquilibriumSpeciesConcentration("strong_acid", "fully dissociated conjugate base (spectator anion)", totals.strong_acid_molar, "MODEL_CALCULATED"))
    if totals.strong_base_molar > 0:
        eq_concentrations.append(EquilibriumSpeciesConcentration("strong_base", "fully dissociated spectator cation", totals.strong_base_molar, "MODEL_CALCULATED"))
    if totals.extra_spectator_cation_molar > 0:
        eq_concentrations.append(EquilibriumSpeciesConcentration("extra_electrolyte", "spectator cation", totals.extra_spectator_cation_molar, "MODEL_CALCULATED"))
    if totals.extra_spectator_anion_molar > 0:
        eq_concentrations.append(EquilibriumSpeciesConcentration("extra_electrolyte", "spectator anion", totals.extra_spectator_anion_molar, "MODEL_CALCULATED"))

    # All present ions in this v1 scope are monovalent (z = +-1), so ionic strength I = 1/2 sum(C z^2)
    # reduces to half the sum of every ionic concentration.
    charged_molar_concentrations = [h, oh, totals.strong_acid_molar, totals.strong_base_molar, totals.extra_spectator_cation_molar, totals.extra_spectator_anion_molar]
    if weak_acid_system_id is not None:
        charged_molar_concentrations.append(a_minus)
    if weak_base_system_id is not None:
        charged_molar_concentrations.append(bh_plus)
    ionic_strength = 0.5 * sum(charged_molar_concentrations)

    warnings: list[str] = []
    if ionic_strength > IONIC_STRENGTH_WARNING_THRESHOLD_MOLAR:
        warnings.append(
            f"Ionic strength is approximately {ionic_strength:.3g} mol/L, above the {IONIC_STRENGTH_WARNING_THRESHOLD_MOLAR:g} mol/L guide used here for the ideal-activity assumption; "
            "activity coefficients are not actually 1 at this ionic strength, so the computed pH is a less accurate approximation than at lower concentrations."
        )
    if has_weak_system and abs(temperature_k - 298.15) > 1e-9:
        warnings.append(f"Temperature {temperature_k:.2f} K differs from the 25 degC (298.15 K) reference point of the tabulated Ka/Kb; see assumptions.")
    warnings.extend(water.warnings)

    diagnostics = SolveDiagnostics(
        charge_balance_residual_molar=root.residual,
        mass_balance_residuals_molar=mass_balance_resid,
        ionic_strength_molar=ionic_strength,
        root_finder_iterations=root.iterations,
        root_finder_function_calls=root.function_calls,
        root_finder_bracket_ph=root.bracket_ph,
        input_hash=diagnostics.input_hash,
    )

    involved_evidence = [d.provenance.evidence for _, d in resolved if d.provenance is not None] + [water.evidence, "MODEL_CALCULATED"]

    reference_quantities = ReferenceQuantities(
        total_volume_l=volume_l,
        temperature_k=temperature_k,
        initial_analytical_concentrations_molar={sid: m / volume_l for sid, m in initial_moles_by_species.items()},
        kw=totals.kw,
        pkw=-math.log10(totals.kw),
    )

    numerical_uncertainty = NumericalUncertainty(
        ph_numerical_tolerance=1e-9,
        basis="Brent's method (scipy.optimize.brentq) convergence tolerance on pH; confirmed by re-evaluating the charge-balance residual at the root (see diagnostics.charge_balance_residual_molar).",
        limitations=(
            "Measurement uncertainties of the underlying Ka/Kw reference values are not propagated to a pH confidence interval in v1.",
            "Non-ideal activity effects (ionic-strength/Debye-Huckel corrections) are not modelled; see assumptions.",
        ),
    )

    return SolveResult(
        status="SUCCEEDED",
        model_id=model_id,
        pH=ph,
        pOH=poh,
        hydrogen_ion_molar=h,
        hydroxide_ion_molar=oh,
        equilibrium_concentrations=tuple(eq_concentrations),
        reference_quantities=reference_quantities,
        numerical_uncertainty=numerical_uncertainty,
        evidence=weakest(involved_evidence),
        reason=None,
        warnings=tuple(warnings),
        assumptions=tuple(assumption_notes),
        diagnostics=diagnostics,
    )
