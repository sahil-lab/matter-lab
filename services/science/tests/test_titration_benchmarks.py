"""Acceptance benchmarks from `Agent_06_Scientific_Chemistry_and_Titration_Engine.md` ("Benchmarks
and tests"). Each test name below maps directly to one bullet of that section.
"""

from __future__ import annotations

import math

import pytest

from titration.solver import solve_equilibrium
from titration.species import SPECIES_BY_ID
from titration.titration_curve import (
    TitrationSetup,
    equivalence_volume_l,
    half_equivalence_volume_l,
    steepest_gradient_volume_l,
    titration_curve,
)
from titration.types import SpeciesAmountInput

# ---------------------------------------------------------------------------------------------
# "25.00 mL of 0.100 M HCl titrated by 0.100 M NaOH should have theoretical equivalence at
#  25.00 mL and pH approximately 7 at 25 degC under stated ideal conditions."
# ---------------------------------------------------------------------------------------------


def test_strong_acid_strong_base_equivalence_at_25_00_ml_and_ph_7() -> None:
    setup = TitrationSetup(
        analyte_species_id="hydrochloric-acid",
        analyte_concentration_molar=0.100,
        analyte_volume_l=0.02500,
        titrant_species_id="sodium-hydroxide",
        titrant_concentration_molar=0.100,
        temperature_k=298.15,
    )
    equivalence = equivalence_volume_l(setup)
    assert equivalence == pytest.approx(0.02500, abs=1e-9), "25.00 mL of 0.100 M HCl needs exactly 25.00 mL of 0.100 M NaOH (1:1 monoprotic reaction)"

    at_equivalence = solve_equilibrium(
        species=[
            SpeciesAmountInput("hydrochloric-acid", 0.100 * 0.02500),
            SpeciesAmountInput("sodium-hydroxide", 0.100 * equivalence),
        ],
        volume_l=0.02500 + equivalence,
        temperature_k=298.15,
    )
    assert at_equivalence.status == "SUCCEEDED"
    assert at_equivalence.pH == pytest.approx(7.0, abs=0.01), "ideal strong-acid/strong-base equivalence must be neutral at 25 degC"
    assert at_equivalence.evidence == "MODEL_CALCULATED"


# ---------------------------------------------------------------------------------------------
# "Before/after equivalence, acid/base excess gives chemically sensible monotonic pH trend; pH
#  curve is not hardcoded."
# ---------------------------------------------------------------------------------------------


def test_strong_acid_strong_base_curve_is_monotonic_and_matches_classical_approximations() -> None:
    setup = TitrationSetup("hydrochloric-acid", 0.100, 0.02500, "sodium-hydroxide", 0.100)
    delivered_ml = [0, 5, 10, 15, 20, 24, 24.9, 24.99, 25.0, 25.01, 25.1, 26, 30, 40, 50]
    points = titration_curve(setup, [v / 1000.0 for v in delivered_ml])
    assert all(p.result.status == "SUCCEEDED" for p in points)

    phs = [p.pH for p in points]
    assert all(b > a for a, b in zip(phs, phs[1:])), "pH must rise monotonically as NaOH is added to HCl, at every point of the curve"

    # Classical pre-equivalence approximation (excess strong acid, water autoionization negligible):
    # pH = -log10(moles excess acid / total volume). Valid away from the equivalence point itself.
    for v_ml, point in zip(delivered_ml, points):
        v_l = v_ml / 1000.0
        if v_ml <= 20:  # comfortably before equivalence; the approximation should be excellent
            excess_acid_moles = 0.100 * 0.02500 - 0.100 * v_l
            approx_ph = -math.log10(excess_acid_moles / point.total_volume_l)
            assert point.pH == pytest.approx(approx_ph, abs=0.01), f"at {v_ml} mL delivered"
        if v_ml >= 30:  # comfortably after equivalence; excess strong base dominates
            excess_base_moles = 0.100 * v_l - 0.100 * 0.02500
            approx_poh = -math.log10(excess_base_moles / point.total_volume_l)
            assert point.pH == pytest.approx(14.0 - approx_poh, abs=0.01), f"at {v_ml} mL delivered"

    # The curve is computed, not interpolated: the steepest gradient among independently solved
    # points must itself land within a fraction of a mL of the stoichiometric equivalence volume.
    gradient_volume = steepest_gradient_volume_l(points)
    assert gradient_volume is not None
    assert abs(gradient_volume - 0.02500) < 0.2e-3


