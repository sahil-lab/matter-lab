"""Core numerics of the titration engine: the charge-balance master equation and its root.

Pure-Python tests: no PostgreSQL, no FastAPI, no RDKit. See `services/science/titration/README.md`
for the governing equations these tests check.
"""

from __future__ import annotations

import math

import pytest

from titration.equilibrium import SystemTotals, charge_balance_residual, solve_hydrogen_ion
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
    together -- out of the solver's validated scope chemically, but a valid stress test of the
    bare numerics, which make no scope decisions themselves)."""
    totals = SystemTotals(
        kw=1e-14,
        strong_acid_molar=0.02,
        strong_base_molar=0.01,
        weak_acid_system_molar=0.05,
        weak_acid_system_Ka=1.75e-5,
        weak_base_system_molar=0.03,
        weak_base_system_Ka_conjugate=5.6e-10,
        extra_spectator_cation_molar=0.01,
        extra_spectator_anion_molar=0.02,
    )
    hs = sorted(10.0**-ph for ph in [-2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
    residuals = [charge_balance_residual(h, totals) for h in hs]
    for earlier, later in zip(residuals, residuals[1:]):
        assert later > earlier, (hs, residuals)


def test_root_finder_residual_is_near_zero_at_convergence() -> None:
    totals = SystemTotals(kw=1e-14, weak_acid_system_molar=0.2, weak_acid_system_Ka=1.75e-5, strong_base_molar=0.05)
    root = solve_hydrogen_ion(totals)
    assert root.converged
    assert root.residual == pytest.approx(0.0, abs=1e-9)
    assert charge_balance_residual(root.hydrogen_ion_molar, totals) == pytest.approx(0.0, abs=1e-9)


def test_root_finder_is_deterministic() -> None:
    totals = SystemTotals(kw=1e-14, weak_acid_system_molar=0.0667, weak_acid_system_Ka=1.75e-5, strong_base_molar=0.0333)
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
    totals = SystemTotals(kw=1e-14, weak_acid_system_molar=c_total, weak_acid_system_Ka=Ka, strong_base_molar=c_total / 2.0)
    root = solve_hydrogen_ion(totals)
    assert root.converged
    assert root.pH == pytest.approx(pKa, abs=0.01)


def test_system_totals_rejects_invalid_values() -> None:
    with pytest.raises(ValueError):
        SystemTotals(kw=-1e-14)
    with pytest.raises(ValueError):
        SystemTotals(kw=1e-14, strong_acid_molar=-0.1)
    with pytest.raises(ValueError):
        SystemTotals(kw=1e-14, weak_acid_system_molar=0.1, weak_acid_system_Ka=None)
    with pytest.raises(ValueError):
        SystemTotals(kw=1e-14, weak_base_system_molar=0.1, weak_base_system_Ka_conjugate=0.0)


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
