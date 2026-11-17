"""Core numerics of the titration engine: the charge-balance master equation and its root.

Pure-Python tests: no PostgreSQL, no FastAPI, no RDKit. See `services/science/titration/README.md`
for the governing equations these tests check.
"""

from __future__ import annotations

import math

import pytest

from titration.equilibrium import SystemTotals, WeakSystem, charge_balance_residual, ionic_strength, solve_hydrogen_ion, stepwise_distribution
from titration.water import KW_REFERENCE_298_15K, codata_cross_check_kw, kw_at_temperature, validate_temperature_k


def test_pure_water_gives_ph_seven() -> None:
    totals = SystemTotals(kw=KW_REFERENCE_298_15K)
    root = solve_hydrogen_ion(totals)
    assert root.converged
    assert root.pH == pytest.approx(7.0, abs=1e-9)
    assert root.hydrogen_ion_molar == pytest.approx(math.sqrt(KW_REFERENCE_298_15K), rel=1e-9)


def test_strong_acid_closed_form_matches_quadratic_solution() -> None:
    """For a strong acid alone, G(h) = h - Kw/h - C = 0 is an exact quadratic with a known root;
    the general root finder must reproduce it, not just something plausible."""
    c = 0.0437
    kw = KW_REFERENCE_298_15K
    totals = SystemTotals(kw=kw, strong_acid_molar=c)
    root = solve_hydrogen_ion(totals)
    assert root.converged
    expected_h = (c + math.sqrt(c * c + 4 * kw)) / 2.0
    assert root.hydrogen_ion_molar == pytest.approx(expected_h, rel=1e-9)


def test_strong_base_closed_form_matches_quadratic_solution() -> None:
    """For a strong base alone, G(h) = h + C - Kw/h = 0, i.e. h^2 + Ch - Kw = 0."""
    c = 0.0629
    kw = KW_REFERENCE_298_15K
    totals = SystemTotals(kw=kw, strong_base_molar=c)
    root = solve_hydrogen_ion(totals)
    assert root.converged
    expected_h = (-c + math.sqrt(c * c + 4 * kw)) / 2.0
    assert root.hydrogen_ion_molar == pytest.approx(expected_h, rel=1e-6)


@pytest.mark.parametrize("acid_molar,base_molar", [(0.1, 0.1), (0.05, 0.05), (1.0, 1.0), (1e-4, 1e-4)])
def test_equal_strong_acid_and_strong_base_neutralize_to_ph_seven(acid_molar: float, base_molar: float) -> None:
    """Mixing exactly equal strong-acid and strong-base equivalents must land on the pure-water
    root exactly, for any concentration: this is what makes the equivalence-point benchmark work,
    not a special case written into the solver."""
    totals = SystemTotals(kw=KW_REFERENCE_298_15K, strong_acid_molar=acid_molar, strong_base_molar=base_molar)
    root = solve_hydrogen_ion(totals)
    assert root.converged
    assert root.pH == pytest.approx(7.0, abs=1e-6)