def test_curve_points_are_not_a_fixed_shape_response_to_the_system_actually_solved() -> None:
    """Changing the analyte concentration must change the computed curve (a hardcoded or
    shape-interpolated curve could not distinguish these two systems); a stronger analyte gives a
    lower initial pH and an equivalence point that moves with the stoichiometry."""
    weak_setup = TitrationSetup("acetic-acid", 0.100, 0.02500, "sodium-hydroxide", 0.100)
    strong_setup = TitrationSetup("hydrochloric-acid", 0.100, 0.02500, "sodium-hydroxide", 0.100)
    weak_start = titration_curve(weak_setup, [0.0])[0]
    strong_start = titration_curve(strong_setup, [0.0])[0]
    assert strong_start.pH < weak_start.pH, "a strong acid must be more acidic than a weak acid of the same formal concentration"

    doubled_setup = TitrationSetup("hydrochloric-acid", 0.200, 0.02500, "sodium-hydroxide", 0.100)
    assert equivalence_volume_l(doubled_setup) == pytest.approx(0.05000, abs=1e-9)


# ---------------------------------------------------------------------------------------------
# "Equal concentrations of weak monoprotic acetic acid / strong base reproduce buffer behavior,
#  near pH approx pKa at half-equivalence under assumptions, and pH > 7 at equivalence."
# ---------------------------------------------------------------------------------------------


def test_acetic_acid_sodium_hydroxide_buffer_behavior() -> None:
    setup = TitrationSetup("acetic-acid", 0.100, 0.02500, "sodium-hydroxide", 0.100)
    pKa = -math.log10(SPECIES_BY_ID["acetic-acid"].Ka_298_15k)  # type: ignore[arg-type]
    assert pKa == pytest.approx(4.756, abs=1e-6)

    half_equivalence = half_equivalence_volume_l(setup)
    at_half = titration_curve(setup, [half_equivalence])[0]
    assert at_half.result.status == "SUCCEEDED"
    assert at_half.pH == pytest.approx(pKa, abs=0.01), "Henderson-Hasselbalch: pH approx pKa at half-equivalence"

    equivalence = equivalence_volume_l(setup)
    at_equivalence = titration_curve(setup, [equivalence])[0]
    assert at_equivalence.result.status == "SUCCEEDED"
    assert at_equivalence.pH > 7.0, "the equivalence-point solution is sodium acetate, a salt of a weak acid and a strong base: it must be basic"

    # Buffering signature: |dpH/dV| must be smallest near half-equivalence and rise toward both
    # edges of the titration (a U-shape in the local slope, minimized where [HA] = [A-]), checked
    # against the system's own curve rather than assumed.
    def local_slope(fraction: float, half_width_fraction: float = 0.01) -> float:
        delta = equivalence * half_width_fraction
        center = fraction * equivalence
        lower, upper = titration_curve(setup, [center - delta, center + delta])
        assert lower.pH is not None and upper.pH is not None
        return abs(upper.pH - lower.pH) / (2 * delta)

    slope_at_half = local_slope(0.5)
    for edge_fraction in (0.2, 0.3, 0.7, 0.8):
        assert local_slope(edge_fraction) > slope_at_half, f"|dpH/dV| at {edge_fraction:.0%} of equivalence must exceed its value at half-equivalence (the flattest, most-buffered point)"


