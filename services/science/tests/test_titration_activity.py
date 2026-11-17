"""Non-ideal activity corrections: the Davies equation (`titration/activity.py`).

Pure-Python tests: no PostgreSQL, no FastAPI, no RDKit.
"""

from __future__ import annotations

import math

import pytest

from titration.activity import (
    DAVIES_A_298_15K,
    MAX_VALIDATED_IONIC_STRENGTH_MOLAR,
    apparent_totals,
    davies_gamma,
    davies_log_gamma,
    solve_with_activity_model,
)
from titration.equilibrium import SystemTotals, WeakSystem, ionic_strength


def test_davies_gamma_is_one_for_a_neutral_species_at_any_ionic_strength() -> None:
    for i_value in (0.0, 0.01, 0.1, 1.0):
        assert davies_gamma(0, i_value) == 1.0


def test_davies_gamma_is_one_at_zero_ionic_strength_for_any_charge() -> None:
    for z in (1, 2, 3, -1, -2):
        assert davies_gamma(z, 0.0) == pytest.approx(1.0, abs=1e-12)


def test_davies_gamma_decreases_with_ionic_strength_then_the_correction_grows_with_charge_squared() -> None:
    """Activity coefficients must fall below 1 as ionic strength rises (real ions are less
    "active" than their concentration alone suggests), and a doubly charged ion's coefficient must
    fall further than a singly charged one's, because the Davies correction scales with z^2."""
    i_value = 0.1
    gamma_1 = davies_gamma(1, i_value)
    gamma_2 = davies_gamma(2, i_value)
    assert 0.0 < gamma_1 < 1.0
    assert 0.0 < gamma_2 < gamma_1
    # log10(gamma) scales exactly as z^2 at fixed ionic strength
    assert davies_log_gamma(2, i_value) == pytest.approx(4.0 * davies_log_gamma(1, i_value), rel=1e-12)


def test_apparent_totals_is_the_identity_at_zero_ionic_strength() -> None:
    thermo = SystemTotals(kw=1e-14, strong_acid_molar=0.01, acid_systems=(WeakSystem(0.1, (1.75e-5,)),), base_systems=(WeakSystem(0.05, (5.6e-10,)),))
    apparent = apparent_totals(thermo, 0.0)
    assert apparent.kw == pytest.approx(thermo.kw, rel=1e-12)
    assert apparent.acid_systems[0].Ka_steps == pytest.approx(thermo.acid_systems[0].Ka_steps, rel=1e-12)
    assert apparent.base_systems[0].Ka_steps == pytest.approx(thermo.base_systems[0].Ka_steps, rel=1e-12)


def test_apparent_ka_increases_with_ionic_strength_the_salt_effect() -> None:
    """A real, documented phenomenon (not an artefact): raising ionic strength makes a weak acid
    appear to dissociate more (Ka_apparent > Ka_thermodynamic), because the charged product ions
    are stabilized more than the neutral reactant."""
    thermo = SystemTotals(kw=1e-14, acid_systems=(WeakSystem(0.1, (1.75e-5,)),))
    apparent_low = apparent_totals(thermo, 0.01)
    apparent_high = apparent_totals(thermo, 0.1)
    ka_thermo = thermo.acid_systems[0].Ka_steps[0]
    ka_low = apparent_low.acid_systems[0].Ka_steps[0]
    ka_high = apparent_high.acid_systems[0].Ka_steps[0]
    assert ka_thermo < ka_low < ka_high


def test_apparent_kw_increases_with_ionic_strength() -> None:
    thermo = SystemTotals(kw=1e-14)
    apparent = apparent_totals(thermo, 0.1)
    assert apparent.kw > thermo.kw


