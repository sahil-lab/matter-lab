"""Core numerics: the mass-balance/electroneutrality master equation and its root.

Governing equations
--------------------
For a well-mixed aqueous solution containing, in general, one strong acid, one strong base, at
most one weak-acid system and at most one weak-base system (the v1 scope; `solver.py` enforces
the "at most one" part), mass balance for each weak system and the electroneutrality (charge
balance) condition combine into one equation in a single unknown, the free hydrogen-ion
concentration h = [H+]:

    G(h) = h + C_sb + C_wb * h/(h + Ka_wb) + C_cat,extra
         - Kw/h - C_sa - C_wa * Ka_wa/(Ka_wa + h) - C_an,extra  = 0

where
    C_sa, C_sb    total analytical concentration of strong acid / strong base (mol/L); a strong
                  acid or base is modelled as completely dissociated, so it contributes its full
                  concentration to the spectator anion (C_sa) or cation (C_sb) side and never to
                  an equilibrium term;
    C_wa, Ka_wa   total analytical concentration and acid dissociation constant of the (at most
                  one) weak-acid system; alpha_A- = Ka_wa / (Ka_wa + h) is the fraction present as
                  the conjugate base, by mass balance ([HA] + [A-] = C_wa, Ka_wa = h[A-]/[HA]);
    C_wb, Ka_wb   total analytical concentration of the (at most one) weak-base system and the
                  acid dissociation constant *of its conjugate acid* BH+; alpha_BH+ = h / (h +
                  Ka_wb) is the fraction present as BH+ ([B] + [BH+] = C_wb, Ka_wb = h[B]/[BH+]);
    C_cat,extra, C_an,extra  inert (non-equilibrating) spectator ion concentrations, e.g. the Na+ of
                  sodium acetate or the ions of a simple supporting electrolyte;
    Kw            ion product of water at the working temperature (see `water.py`).

G is strictly increasing in h on (0, infinity): d(h)/dh = 1 > 0, d(-Kw/h)/dh = Kw/h^2 > 0, each
d(C . Ka/(Ka+h))/dh term has a fixed sign (negative for the weak-acid term, positive for the
weak-base term, both strictly monotonic in h), so the equation has exactly one positive root for
any physically valid set of concentrations. That root is found by bracketing and Brent's method
(`scipy.optimize.brentq`) on pH = -log10(h), not by any hardcoded or interpolated curve; the
titration curve in `titration_curve.py` is this same root recomputed at each delivered volume.

This module is deliberately silent on what counts as a "valid" system (how many weak systems, what
concentration range); `solver.py` is responsible for that validation and for turning a classified
`ContainerContents`-like input into the `SystemTotals` this module consumes.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from scipy.optimize import brentq

from .constants import MIN_HYDROGEN_ION_MOLAR, PH_SEARCH_MAX, PH_SEARCH_MIN


@dataclass(frozen=True)
class SystemTotals:
    """Aggregated, pH-independent description of one aqueous mixture: exactly what the charge
    balance equation needs. Produced by `solver.py` from a validated species composition."""

    kw: float
    strong_acid_molar: float = 0.0
    strong_base_molar: float = 0.0
    weak_acid_system_molar: float = 0.0
    weak_acid_system_Ka: float | None = None
    weak_base_system_molar: float = 0.0
    weak_base_system_Ka_conjugate: float | None = None
    extra_spectator_cation_molar: float = 0.0
    extra_spectator_anion_molar: float = 0.0

    def __post_init__(self) -> None:
        for name in ("kw", "strong_acid_molar", "strong_base_molar", "weak_acid_system_molar", "weak_base_system_molar", "extra_spectator_cation_molar", "extra_spectator_anion_molar"):
            value = getattr(self, name)
            if not math.isfinite(value) or value < 0:
                raise ValueError(f"SystemTotals.{name} must be a non-negative finite number, got {value!r}.")
        if self.weak_acid_system_molar > 0 and (self.weak_acid_system_Ka is None or self.weak_acid_system_Ka <= 0):
            raise ValueError("weak_acid_system_molar > 0 requires a positive weak_acid_system_Ka.")
        if self.weak_base_system_molar > 0 and (self.weak_base_system_Ka_conjugate is None or self.weak_base_system_Ka_conjugate <= 0):
            raise ValueError("weak_base_system_molar > 0 requires a positive weak_base_system_Ka_conjugate.")


def charge_balance_residual(hydrogen_ion_molar: float, totals: SystemTotals) -> float:
    """G(h) of the module docstring; zero at equilibrium. Positive means an excess of cations at
    this trial [H+] (the trial pH is too low / too acidic); negative means an excess of anions
    (the trial pH is too high / too basic)."""
    h = hydrogen_ion_molar
    cation = h + totals.strong_base_molar + totals.extra_spectator_cation_molar
    if totals.weak_base_system_molar > 0:
        assert totals.weak_base_system_Ka_conjugate is not None
        cation += totals.weak_base_system_molar * (h / (h + totals.weak_base_system_Ka_conjugate))
    anion = (totals.kw / h) + totals.strong_acid_molar + totals.extra_spectator_anion_molar
    if totals.weak_acid_system_molar > 0:
        assert totals.weak_acid_system_Ka is not None
        anion += totals.weak_acid_system_molar * (totals.weak_acid_system_Ka / (totals.weak_acid_system_Ka + h))
    return cation - anion


@dataclass(frozen=True)
class RootFindResult:
    converged: bool
    hydrogen_ion_molar: float | None
    pH: float | None
    iterations: int
    function_calls: int
    residual: float | None
    bracket_ph: tuple[float, float]
    failure_reason: str | None = None


def solve_hydrogen_ion(totals: SystemTotals, *, ph_min: float = PH_SEARCH_MIN, ph_max: float = PH_SEARCH_MAX, xtol: float = 1e-13, rtol: float = 8.881784197001252e-16) -> RootFindResult:
    """The unique [H+] solving `charge_balance_residual(h, totals) == 0`, by bracketing plus
    Brent's method on pH = -log10(h) (scipy.optimize.brentq; converges without derivatives and
    without evaluating outside the bracket, unlike Newton's method, which matters because the
    model is only meaningful for h > 0).

    `ph_min`/`ph_max` bound the search; with `MAX_VALID_CONCENTRATION_MOLAR` enforced upstream
    (see `solver.py`), the default bracket (pH -3 to 20) always has a sign change, because
    [H+] = 10**3 mol/L at pH -3 and [OH-] = Kw/10**-20 mol/L at pH 20 both dominate any valid
    analytical concentration.
    """

    def residual_at_ph(ph: float) -> float:
        h = 10.0**-ph
        return charge_balance_residual(h, totals)

    f_min = residual_at_ph(ph_min)
    f_max = residual_at_ph(ph_max)
    calls = 2
    if not (math.isfinite(f_min) and math.isfinite(f_max)):
        return RootFindResult(False, None, None, 0, calls, None, (ph_min, ph_max), "The charge-balance residual is not finite at the search bracket's endpoints.")
    if f_min == 0.0:
        return RootFindResult(True, 10.0**-ph_min, ph_min, 0, calls, 0.0, (ph_min, ph_max))
    if f_max == 0.0:
        return RootFindResult(True, 10.0**-ph_max, ph_max, 0, calls, 0.0, (ph_min, ph_max))
    if (f_min > 0) == (f_max > 0):
        return RootFindResult(
            False,
            None,
            None,
            0,
            calls,
            None,
            (ph_min, ph_max),
            f"No sign change across pH {ph_min} to {ph_max} (residual {f_min:.6g} at pH {ph_min}, {f_max:.6g} at pH {ph_max}); "
            "the system's concentrations are too large for this search bracket, which should not happen for validated inputs.",
        )

    try:
        ph_root, results = brentq(residual_at_ph, ph_min, ph_max, xtol=xtol, rtol=rtol, maxiter=200, full_output=True)
    except (RuntimeError, ValueError) as exc:
        return RootFindResult(False, None, None, 0, calls, None, (ph_min, ph_max), f"Brent's method failed to converge: {exc}")

    h_root = 10.0**-ph_root
    residual = charge_balance_residual(h_root, totals)
    return RootFindResult(
        converged=bool(results.converged),
        hydrogen_ion_molar=max(h_root, MIN_HYDROGEN_ION_MOLAR),
        pH=ph_root,
        iterations=int(results.iterations),
        function_calls=int(results.function_calls) + calls,
        residual=float(residual),
        bracket_ph=(ph_min, ph_max),
    )