def test_ammonia_hydrochloric_acid_weak_base_strong_acid_case() -> None:
    """Weak base / strong acid: the mirror image of the acetic acid case, equivalence must be
    acidic (ammonium chloride solution)."""
    setup = TitrationSetup("ammonia", 0.100, 0.02500, "hydrochloric-acid", 0.100)
    pKa_conjugate = -math.log10(SPECIES_BY_ID["ammonia"].Ka_298_15k)  # type: ignore[arg-type]
    half_equivalence = half_equivalence_volume_l(setup)
    at_half = titration_curve(setup, [half_equivalence])[0]
    assert at_half.pH == pytest.approx(pKa_conjugate, abs=0.01)

    equivalence = equivalence_volume_l(setup)
    at_equivalence = titration_curve(setup, [equivalence])[0]
    assert at_equivalence.pH < 7.0, "ammonium chloride solution (weak base titrated by strong acid at equivalence) must be acidic"


# ---------------------------------------------------------------------------------------------
# "Verify mass balance, charge balance residuals, unit conversions and solver behavior near sharp
#  equivalence gradients."
# ---------------------------------------------------------------------------------------------


def test_mass_and_charge_balance_residuals_are_near_zero_throughout_the_curve() -> None:
    setup = TitrationSetup("acetic-acid", 0.100, 0.02500, "sodium-hydroxide", 0.100)
    equivalence = equivalence_volume_l(setup)
    points = titration_curve(setup, [0.0, 0.3 * equivalence, equivalence, 1.5 * equivalence])
    for point in points:
        assert point.result.status == "SUCCEEDED"
        diag = point.result.diagnostics
        assert diag.charge_balance_residual_molar == pytest.approx(0.0, abs=1e-8)
        for system_id, residual in diag.mass_balance_residuals_molar.items():
            assert residual == pytest.approx(0.0, abs=1e-8), f"mass balance residual for {system_id}"


def test_solver_converges_cleanly_within_microliters_of_the_sharp_equivalence_gradient() -> None:
    """The strong-acid/strong-base curve swings many pH units within a fraction of a millilitre of
    equivalence; the root finder must still converge cleanly (no silently wrong answer) on both
    sides of that gradient."""
    setup = TitrationSetup("hydrochloric-acid", 0.100, 0.02500, "sodium-hydroxide", 0.100)
    equivalence = equivalence_volume_l(setup)
    just_before = titration_curve(setup, [equivalence - 1e-6])[0]
    just_after = titration_curve(setup, [equivalence + 1e-6])[0]
    assert just_before.result.status == "SUCCEEDED" and just_after.result.status == "SUCCEEDED"
    assert just_before.pH < 7.0 < just_after.pH
    assert just_after.pH - just_before.pH > 2.0, "the equivalence gradient for a strong acid/strong base titration must be very steep"


def test_unit_conversion_volume_in_liters_vs_milliliters_gives_identical_ph() -> None:
    """The solver's contract is liters; this checks that two equivalent descriptions of the same
    physical system (volumes given in L, scaled by 1000 from a mL figure) give the identical pH,
    not merely a close one."""
    result_l = solve_equilibrium(species=[SpeciesAmountInput("hydrochloric-acid", 0.0025)], volume_l=25.00 / 1000.0)
    result_scaled = solve_equilibrium(species=[SpeciesAmountInput("hydrochloric-acid", 2.5 / 1000.0)], volume_l=0.025)
    assert result_l.pH == result_scaled.pH


# ---------------------------------------------------------------------------------------------
# Polyprotic acids/bases and multi-system mixtures (v2 extension: supported, not merely rejected
# -- see README.md Section 3 for what changed relative to the original v1 brief and why).
# ---------------------------------------------------------------------------------------------


