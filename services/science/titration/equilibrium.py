"""Core numerics: the mass-balance/electroneutrality master equation and its root.

Governing equations
--------------------
For a well-mixed aqueous solution containing a strong acid, a strong base, any number of distinct
weak-acid systems and any number of distinct weak-base systems -- each of which may itself be
monoprotic or polyprotic (n >= 1 acidic/basic sites with stepwise dissociation constants) -- mass
balance for every weak system and electroneutrality (charge balance) combine into one equation in
a single unknown, the free hydrogen-ion concentration h = [H+]:

    G(h) = h + C_sb + C_an,extra + sum_j C_wb,j * Z_base(h, Ka_steps_wb,j)
         - Kw/h - C_sa - C_cat,extra - sum_i C_wa,i * Z_acid(h, Ka_steps_wa,i)   = 0

| Symbol | Meaning |
|---|---|
| `C_sa`, `C_sb` | Total analytical concentration (mol/L) of strong acid / strong base. Modelled as completely dissociated: contributes its full concentration as a spectator ion, never through an equilibrium term. |
| `C_wa,i`, `Ka_steps_wa,i` | Total analytical concentration and the ordered stepwise acid dissociation constants (Ka1, ..., Kan) of weak-acid system `i`. |
| `C_wb,j`, `Ka_steps_wb,j` | Total analytical concentration of weak-base system `j` and the stepwise acid dissociation constants *of its conjugate acid* (most-protonated form first). |
| `C_cat,extra`, `C_an,extra` | Inert (non-equilibrating) spectator ion concentrations, e.g. the Na+ of sodium acetate, or a simple supporting electrolyte. |
| `Kw` | Ion product of water at the working temperature (`water.py`). |

### The n-step distribution function Z

For an n-protic weak-acid system with stepwise constants `Ka_1, ..., Ka_n` (H_nA -> H_(n-1)A^- +
H+ is `Ka_1`, and so on), define the cumulative products `beta_0 = 1`, `beta_i = Ka_1 . Ka_2 ... Ka_i`
and the distribution polynomial

    D(h) = sum_{i=0}^{n} beta_i . h^(n-i)
    alpha_i(h) = beta_i . h^(n-i) / D(h)        (fraction present with i protons removed, i = 0..n)

`Z_acid(h) = sum_{i=0}^{n} i . alpha_i(h)` is the mean number of protons the system has lost at a
given h -- the "bound proton deficiency function" of systematic equilibrium treatments (see e.g.
Butler, *Ionic Equilibrium*). It ranges from 0 (h -> infinity, fully protonated) to n (h -> 0, fully
deprotonated) and is **strictly monotonically decreasing in h** for any positive Ka_1..Ka_n (proved
below); for `n = 1` it reduces exactly to the familiar `alpha_A- = Ka_1/(Ka_1 + h)`.

A weak-base system is handled by the *same* function applied to its conjugate acid's stepwise
constants (most-protonated form first): `Z_base(h, Ka_steps) = n - Z_acid(h, Ka_steps)`, which
ranges from n (h -> infinity, fully protonated, maximally cationic) to 0 (h -> 0) and is strictly
**increasing** in h. For `n = 1` this reduces to `alpha_BH+ = h/(h + Ka_conjugate)`.

### Why G is still guaranteed to have exactly one root

`d(h)/dh = 1 > 0` and `d(-Kw/h)/dh = Kw/h^2 > 0` as before. Each `Z_acid` term is monotonically
*decreasing* in h (so each `-C . Z_acid(h)` term is monotonically *increasing*) and each `Z_base`
term is monotonically *increasing* in h -- both proved by induction on n via the classical result
that the n-step distribution's mean ionization is monotonic in h for any ladder of positive
equilibrium constants (equivalently: `D(h)` has only positive coefficients in descending powers of
h, so `-d(ln D)/d(ln h)` is bounded and monotonic). `services/science/tests/test_titration_equilibrium.py`
checks this numerically for n = 1, 2 and 3 systems, not only asserts it. `G` therefore remains
strictly increasing in h for *any* combination of strong/weak/polyprotic systems, so bracketing
plus Brent's method (`scipy.optimize.brentq`) on pH = -log10(h) always finds the one root -- never
a hardcoded or interpolated curve.

This module is deliberately silent on what counts as a "valid" system (how many weak systems are
allowed together, what concentration range); `solver.py` is responsible for that validation and for
turning a classified species composition into the `SystemTotals` this module consumes.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from scipy.optimize import brentq

from .constants import MIN_HYDROGEN_ION_MOLAR, PH_SEARCH_MAX, PH_SEARCH_MIN


@dataclass(frozen=True)
class WeakSystem:
    """One weak-acid or weak-base system: a total analytical concentration and its ordered
    stepwise acid dissociation constants (`Ka_steps`; for a base, those of its conjugate acid,
    most-protonated form first). `len(Ka_steps)` is the number of acidic/basic sites (1 for a
    monoprotic system)."""

    molar: float
    Ka_steps: tuple[float, ...]

    def __post_init__(self) -> None:
        if not math.isfinite(self.molar) or self.molar < 0:
            raise ValueError(f"WeakSystem.molar must be a non-negative finite number, got {self.molar!r}.")
        if not self.Ka_steps:
            raise ValueError("WeakSystem.Ka_steps must have at least one value.")
        for ka in self.Ka_steps:
            if not math.isfinite(ka) or ka <= 0:
                raise ValueError(f"WeakSystem.Ka_steps must all be positive finite numbers, got {self.Ka_steps!r}.")


def stepwise_distribution(hydrogen_ion_molar: float, Ka_steps: tuple[float, ...]) -> tuple[float, ...]:
    """`alpha_0, ..., alpha_n` (n = len(Ka_steps)): the fraction of an n-step system present in
    each successively deprotonated form at the given [H+]. Always sums to 1."""
    n = len(Ka_steps)
    betas = [1.0]
    for ka in Ka_steps:
        betas.append(betas[-1] * ka)
    h = hydrogen_ion_molar
    terms = [betas[i] * h ** (n - i) for i in range(n + 1)]
    total = sum(terms)
    return tuple(t / total for t in terms)


def acid_charge_number(hydrogen_ion_molar: float, Ka_steps: tuple[float, ...]) -> float:
    """Z_acid(h): mean protons lost (0..n), strictly decreasing in h. See module docstring."""
    alphas = stepwise_distribution(hydrogen_ion_molar, Ka_steps)
    return sum(i * a for i, a in enumerate(alphas))


def base_charge_number(hydrogen_ion_molar: float, Ka_steps: tuple[float, ...]) -> float:
    """Z_base(h) = n - Z_acid(h): mean protons bound to a weak-base system (0..n), strictly
    increasing in h. `Ka_steps` are the conjugate acid's stepwise constants."""
    return len(Ka_steps) - acid_charge_number(hydrogen_ion_molar, Ka_steps)


