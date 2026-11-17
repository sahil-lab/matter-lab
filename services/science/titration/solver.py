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
from .activity import MAX_VALIDATED_IONIC_STRENGTH_MOLAR, solve_with_activity_model
from .constants import MAX_VALID_CONCENTRATION_MOLAR, MAX_VOLUME_L, MIN_VOLUME_L
from .equilibrium import SystemTotals, WeakSystem, stepwise_distribution
from .ka_temperature import IonizationThermodynamics, pKa_at_temperature
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
#: temperature model (only Kw(T) is, in `water.py`) *unless* their species carries an
#: `ionization_thermodynamics` record (`species.py`; currently acetic acid only), in which case
#: `_adjusted_ka_steps` below uses it instead. Every other system is held constant within this
#: band around the reference temperature, with a warning, and is UNSUPPORTED outside it.
WEAK_SYSTEM_VALID_TEMPERATURE_RANGE_K = (288.15, 308.15)

#: Ionic strength above which the *ideal*-activity assumption (activity coefficient = 1) is
#: flagged as increasingly approximate (roughly the upper edge of where the Debye-Huckel limiting
#: law is still a reasonable guide); a diagnostic warning, not a rejection. The Davies model
#: (`activity_model="davies"`) has its own, higher ceiling (`activity.MAX_VALIDATED_IONIC_STRENGTH_MOLAR`).
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


def _form_label(step_index: int, n_steps: int, *, is_acid: bool) -> str:
    """A human-readable label for one protonation state of an n-step system. `step_index` is the
    number of protons removed from the fully protonated reference form (0..n_steps)."""
    if is_acid:
        charge = -step_index
    else:
        charge = n_steps - step_index  # weak-base systems are indexed from their conjugate acid
    if charge == 0:
        return "fully protonated, neutral form" if is_acid else "fully deprotonated, neutral form"
    sign = "-" if charge < 0 else "+"
    magnitude = abs(charge)
    charge_text = sign if magnitude == 1 else f"{magnitude}{sign}"
    protons_removed = step_index if is_acid else n_steps - step_index
    return f"{protons_removed} of {n_steps} proton(s) removed (charge {charge_text})"