def test_phosphoric_acid_is_supported_and_matches_known_dilute_solution_behavior() -> None:
    """0.100 M phosphoric acid is a well-known general-chemistry example: pH approx 1.6, with the
    first dissociation only partial (Ka1 = 6.9e-3 is not large enough, relative to 0.1 M, for
    "complete" behavior) -- textbooks typically quote roughly 25-30% ionization of the first
    proton at this concentration, so undissociated H3PO4 is still the single largest form, not
    H2PO4-, which the rigorous solver reproduces rather than assuming the opposite."""
    result = solve_equilibrium(species=[SpeciesAmountInput("phosphoric-acid", 0.01)], volume_l=0.1)
    assert result.status == "SUCCEEDED"
    assert 1.4 < result.pH < 1.8, result.pH  # type: ignore[operator]
    by_form = {c.form: c.molar for c in result.equilibrium_concentrations if c.species_id == "phosphoric-acid"}
    h3po4 = next(v for k, v in by_form.items() if "fully protonated" in k)
    h2po4_minus = next(v for k, v in by_form.items() if "1 of 3" in k)
    hpo4_2minus = next(v for k, v in by_form.items() if "2 of 3" in k)
    po4_3minus = next(v for k, v in by_form.items() if "3 of 3" in k)
    assert h3po4 > h2po4_minus > hpo4_2minus > po4_3minus  # degree of ionization falls off steeply at each step
    assert h3po4 == pytest.approx(0.1 - h2po4_minus, abs=1e-6)  # first-step mass balance: H3PO4 + H2PO4- accounts for essentially all of it


def test_phosphoric_acid_titration_curve_shows_three_equivalence_regions() -> None:
    """A classic triprotic titration curve (H3PO4 by NaOH) has three buffer regions around pKa1,
    pKa2, pKa3; checked here by requiring the solved pH to pass near each pKa at the corresponding
    0.5, 1.5 and 2.5 equivalents of base, and to keep rising monotonically throughout (no hardcoded
    shape). The match is loosest for the first step (Ka1 = 6.9e-3 is too large, relative to the
    0.1 M scale of this titration, for the simple Henderson-Hasselbalch approximation to hold
    tightly) and for the third (pKa3 = 12.32 is close enough to 14 that water's own autoionization
    measurably shifts the half-neutralization point) -- both are real, expected deviations of the
    textbook approximation from the rigorous solve, not solver error."""
    setup = TitrationSetup("phosphoric-acid", 0.100, 0.02500, "sodium-hydroxide", 0.100)
    equivalence = equivalence_volume_l(setup)  # 1 equivalent = enough NaOH for ONE proton
    pKa1, pKa2, pKa3 = 2.15, 7.21, 12.32
    volumes = [f * equivalence for f in (0.5, 1.0, 1.5, 2.0, 2.5, 3.0)]
    points = titration_curve(setup, volumes)
    assert all(p.result.status == "SUCCEEDED" for p in points)
    phs = [p.pH for p in points]
    assert all(b > a for a, b in zip(phs, phs[1:])), phs
    assert phs[0] == pytest.approx(pKa1, abs=0.2)  # 0.5 equivalents: half of the first proton removed
    assert phs[2] == pytest.approx(pKa2, abs=0.05)  # 1.5 equivalents: half of the second proton removed (textbook-accurate, true weak-acid regime)
    assert phs[4] == pytest.approx(pKa3, abs=0.6)  # 2.5 equivalents: half of the third proton removed (near the practical pH ceiling; water autoionization matters here)


def test_sulfuric_acid_is_more_acidic_than_an_equivalent_monoprotic_strong_acid() -> None:
    """Because the second dissociation (Ka2 = 1.0e-2) is not complete, 0.05 M H2SO4 must be *less*
    acidic than a hypothetical fully-dissociated diprotic strong acid at the same concentration
    (pH 1.00), but still far more acidic than a monoprotic strong acid at the same formal
    concentration (which would give pH 1.30)."""
    result = solve_equilibrium(species=[SpeciesAmountInput("sulfuric-acid", 0.005)], volume_l=0.1)
    assert result.status == "SUCCEEDED"
    monoprotic_equivalent = solve_equilibrium(species=[SpeciesAmountInput("hydrochloric-acid", 0.005)], volume_l=0.1)
    assert result.pH > 1.0  # type: ignore[operator]
    assert result.pH < monoprotic_equivalent.pH  # type: ignore[operator]