@dataclass(frozen=True)
class SystemTotals:
    """Aggregated, pH-independent description of one aqueous mixture: exactly what the charge
    balance equation needs. Produced by `solver.py` from a validated species composition."""

    kw: float
    strong_acid_molar: float = 0.0
    strong_base_molar: float = 0.0
    acid_systems: tuple[WeakSystem, ...] = ()
    base_systems: tuple[WeakSystem, ...] = ()
    extra_spectator_cation_molar: float = 0.0
    extra_spectator_anion_molar: float = 0.0

    def __post_init__(self) -> None:
        for name in ("kw", "strong_acid_molar", "strong_base_molar", "extra_spectator_cation_molar", "extra_spectator_anion_molar"):
            value = getattr(self, name)
            if not math.isfinite(value) or value < 0:
                raise ValueError(f"SystemTotals.{name} must be a non-negative finite number, got {value!r}.")
        # WeakSystem.__post_init__ already validated each system; nothing further to check here.


def charge_balance_residual(hydrogen_ion_molar: float, totals: SystemTotals) -> float:
    """G(h) of the module docstring; zero at equilibrium. Positive means an excess of cations at
    this trial [H+] (the trial pH is too low / too acidic); negative means an excess of anions
    (the trial pH is too high / too basic)."""
    h = hydrogen_ion_molar
    cation = h + totals.strong_base_molar + totals.extra_spectator_cation_molar
    for base in totals.base_systems:
        cation += base.molar * base_charge_number(h, base.Ka_steps)
    anion = (totals.kw / h) + totals.strong_acid_molar + totals.extra_spectator_anion_molar
    for acid in totals.acid_systems:
        anion += acid.molar * acid_charge_number(h, acid.Ka_steps)
    return cation - anion


def ionic_strength(hydrogen_ion_molar: float, totals: SystemTotals) -> float:
    """I = 1/2 . sum(C_i . z_i^2) over every ion present at equilibrium, including every
    protonation state of every weak system with its correct integer charge -- not the "monovalent
    only" shortcut (half the sum of concentrations) that was sufficient before polyprotic systems
    were supported. Used both for the ideal-model diagnostic reported to callers and, by
    `activity.py`, as the state variable of the Davies-equation self-consistent iteration."""
    h = hydrogen_ion_molar
    terms = [h, totals.kw / h, totals.strong_acid_molar, totals.strong_base_molar, totals.extra_spectator_cation_molar, totals.extra_spectator_anion_molar]
    for acid in totals.acid_systems:
        alphas = stepwise_distribution(h, acid.Ka_steps)
        terms.extend(acid.molar * alphas[i] * i * i for i in range(1, len(acid.Ka_steps) + 1))
    for base in totals.base_systems:
        n = len(base.Ka_steps)
        alphas = stepwise_distribution(h, base.Ka_steps)
        # alpha_i is the conjugate acid's i-deprotonated state (i = 0..n); its actual charge on the
        # base system is (n - i) (i = 0 is the fully protonated, most cationic form).
        terms.extend(base.molar * alphas[i] * (n - i) * (n - i) for i in range(n))
    return 0.5 * sum(terms)


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