def test_second_dissociation_step_gets_a_stronger_correction_than_the_first() -> None:
    """Step j of an n-step system picks up a factor of 2*A*f(I)*j in log10(Ka); the second step
    (j = 2, involving ions of charge magnitude up to 2) must shift more than the first (j = 1)."""
    thermo = SystemTotals(kw=1e-14, acid_systems=(WeakSystem(0.1, (6.9e-3, 6.2e-8)),))
    apparent = apparent_totals(thermo, 0.1)
    shift_1 = math.log10(apparent.acid_systems[0].Ka_steps[0] / thermo.acid_systems[0].Ka_steps[0])
    shift_2 = math.log10(apparent.acid_systems[0].Ka_steps[1] / thermo.acid_systems[0].Ka_steps[1])
    assert shift_2 == pytest.approx(2.0 * shift_1, rel=1e-9)


def test_solve_with_ideal_model_matches_plain_solve_hydrogen_ion() -> None:
    from titration.equilibrium import solve_hydrogen_ion

    totals = SystemTotals(kw=1e-14, acid_systems=(WeakSystem(0.1, (1.75e-5,)),))
    direct = solve_hydrogen_ion(totals)
    via_activity = solve_with_activity_model(totals, "ideal")
    assert via_activity.root.pH == direct.pH
    assert via_activity.outer_iterations == 0
    assert via_activity.apparent_totals_at_convergence is totals


def test_solve_with_davies_model_converges_and_differs_from_ideal() -> None:
    totals = SystemTotals(kw=1e-14, acid_systems=(WeakSystem(0.1, (1.75e-5,)),))
    ideal = solve_with_activity_model(totals, "ideal")
    davies = solve_with_activity_model(totals, "davies")
    assert davies.converged
    assert davies.outer_iterations > 0
    assert davies.root.pH != ideal.root.pH
    assert davies.root.pH < ideal.root.pH  # salt effect: more dissociation => lower pH for a weak acid


def test_solve_with_davies_model_is_deterministic() -> None:
    totals = SystemTotals(kw=1e-14, acid_systems=(WeakSystem(0.1, (1.75e-5,)),), strong_base_molar=0.02)
    first = solve_with_activity_model(totals, "davies")
    second = solve_with_activity_model(totals, "davies")
    assert first.root.pH == second.root.pH
    assert first.outer_iterations == second.outer_iterations


def test_solve_with_davies_model_warns_above_the_validated_ionic_strength_ceiling() -> None:
    totals = SystemTotals(kw=1e-14, acid_systems=(WeakSystem(1.0, (1.75e-5,)),), extra_spectator_cation_molar=1.0, extra_spectator_anion_molar=1.0)
    result = solve_with_activity_model(totals, "davies")
    assert result.converged
    assert result.ionic_strength_molar > MAX_VALIDATED_IONIC_STRENGTH_MOLAR
    assert any("validity ceiling" in w for w in result.warnings)


def test_solve_with_davies_model_does_not_warn_below_the_ceiling() -> None:
    totals = SystemTotals(kw=1e-14, acid_systems=(WeakSystem(0.01, (1.75e-5,)),))
    result = solve_with_activity_model(totals, "davies")
    assert result.ionic_strength_molar < MAX_VALIDATED_IONIC_STRENGTH_MOLAR
    assert result.warnings == ()


def test_unknown_activity_model_raises() -> None:
    totals = SystemTotals(kw=1e-14)
    with pytest.raises(ValueError):
        solve_with_activity_model(totals, "debye-huckel-extended")


def test_davies_correction_is_consistent_with_the_resulting_ionic_strength() -> None:
    """At convergence, the ionic strength computed from the final (apparent-constants) solution
    must match the ionic strength that was used to build those apparent constants -- the
    definition of self-consistency."""
    totals = SystemTotals(kw=1e-14, acid_systems=(WeakSystem(0.1, (1.75e-5,)),), strong_base_molar=0.03)
    result = solve_with_activity_model(totals, "davies")
    recomputed = ionic_strength(result.root.hydrogen_ion_molar, result.apparent_totals_at_convergence)
    assert recomputed == pytest.approx(result.ionic_strength_molar, rel=1e-6)


def test_davies_a_constant_matches_the_cited_25c_value() -> None:
    assert DAVIES_A_298_15K == pytest.approx(0.509, abs=1e-6)