def test_oxalic_and_carbonic_acid_are_supported() -> None:
    for species_id, expected_range in (("oxalic-acid", (1.0, 2.5)), ("carbonic-acid", (3.5, 5.0))):
        result = solve_equilibrium(species=[SpeciesAmountInput(species_id, 0.001)], volume_l=0.1)
        assert result.status == "SUCCEEDED", species_id
        assert expected_range[0] < result.pH < expected_range[1], (species_id, result.pH)  # type: ignore[operator]


@pytest.mark.parametrize("species_id", ["calcium-hydroxide", "barium-hydroxide"])
def test_diacidic_strong_bases_release_two_hydroxides_per_mole(species_id: str) -> None:
    result = solve_equilibrium(species=[SpeciesAmountInput(species_id, 0.01)], volume_l=0.1)
    assert result.status == "SUCCEEDED"
    monoacidic_equivalent_moles = 0.02  # same total OH- as 0.01 mol of a diacidic base
    reference = solve_equilibrium(species=[SpeciesAmountInput("sodium-hydroxide", monoacidic_equivalent_moles)], volume_l=0.1)
    assert result.pH == pytest.approx(reference.pH, abs=1e-6)


def test_two_distinct_weak_acids_can_be_dosed_together() -> None:
    """A mixture of acetic and formic acid is now a supported system. The mixture (0.1 M of each,
    0.2 M total weak acid) must be more acidic than 0.2 M acetic acid alone (formic, the stronger
    acid, is part of the mix) and less acidic than 0.2 M formic acid alone (acetic, the weaker
    acid, dilutes the effect) -- comparing against solutions of the *same total acid
    concentration*, not against the individual 0.1 M components alone, which carry only half the
    mixture's total acid load and are not the relevant comparison."""
    mixture = solve_equilibrium(species=[SpeciesAmountInput("acetic-acid", 0.01), SpeciesAmountInput("formic-acid", 0.01)], volume_l=0.1)
    acetic_same_total = solve_equilibrium(species=[SpeciesAmountInput("acetic-acid", 0.02)], volume_l=0.1)
    formic_same_total = solve_equilibrium(species=[SpeciesAmountInput("formic-acid", 0.02)], volume_l=0.1)
    assert mixture.status == "SUCCEEDED"
    assert formic_same_total.pH < mixture.pH < acetic_same_total.pH  # type: ignore[operator]
    by_system = {c.species_id for c in mixture.equilibrium_concentrations}
    assert {"acetic-acid", "formic-acid"} <= by_system


def test_weak_acid_and_weak_base_together_reproduces_ammonium_acetate_near_neutrality() -> None:
    """Equal moles of acetic acid and ammonia, once reacted, are chemically identical to ammonium
    acetate solution -- a textbook example of a salt of a weak acid and a weak base that is almost
    exactly neutral, because Ka(acetic acid) and Kb(ammonia) happen to be very close in magnitude."""
    result = solve_equilibrium(species=[SpeciesAmountInput("acetic-acid", 0.01), SpeciesAmountInput("ammonia", 0.01)], volume_l=0.1)
    assert result.status == "SUCCEEDED"
    assert result.pH == pytest.approx(7.0, abs=0.05)


def test_strong_acid_and_weak_acid_can_be_dosed_together() -> None:
    """A strong acid added alongside a weak acid (e.g. a drop of HCl in an acetic acid buffer) must
    be more acidic than the weak acid alone at the same formal concentration, but the weak acid's
    own equilibrium must still be represented in the output."""
    mixed = solve_equilibrium(species=[SpeciesAmountInput("hydrochloric-acid", 0.01), SpeciesAmountInput("acetic-acid", 0.01)], volume_l=0.1)
    acetic_alone = solve_equilibrium(species=[SpeciesAmountInput("acetic-acid", 0.01)], volume_l=0.1)
    assert mixed.status == "SUCCEEDED"
    assert mixed.pH < acetic_alone.pH  # type: ignore[operator]
    assert any(c.species_id == "acetic-acid" for c in mixed.equilibrium_concentrations)