def _validated_ka_steps_at_temperature(
    system_id: str, ka_steps_298: tuple[float, ...], thermo: IonizationThermodynamics | None, temperature_k: float
) -> tuple[tuple[float, ...] | None, str | None]:
    """`(ka_steps, None)` at `temperature_k` if valid, or `(None, reason)` if not.

    Uses `thermo.valid_temperature_range_k` (a real Ka(T) model, `ka_temperature.py`) when the
    species has one; otherwise falls back to the generic `WEAK_SYSTEM_VALID_TEMPERATURE_RANGE_K`
    band with Ka held constant. Both paths return the *unchanged* 298.15 K values when the
    requested temperature *is* 298.15 K, so the reference case never depends on this function's
    (de)activation logic.
    """
    if abs(temperature_k - 298.15) < 1e-9:
        return ka_steps_298, None
    if thermo is not None:
        lo, hi = thermo.valid_temperature_range_k
        if lo <= temperature_k <= hi:
            assert len(ka_steps_298) == 1, "ionization_thermodynamics is only defined for monoprotic/monoacidic systems"
            pKa_298 = -math.log10(ka_steps_298[0])
            pKa_T = pKa_at_temperature(pKa_298, thermo, temperature_k)
            return (10.0 ** (-pKa_T),), None
        return None, (
            f"The Ka(T) model for {system_id!r} is validated only for {lo:.2f} K to {hi:.2f} K (see species.py), and {temperature_k:.2f} K is outside that range."
        )
    lo, hi = WEAK_SYSTEM_VALID_TEMPERATURE_RANGE_K
    if lo <= temperature_k <= hi:
        return ka_steps_298, None
    return None, (
        f"The dissociation constant(s) of {system_id!r} are tabulated at 25 degC (298.15 K) and are not given their own temperature model; they are "
        f"held constant only for {lo:.2f} K to {hi:.2f} K, and {temperature_k:.2f} K is outside that band."
    )


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

    Supports any number of distinct weak-acid and weak-base systems together (each monoprotic or
    polyprotic) alongside a strong acid and a strong base; see `species.py` for what is registered
    and `README.md` Section 3 for the (few) combinations still excluded and why.
    """
    resolved_assumptions = _resolve_assumptions(assumptions)
    diagnostics = SolveDiagnostics(input_hash=_input_hash(species, volume_l, temperature_k, model_id, resolved_assumptions))
    assumption_notes = [
        "Instantaneous, complete mixing (WELL_MIXED): the solution is homogeneous at the moment the equilibrium is evaluated.",
        "Strong acids and strong bases are modelled as completely dissociated (no residual undissociated form).",
    ]
    if resolved_assumptions.activity_model == "ideal":
        assumption_notes.insert(0, "Ideal dilute solution: ionic activity coefficients are taken as 1 (activity = molar concentration).")
    elif resolved_assumptions.activity_model == "davies":
        assumption_notes.insert(
            0, "Non-ideal activity: the Davies equation (log10(gamma) = -A z^2 (sqrt(I)/(1+sqrt(I)) - 0.3 I), A = 0.509 at 25 degC) corrects Ka and Kw for ionic strength, solved self-consistently."
        )

    if model_id not in SUPPORTED_MODEL_IDS:
        return _result("UNSUPPORTED", model_id, reason=f"Model id {model_id!r} is not implemented by this solver; supported model ids: {', '.join(SUPPORTED_MODEL_IDS)}.", diagnostics=diagnostics)
    if resolved_assumptions.mixing != "WELL_MIXED":
        return _result("UNSUPPORTED", model_id, reason=f"mixing={resolved_assumptions.mixing!r} is not supported; only WELL_MIXED is implemented.", diagnostics=diagnostics)
    if resolved_assumptions.activity_model not in ("ideal", "davies"):
        return _result(
            "UNSUPPORTED", model_id, reason=f"activity_model={resolved_assumptions.activity_model!r} is not implemented; available models are 'ideal' (activity = concentration) and 'davies'.", diagnostics=diagnostics
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
                "UNSUPPORTED", model_id, reason=f"{definition.name} ({definition.formula}) is outside this solver's scope: {definition.unsupported_reason}", diagnostics=diagnostics
            )
        resolved.append((amount, definition))

    # --- classify and aggregate into named pools; any number of distinct weak-acid and weak-base
    #     systems (each monoprotic or polyprotic) may coexist, alongside a strong acid/base ---------
    strong_acid_moles = strong_base_moles = 0.0
    acid_pool_moles: dict[str, float] = {}
    acid_pool_ka_steps: dict[str, tuple[float, ...]] = {}
    acid_pool_thermo: dict[str, IonizationThermodynamics | None] = {}
    base_pool_moles: dict[str, float] = {}
    base_pool_ka_steps: dict[str, tuple[float, ...]] = {}
    base_pool_thermo: dict[str, IonizationThermodynamics | None] = {}
    extra_cation_moles = extra_anion_moles = 0.0
    initial_moles_by_species: dict[str, float] = {}

    for amount, definition in resolved:
        initial_moles_by_species[definition.species_id] = initial_moles_by_species.get(definition.species_id, 0.0) + amount.moles
        if definition.role == "strong_acid":
            strong_acid_moles += amount.moles * definition.strong_acid_equivalent_per_mole
        elif definition.role == "strong_base":
            strong_base_moles += amount.moles * definition.strong_base_equivalent_per_mole
        elif definition.role in ("weak_acid", "weak_acid_conjugate_salt"):
            assert definition.system_id is not None and definition.Ka_steps is not None
            acid_pool_moles[definition.system_id] = acid_pool_moles.get(definition.system_id, 0.0) + amount.moles * definition.system_total_per_mole
            acid_pool_ka_steps.setdefault(definition.system_id, definition.Ka_steps)
            acid_pool_thermo.setdefault(definition.system_id, definition.ionization_thermodynamics)
            extra_cation_moles += amount.moles * definition.extra_spectator_cation_per_mole
            extra_anion_moles += amount.moles * definition.extra_spectator_anion_per_mole
        elif definition.role in ("weak_base", "weak_base_conjugate_salt"):
            assert definition.system_id is not None and definition.Ka_steps is not None
            base_pool_moles[definition.system_id] = base_pool_moles.get(definition.system_id, 0.0) + amount.moles * definition.system_total_per_mole
            base_pool_ka_steps.setdefault(definition.system_id, definition.Ka_steps)
            base_pool_thermo.setdefault(definition.system_id, definition.ionization_thermodynamics)
            extra_cation_moles += amount.moles * definition.extra_spectator_cation_per_mole
            extra_anion_moles += amount.moles * definition.extra_spectator_anion_per_mole
        elif definition.role == "neutral_electrolyte":
            extra_cation_moles += amount.moles * definition.extra_spectator_cation_per_mole
            extra_anion_moles += amount.moles * definition.extra_spectator_anion_per_mole
        elif definition.role == "water":
            continue
        else:
            return _result("UNSUPPORTED", model_id, reason=f"Species role {definition.role!r} of {definition.species_id!r} is not handled by this solver.", diagnostics=diagnostics)

    # --- per-pool temperature validation: a real Ka(T) model where sourced (species.py's
    #     ionization_thermodynamics; currently acetic acid only), the generic +/-10 K band otherwise ---
    acid_pool_ka_steps_at_t: dict[str, tuple[float, ...]] = {}
    base_pool_ka_steps_at_t: dict[str, tuple[float, ...]] = {}
    for sid, ka_steps in acid_pool_ka_steps.items():
        adjusted, reason = _validated_ka_steps_at_temperature(sid, ka_steps, acid_pool_thermo[sid], temperature_k)
        if reason is not None:
            return _result("UNSUPPORTED", model_id, reason=reason, diagnostics=diagnostics)
        assert adjusted is not None
        acid_pool_ka_steps_at_t[sid] = adjusted
        if acid_pool_thermo[sid] is not None and abs(temperature_k - 298.15) > 1e-9:
            assumption_notes.append(f"The dissociation constant of {sid!r} is corrected for temperature by a sourced van't Hoff + heat-capacity model (see species.py), not held constant.")
        elif abs(temperature_k - 298.15) > 1e-9:
            assumption_notes.append(f"The dissociation constant of {sid!r} is tabulated at 25 degC and held constant with temperature in this model; its true temperature dependence is not modelled.")
    for sid, ka_steps in base_pool_ka_steps.items():
        adjusted, reason = _validated_ka_steps_at_temperature(sid, ka_steps, base_pool_thermo[sid], temperature_k)
        if reason is not None:
            return _result("UNSUPPORTED", model_id, reason=reason, diagnostics=diagnostics)
        assert adjusted is not None
        base_pool_ka_steps_at_t[sid] = adjusted
        if base_pool_thermo[sid] is not None and abs(temperature_k - 298.15) > 1e-9:
            assumption_notes.append(f"The dissociation constant of {sid!r} is corrected for temperature by a sourced van't Hoff + heat-capacity model (see species.py), not held constant.")
        elif abs(temperature_k - 298.15) > 1e-9:
            assumption_notes.append(f"The dissociation constant of {sid!r} is tabulated at 25 degC and held constant with temperature in this model; its true temperature dependence is not modelled.")
    has_weak_system = bool(acid_pool_moles) or bool(base_pool_moles)

    # --- concentrations, with the ideal-dilute-solution validated range -----------------------------
    def molar(total_moles: float) -> float:
        return total_moles / volume_l

    named_concentrations: dict[str, float] = {
        "strong acid": molar(strong_acid_moles),
        "strong base": molar(strong_base_moles),
        "extra spectator cation": molar(extra_cation_moles),
        "extra spectator anion": molar(extra_anion_moles),
    }
    named_concentrations.update({f"weak-acid system '{sid}'": molar(m) for sid, m in acid_pool_moles.items()})
    named_concentrations.update({f"weak-base system '{sid}'": molar(m) for sid, m in base_pool_moles.items()})
    for label, value in named_concentrations.items():
        if value > MAX_VALID_CONCENTRATION_MOLAR:
            return _result(
                "UNSUPPORTED", model_id, reason=f"{label} concentration {value:.4g} mol/L exceeds the ideal-dilute-solution model's validated range (0 to {MAX_VALID_CONCENTRATION_MOLAR:g} mol/L).", diagnostics=diagnostics
            )

    totals = SystemTotals(
        kw=water.kw,
        strong_acid_molar=molar(strong_acid_moles),
        strong_base_molar=molar(strong_base_moles),
        acid_systems=tuple(WeakSystem(molar(m), acid_pool_ka_steps_at_t[sid]) for sid, m in acid_pool_moles.items()),
        base_systems=tuple(WeakSystem(molar(m), base_pool_ka_steps_at_t[sid]) for sid, m in base_pool_moles.items()),
        extra_spectator_cation_molar=molar(extra_cation_moles),
        extra_spectator_anion_molar=molar(extra_anion_moles),
    )
    acid_system_ids = list(acid_pool_moles.keys())
    base_system_ids = list(base_pool_moles.keys())

    activity_result = solve_with_activity_model(totals, resolved_assumptions.activity_model)
    root = activity_result.root
    if not activity_result.converged or root.hydrogen_ion_molar is None or root.pH is None:
        diagnostics = SolveDiagnostics(
            input_hash=diagnostics.input_hash,
            root_finder_bracket_ph=root.bracket_ph,
            root_finder_iterations=root.iterations,
            root_finder_function_calls=root.function_calls,
            activity_model_iterations=activity_result.outer_iterations,
        )
        reason = activity_result.failure_reason or root.failure_reason or "no further detail available."
        return _result("FAILED", model_id, reason=f"The equilibrium solver did not converge: {reason}", diagnostics=diagnostics)

    # Equilibrium concentrations are computed from the *apparent* (concentration-based) constants
    # the root was actually found with -- the thermodynamic constants under the ideal model, or the
    # Davies-corrected ones at the converged ionic strength otherwise (see activity.py).
    solved_totals = activity_result.apparent_totals_at_convergence
    h = root.hydrogen_ion_molar
    oh = solved_totals.kw / h
    ph = -math.log10(h)
    poh = -math.log10(oh)

    eq_concentrations: list[EquilibriumSpeciesConcentration] = [
        EquilibriumSpeciesConcentration("water", "H+", h, water.evidence),
        EquilibriumSpeciesConcentration("water", "OH-", oh, water.evidence),
    ]
    mass_balance_resid: dict[str, float] = {}
    for sid, acid_system in zip(acid_system_ids, solved_totals.acid_systems):
        alphas = stepwise_distribution(h, acid_system.Ka_steps)
        n = len(acid_system.Ka_steps)
        for i, alpha in enumerate(alphas):
            eq_concentrations.append(EquilibriumSpeciesConcentration(sid, _form_label(i, n, is_acid=True), acid_system.molar * alpha, "MODEL_CALCULATED"))
        mass_balance_resid[sid] = sum(acid_system.molar * a for a in alphas) - acid_system.molar
    for sid, base_system in zip(base_system_ids, solved_totals.base_systems):
        alphas = stepwise_distribution(h, base_system.Ka_steps)
        n = len(base_system.Ka_steps)
        for i, alpha in enumerate(alphas):
            eq_concentrations.append(EquilibriumSpeciesConcentration(sid, _form_label(i, n, is_acid=False), base_system.molar * alpha, "MODEL_CALCULATED"))
        mass_balance_resid[sid] = sum(base_system.molar * a for a in alphas) - base_system.molar
    if solved_totals.strong_acid_molar > 0:
        eq_concentrations.append(EquilibriumSpeciesConcentration("strong_acid", "fully dissociated conjugate base (spectator anion)", solved_totals.strong_acid_molar, "MODEL_CALCULATED"))
    if solved_totals.strong_base_molar > 0:
        eq_concentrations.append(EquilibriumSpeciesConcentration("strong_base", "fully dissociated spectator cation", solved_totals.strong_base_molar, "MODEL_CALCULATED"))
    if solved_totals.extra_spectator_cation_molar > 0:
        eq_concentrations.append(EquilibriumSpeciesConcentration("extra_electrolyte", "spectator cation", solved_totals.extra_spectator_cation_molar, "MODEL_CALCULATED"))
    if solved_totals.extra_spectator_anion_molar > 0:
        eq_concentrations.append(EquilibriumSpeciesConcentration("extra_electrolyte", "spectator anion", solved_totals.extra_spectator_anion_molar, "MODEL_CALCULATED"))

    ionic_strength_value = activity_result.ionic_strength_molar
    warning_threshold = MAX_VALIDATED_IONIC_STRENGTH_MOLAR if resolved_assumptions.activity_model == "davies" else IONIC_STRENGTH_WARNING_THRESHOLD_MOLAR
    warnings: list[str] = list(activity_result.warnings)
    if resolved_assumptions.activity_model == "ideal" and ionic_strength_value > warning_threshold:
        warnings.append(
            f"Ionic strength is approximately {ionic_strength_value:.3g} mol/L, above the {warning_threshold:g} mol/L guide used here for the ideal-activity assumption; "
            "activity coefficients are not actually 1 at this ionic strength, so the computed pH is a less accurate approximation than at lower concentrations. "
            "Try assumptions={'activity_model': 'davies'} for a non-ideal correction."
        )
    if has_weak_system and abs(temperature_k - 298.15) > 1e-9:
        warnings.append(f"Temperature {temperature_k:.2f} K differs from the 25 degC (298.15 K) reference point of the tabulated Ka/Kb; see assumptions.")
    warnings.extend(water.warnings)

    diagnostics = SolveDiagnostics(
        charge_balance_residual_molar=root.residual,
        mass_balance_residuals_molar=mass_balance_resid,
        ionic_strength_molar=ionic_strength_value,
        root_finder_iterations=root.iterations,
        root_finder_function_calls=root.function_calls,
        root_finder_bracket_ph=root.bracket_ph,
        activity_model_iterations=activity_result.outer_iterations,
        input_hash=diagnostics.input_hash,
    )

    involved_evidence = [d.provenance.evidence for _, d in resolved if d.provenance is not None] + [water.evidence, "MODEL_CALCULATED"]

    reference_quantities = ReferenceQuantities(
        total_volume_l=volume_l,
        temperature_k=temperature_k,
        initial_analytical_concentrations_molar={sid: m / volume_l for sid, m in initial_moles_by_species.items()},
        kw=water.kw,
        pkw=-math.log10(water.kw),
    )

    numerical_uncertainty = NumericalUncertainty(
        ph_numerical_tolerance=1e-9,
        basis="Brent's method (scipy.optimize.brentq) convergence tolerance on pH; confirmed by re-evaluating the charge-balance residual at the root (see diagnostics.charge_balance_residual_molar).",
        limitations=(
            "Measurement uncertainties of the underlying Ka/Kw reference values are not propagated to a pH confidence interval.",
            "The Davies equation's own temperature dependence (its 'A' constant) is not modelled; the 25 degC value is used regardless of the solve temperature." if resolved_assumptions.activity_model == "davies"
            else "Non-ideal activity effects (ionic-strength corrections) are not modelled under the ideal activity model; see assumptions.",
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