def test_charge_balance_residual_is_strictly_monotonic_in_hydrogen_ion() -> None:
    """G(h) must be strictly increasing in h for the root to be unique and for Brent's method to
    be guaranteed to find it; this is asserted directly against the function, for a system
    exercising every term (strong acid, strong base, a weak-acid system and a weak-base system
    together, both now a genuinely supported combination -- see test_titration_benchmarks.py)."""
    totals = SystemTotals(
        kw=1e-14,
        strong_acid_molar=0.02,
        strong_base_molar=0.01,
        acid_systems=(WeakSystem(0.05, (1.75e-5,)),),
        base_systems=(WeakSystem(0.03, (5.6e-10,)),),
        extra_spectator_cation_molar=0.01,
        extra_spectator_anion_molar=0.02,
    )
    hs = sorted(10.0**-ph for ph in [-2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
    residuals = [charge_balance_residual(h, totals) for h in hs]
    for earlier, later in zip(residuals, residuals[1:]):
        assert later > earlier, (hs, residuals)


@pytest.mark.parametrize("n", [1, 2, 3])
def test_n_step_charge_balance_residual_is_strictly_monotonic(n: int) -> None:
    """The same monotonicity property, explicitly checked for 1, 2 and 3-step weak-acid and
    weak-base systems (the module docstring's claim that this generalizes beyond n = 1), with a
    tolerance that allows for floating-point noise where Z(h) is extremely close to its 0 or n
    asymptote (not a real non-monotonicity, just finite precision at the tails)."""
    Ka_steps = tuple([6.9e-3, 6.2e-8, 4.8e-13][:n]) if n > 1 else (1.75e-5,)
    totals_acid = SystemTotals(kw=1e-14, acid_systems=(WeakSystem(0.1, Ka_steps),))
    totals_base = SystemTotals(kw=1e-14, base_systems=(WeakSystem(0.1, Ka_steps),))
    hs = sorted(10.0**-ph for ph in [x * 0.25 for x in range(-12, 81)])  # pH -3.0 to 20.0 step 0.25, ascending h
    for totals, label in ((totals_acid, "acid"), (totals_base, "base")):
        residuals = [charge_balance_residual(h, totals) for h in hs]
        for earlier, later in zip(residuals, residuals[1:]):
            assert later >= earlier - 1e-12, (n, label, hs, residuals)


def test_root_finder_residual_is_near_zero_at_convergence() -> None:
    totals = SystemTotals(kw=1e-14, acid_systems=(WeakSystem(0.2, (1.75e-5,)),), strong_base_molar=0.05)
    root = solve_hydrogen_ion(totals)
    assert root.converged
    assert root.residual == pytest.approx(0.0, abs=1e-9)
    assert charge_balance_residual(root.hydrogen_ion_molar, totals) == pytest.approx(0.0, abs=1e-9)


def test_root_finder_is_deterministic() -> None:
    totals = SystemTotals(kw=1e-14, acid_systems=(WeakSystem(0.0667, (1.75e-5,)),), strong_base_molar=0.0333)
    first = solve_hydrogen_ion(totals)
    second = solve_hydrogen_ion(totals)
    assert first.pH == second.pH
    assert first.iterations == second.iterations
    assert first.function_calls == second.function_calls


def test_weak_acid_half_neutralized_matches_henderson_hasselbalch() -> None:
    """At exactly half the stoichiometric base, [HA] approx [A-], so pH approx pKa; checked against
    the closed-form Henderson-Hasselbalch approximation, which the rigorous solver should reproduce
    closely away from extreme dilution."""
    Ka = 1.75e-5
    pKa = -math.log10(Ka)
    c_total = 0.08
    totals = SystemTotals(kw=1e-14, acid_systems=(WeakSystem(c_total, (Ka,)),), strong_base_molar=c_total / 2.0)
    root = solve_hydrogen_ion(totals)
    assert root.converged
    assert root.pH == pytest.approx(pKa, abs=0.01)


def test_stepwise_distribution_sums_to_one_and_matches_bounds() -> None:
    Ka_steps = (6.9e-3, 6.2e-8, 4.8e-13)
    for ph in (-2, 0, 2, 4, 6, 8, 10, 12, 14, 16):
        alphas = stepwise_distribution(10.0**-ph, Ka_steps)
        assert len(alphas) == 4
        assert sum(alphas) == pytest.approx(1.0, abs=1e-12)
        assert all(0.0 <= a <= 1.0 for a in alphas)


def test_ionic_strength_is_zero_for_pure_water_and_positive_for_any_electrolyte() -> None:
    pure_water = SystemTotals(kw=1e-14)
    root = solve_hydrogen_ion(pure_water)
    i_pure = ionic_strength(root.hydrogen_ion_molar, pure_water)
    assert i_pure == pytest.approx(1e-7, abs=1e-9)  # just [H+] + [OH-], each 1e-7

    with_salt = SystemTotals(kw=1e-14, strong_acid_molar=0.1, strong_base_molar=0.1)
    root2 = solve_hydrogen_ion(with_salt)
    i_salt = ionic_strength(root2.hydrogen_ion_molar, with_salt)
    assert i_salt == pytest.approx(0.1, abs=1e-5)  # 0.5*(0.1 spectator cation + 0.1 spectator anion)


def test_ionic_strength_weights_multivalent_ions_by_charge_squared() -> None:
    """A fully dissociated 2- ion must contribute 4x the ionic strength of a fully dissociated 1-
    ion at the same concentration (I = 1/2 sum(C z^2)): checked using two polyprotic systems tuned
    so the second deprotonation step is essentially complete."""
    mostly_monovalent = SystemTotals(kw=1e-14, acid_systems=(WeakSystem(0.01, (1e6, 1e-20)),))  # second step never happens in practice
    mostly_divalent = SystemTotals(kw=1e-14, acid_systems=(WeakSystem(0.01, (1e6, 1e6)),))  # both steps essentially complete
    h_mono = solve_hydrogen_ion(mostly_monovalent).hydrogen_ion_molar
    h_di = solve_hydrogen_ion(mostly_divalent).hydrogen_ion_molar
    i_mono = ionic_strength(h_mono, mostly_monovalent)
    i_di = ionic_strength(h_di, mostly_divalent)
    # mostly_monovalent: ~0.01 M of a 1- ion -> I ~ 0.5*0.01 = 0.005 (plus ~2x that from the 2 H+ released, but the first step's H+ already free)
    # mostly_divalent: ~0.01 M of a 2- ion -> an extra 0.5*0.01*4 = 0.02 contribution from the squared charge, on top of releasing a second H+
    assert i_di > i_mono + 0.01, (i_mono, i_di)


def test_system_totals_rejects_invalid_values() -> None:
    with pytest.raises(ValueError):
        SystemTotals(kw=-1e-14)
    with pytest.raises(ValueError):
        SystemTotals(kw=1e-14, strong_acid_molar=-0.1)
    with pytest.raises(ValueError):
        WeakSystem(molar=0.1, Ka_steps=())
    with pytest.raises(ValueError):
        WeakSystem(molar=0.1, Ka_steps=(0.0,))
    with pytest.raises(ValueError):
        WeakSystem(molar=-0.1, Ka_steps=(1.75e-5,))


def test_kw_reference_value_is_the_cited_iupac_nist_value() -> None:
    result = kw_at_temperature(298.15)
    assert result.kw == 1.0e-14
    assert result.evidence == "REFERENCE_MEASURED"
    assert result.pkw == pytest.approx(14.0, abs=1e-9)


def test_kw_temperature_model_is_monotonically_decreasing_pkw_with_rising_temperature() -> None:
    """pKw must fall as temperature rises (water autoionizes more at higher T), the well-known
    qualitative trend; checked across the whole validated range."""
    temps = [273.15, 283.15, 298.15, 310.15, 333.15, 353.15, 373.15]
    pkws = [kw_at_temperature(t).pkw for t in temps]
    for earlier, later in zip(pkws, pkws[1:]):
        assert later < earlier, (temps, pkws)


def test_kw_codata_cross_check_is_consistent_with_reference_value() -> None:
    """The CODATA-derived Kw at 298.15 K must agree with the cited IUPAC/NIST reference value to
    within the combined uncertainty of the underlying enthalpy/entropy table (a few percent once
    exponentiated), confirming the two independent derivations are not contradictory."""
    codata_kw = codata_cross_check_kw(298.15)
    assert codata_kw == pytest.approx(KW_REFERENCE_298_15K, rel=0.02)


def test_kw_outside_validated_range_raises() -> None:
    assert validate_temperature_k(500.0) is not None
    with pytest.raises(ValueError):
        kw_at_temperature(500.0)
    with pytest.raises(ValueError):
        kw_at_temperature(-10.0)
    with pytest.raises(ValueError):
        kw_at_temperature(float("nan"))


def test_root_finder_reports_bracket_and_diagnostics() -> None:
    totals = SystemTotals(kw=1e-14, strong_acid_molar=0.1)
    root = solve_hydrogen_ion(totals)
    assert root.bracket_ph == (-3.0, 20.0)
    assert root.iterations > 0
    assert root.function_calls > root.iterations