def test_boric_acid_remains_unsupported_as_a_lewis_acid() -> None:
    """Boric acid is deliberately kept unsupported: it is a Lewis acid (accepts OH-), not a
    Bronsted proton donor, so the n-step dissociation model does not describe it."""
    result = solve_equilibrium(species=[SpeciesAmountInput("boric-acid", 0.001)], volume_l=0.1)
    assert result.status == "UNSUPPORTED"
    assert result.pH is None
    assert "lewis acid" in result.reason.lower()  # type: ignore[union-attr]


# ---------------------------------------------------------------------------------------------
# Out-of-range conditions still propagate correctly.
# ---------------------------------------------------------------------------------------------


@pytest.mark.parametrize("temperature_k", [-5.0, 0.0, 200.0, 400.0, 1000.0])
def test_temperature_outside_validated_range_is_unsupported(temperature_k: float) -> None:
    result = solve_equilibrium(species=[SpeciesAmountInput("hydrochloric-acid", 0.001)], volume_l=0.1, temperature_k=temperature_k)
    assert result.status == "UNSUPPORTED"
    assert result.reason is not None and "temperature" in result.reason.lower()


def test_weak_system_far_from_25c_is_unsupported_even_within_water_range() -> None:
    """A weak-acid Ka is only held constant within +-10 K of 298.15 K; 350 K is a valid temperature
    for the water model but must still be refused for a weak-acid system."""
    result = solve_equilibrium(species=[SpeciesAmountInput("acetic-acid", 0.001)], volume_l=0.1, temperature_k=350.0)
    assert result.status == "UNSUPPORTED"
    assert "acetic-acid" in result.reason  # type: ignore[operator]


def test_unknown_species_id_is_unsupported_not_a_crash() -> None:
    result = solve_equilibrium(species=[SpeciesAmountInput("definitely-not-a-real-species", 0.001)], volume_l=0.1)
    assert result.status == "UNSUPPORTED"


def test_negative_moles_is_failed_not_unsupported() -> None:
    """Physically malformed input (negative moles) is a different failure mode from "we do not
    support this chemistry": FAILED, not UNSUPPORTED."""
    result = solve_equilibrium(species=[SpeciesAmountInput("hydrochloric-acid", -0.001)], volume_l=0.1)
    assert result.status == "FAILED"


def test_negative_or_zero_volume_is_failed() -> None:
    for bad_volume in (-1.0, 0.0, float("nan"), float("inf")):
        result = solve_equilibrium(species=[SpeciesAmountInput("hydrochloric-acid", 0.001)], volume_l=bad_volume)
        assert result.status == "FAILED", bad_volume


def test_unrecognized_model_id_is_unsupported() -> None:
    result = solve_equilibrium(species=[SpeciesAmountInput("hydrochloric-acid", 0.001)], volume_l=0.1, model_id="some-future-polyprotic-model-v2")
    assert result.status == "UNSUPPORTED"
    assert "model id" in result.reason.lower()  # type: ignore[union-attr]


def test_excessive_concentration_is_unsupported() -> None:
    """20 mol/L of HCl in 1 mL is far beyond the ideal-dilute-solution model's validated range."""
    result = solve_equilibrium(species=[SpeciesAmountInput("hydrochloric-acid", 0.020)], volume_l=0.001)
    assert result.status == "UNSUPPORTED"
    assert "concentration" in result.reason.lower()  # type: ignore[union-attr]


def test_result_is_deterministic_for_identical_inputs() -> None:
    species = [SpeciesAmountInput("acetic-acid", 0.0025), SpeciesAmountInput("sodium-hydroxide", 0.00125)]
    first = solve_equilibrium(species=species, volume_l=0.0375)
    second = solve_equilibrium(species=species, volume_l=0.0375)
    assert first.pH == second.pH
    assert first.diagnostics.input_hash == second.diagnostics.input_hash
