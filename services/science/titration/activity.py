"""Non-ideal activity corrections: the Davies equation.

Governing model
----------------
Electroneutrality (charge balance) is exact in concentrations regardless of activity; only the
equilibrium "constants" (Ka, Kw) that `equilibrium.py` uses in the alpha/Z formulas change, because
they are properly defined in terms of activities (a = gamma . C), not concentrations. This module
supplies the correction factor and the self-consistent iteration that makes the whole solve use it.

**Davies equation** (an extended Debye-Huckel expression that needs only the ion's integer charge,
no ion-specific size parameter, unlike the full extended Debye-Huckel equation):

    log10(gamma_z) = -A . z^2 . ( sqrt(I)/(1 + sqrt(I)) - 0.3 . I )

`A = 0.509` at 25 degC (water); `I` is the ionic strength in mol/L. Commonly cited as usable up to
`I` of about 0.5 mol/L (`MAX_VALIDATED_IONIC_STRENGTH_MOLAR`); `solve_with_activity_model` warns,
but does not refuse, above that.

**Apparent (concentration-based) equilibrium constants.** For one dissociation step of an n-step
system, `HA^(j-1)- <=> H+ + A^j-` (so the species that has lost `j` protons carries charge `-j`):

    Ka_j,thermodynamic = a(H+) . a(A^j-) / a(HA^(j-1)-)
    Ka_j,apparent       = [H+] . [A^j-] / [HA^(j-1)-] = Ka_j,thermodynamic . gamma_(j-1) / (gamma_H . gamma_j)

Substituting the Davies expression (the neutral species always has gamma = 1, so only the charged
ones matter) gives, after the (j-1)^2, 1^2 and j^2 terms cancel:

    log10(Ka_j,apparent / Ka_j,thermodynamic) = 2 . A . f(I) . j,   f(I) = sqrt(I)/(1+sqrt(I)) - 0.3I

i.e. **larger ionic strength makes a weak acid appear to dissociate more** (`Ka_apparent >
Ka_thermodynamic`) -- the well-documented "salt effect" on weak-electrolyte dissociation, not an
artefact of this derivation. The same substitution for water autoionization (`H2O <=> H+ + OH-`,
both ions singly charged) gives `Kw_apparent = Kw_thermodynamic . 10^(2 A f(I))`.

**Self-consistent solve.** Because `I` depends on the equilibrium concentrations, which depend on
the apparent constants, which depend on `I`, `solve_with_activity_model` iterates: solve with the
current apparent constants, recompute `I` from the result, rebuild the apparent constants, repeat
until `I` stops changing (a fixed-point/Picard iteration; converges in a handful of steps for the
smooth, bounded Davies correction over the concentration ranges this package validates).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from .equilibrium import RootFindResult, SystemTotals, WeakSystem, ionic_strength, solve_hydrogen_ion

#: Debye-Huckel/Davies constant for water at 25 degC. Its own (small) temperature dependence is not
#: modelled: a documented limitation, not a silent inaccuracy (see README Section 6).
DAVIES_A_298_15K = 0.509

#: Ionic strength above which the Davies equation is widely regarded as an increasingly uncertain
#: extrapolation rather than a validated correction.
MAX_VALIDATED_IONIC_STRENGTH_MOLAR = 0.5

MAX_OUTER_ITERATIONS = 50
OUTER_TOLERANCE_MOLAR = 1e-10


def _davies_f(ionic_strength_molar: float) -> float:
    sqrt_i = math.sqrt(max(ionic_strength_molar, 0.0))
    return sqrt_i / (1.0 + sqrt_i) - 0.3 * ionic_strength_molar


def davies_log_gamma(charge: int, ionic_strength_molar: float, *, A: float = DAVIES_A_298_15K) -> float:
    """log10(activity coefficient) of an ion of the given integer charge (0 for a neutral species,
    which always has gamma = 1 in this model)."""
    if charge == 0:
        return 0.0
    return -A * (charge * charge) * _davies_f(ionic_strength_molar)


def davies_gamma(charge: int, ionic_strength_molar: float, *, A: float = DAVIES_A_298_15K) -> float:
    return 10.0 ** davies_log_gamma(charge, ionic_strength_molar, A=A)


def _apparent_weak_system(system: WeakSystem, ionic_strength_molar: float, A: float) -> WeakSystem:
    f = _davies_f(ionic_strength_molar)
    adjusted = tuple(ka * 10.0 ** (2.0 * A * f * step_number) for step_number, ka in enumerate(system.Ka_steps, start=1))
    return WeakSystem(molar=system.molar, Ka_steps=adjusted)


def apparent_totals(totals_thermodynamic: SystemTotals, ionic_strength_molar: float, *, A: float = DAVIES_A_298_15K) -> SystemTotals:
    """`totals_thermodynamic` with every Ka and Kw replaced by its Davies-corrected, apparent
    (concentration-based) value at `ionic_strength_molar`. At `I = 0` this is the identity (every
    correction factor is `10**0 = 1`)."""
    f = _davies_f(ionic_strength_molar)
    return SystemTotals(
        kw=totals_thermodynamic.kw * 10.0 ** (2.0 * A * f),
        strong_acid_molar=totals_thermodynamic.strong_acid_molar,
        strong_base_molar=totals_thermodynamic.strong_base_molar,
        acid_systems=tuple(_apparent_weak_system(s, ionic_strength_molar, A) for s in totals_thermodynamic.acid_systems),
        base_systems=tuple(_apparent_weak_system(s, ionic_strength_molar, A) for s in totals_thermodynamic.base_systems),
        extra_spectator_cation_molar=totals_thermodynamic.extra_spectator_cation_molar,
        extra_spectator_anion_molar=totals_thermodynamic.extra_spectator_anion_molar,
    )


@dataclass(frozen=True)
class ActivityCorrectedResult:
    root: RootFindResult
    """The final root, found using `apparent_totals_at_convergence`."""
    apparent_totals_at_convergence: SystemTotals
    """`totals_thermodynamic` with Ka/Kw replaced by their values at the converged ionic strength;
    use *this* (not the thermodynamic input) to compute equilibrium concentrations from the root,
    since apparent constants are concentration-based by construction."""
    ionic_strength_molar: float
    outer_iterations: int
    converged: bool
    warnings: tuple[str, ...] = ()
    failure_reason: str | None = None


def solve_with_activity_model(totals_thermodynamic: SystemTotals, activity_model: str, *, A: float = DAVIES_A_298_15K) -> ActivityCorrectedResult:
    """Solves `totals_thermodynamic` under the named activity model.

    `activity_model = "ideal"`: a single solve with the thermodynamic constants used directly as
    concentration-based ones (activity = concentration); `ionic_strength_molar` is still computed
    and returned, purely as a diagnostic (the brief's "track ionic strength applicability").

    `activity_model = "davies"`: the self-consistent iteration described in the module docstring.

    @raises ValueError for any other `activity_model` (callers validate this before reaching here;
    this is a defensive check, not the primary validation path -- see `solver.py`).
    """
    if activity_model == "ideal":
        root = solve_hydrogen_ion(totals_thermodynamic)
        i_value = ionic_strength(root.hydrogen_ion_molar, totals_thermodynamic) if root.converged and root.hydrogen_ion_molar is not None else 0.0
        return ActivityCorrectedResult(root=root, apparent_totals_at_convergence=totals_thermodynamic, ionic_strength_molar=i_value, outer_iterations=0, converged=root.converged)
    if activity_model != "davies":
        raise ValueError(f"Unknown activity model {activity_model!r}; expected 'ideal' or 'davies'.")

    i_value = 0.0
    current = totals_thermodynamic  # I = 0 => apparent_totals(..., 0) would be identical; skip the no-op call
    for outer in range(1, MAX_OUTER_ITERATIONS + 1):
        root = solve_hydrogen_ion(current)
        if not root.converged or root.hydrogen_ion_molar is None:
            return ActivityCorrectedResult(
                root=root, apparent_totals_at_convergence=current, ionic_strength_molar=i_value, outer_iterations=outer, converged=False, failure_reason=root.failure_reason
            )
        new_i = ionic_strength(root.hydrogen_ion_molar, current)
        if abs(new_i - i_value) < OUTER_TOLERANCE_MOLAR:
            i_value = new_i
            break
        i_value = new_i
        current = apparent_totals(totals_thermodynamic, i_value, A=A)
    else:
        return ActivityCorrectedResult(
            root=root,
            apparent_totals_at_convergence=current,
            ionic_strength_molar=i_value,
            outer_iterations=MAX_OUTER_ITERATIONS,
            converged=False,
            failure_reason=f"The Davies self-consistent ionic-strength iteration did not converge within {MAX_OUTER_ITERATIONS} outer iterations.",
        )

    warnings: tuple[str, ...] = ()
    if i_value > MAX_VALIDATED_IONIC_STRENGTH_MOLAR:
        warnings = (
            (
                f"Ionic strength {i_value:.3g} mol/L exceeds the Davies equation's commonly cited validity ceiling ({MAX_VALIDATED_IONIC_STRENGTH_MOLAR:g} mol/L); "
                "the activity correction above that is an increasingly uncertain extrapolation, not a validated one."
            ),
        )
    return ActivityCorrectedResult(root=root, apparent_totals_at_convergence=current, ionic_strength_molar=i_value, outer_iterations=outer, converged=True, warnings=warnings)
