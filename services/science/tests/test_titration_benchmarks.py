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
# "Test unsupported polyprotic/mixtures and out-of-range conditions; errors must propagate
#  correctly."
# ---------------------------------------------------------------------------------------------


@pytest.mark.parametrize("species_id", ["sulfuric-acid", "phosphoric-acid", "carbonic-acid", "oxalic-acid", "calcium-hydroxide"])
def test_polyprotic_and_diacidic_species_are_unsupported(species_id: str) -> None:
    result = solve_equilibrium(species=[SpeciesAmountInput(species_id, 0.001)], volume_l=0.1)
    assert result.status == "UNSUPPORTED"
    assert result.pH is None
    assert result.reason is not None and species_id.split("-")[0] not in ("",)  # reason is populated
    reason = result.reason.lower()  # type: ignore[union-attr]
    assert any(keyword in reason for keyword in ("diprotic", "triprotic", "polyprotic", "diacidic")), reason


def test_mixture_of_two_distinct_weak_acids_is_unsupported() -> None:
    result = solve_equilibrium(species=[SpeciesAmountInput("acetic-acid", 0.001), SpeciesAmountInput("formic-acid", 0.001)], volume_l=0.1)
    assert result.status == "UNSUPPORTED"
    assert "weak-acid system" in result.reason  # type: ignore[operator]


def test_mixture_of_weak_acid_and_weak_base_is_unsupported() -> None:
    result = solve_equilibrium(species=[SpeciesAmountInput("acetic-acid", 0.001), SpeciesAmountInput("ammonia", 0.001)], volume_l=0.1)
    assert result.status == "UNSUPPORTED"


def test_mixture_of_strong_and_weak_acid_is_unsupported() -> None:
    result = solve_equilibrium(species=[SpeciesAmountInput("hydrochloric-acid", 0.001), SpeciesAmountInput("acetic-acid", 0.001)], volume_l=0.1)
    assert result.status == "UNSUPPORTED"


@pytest.mark.parametrize("temperature_k", [-5.0, 0.0, 200.0, 400.0, 1000.0])
def test_temperature_outside_validated_range_is_unsupported(temperature_k: float) -> None:
    result = solve_equilibrium(species=[SpeciesAmountInput("hydrochloric-acid", 0.001)], volume_l=0.1, temperature_k=temperature_k)
    assert result.status == "UNSUPPORTED"
    assert result.reason is not None and "temperature" in result.reason.lower()


def test_weak_system_far_from_25c_is_unsupported_even_within_water_range() -> None:
    """A weak-acid Ka is only held constant within +-10 K of 298.15 K in v1; 350 K is a valid
    temperature for the water model but must still be refused for a weak-acid system."""
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
