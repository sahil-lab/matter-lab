"""Ka(T) temperature model for species with sourced ionization thermodynamics
(`titration/ka_temperature.py`; currently acetic acid only -- see that module's docstring)."""

from __future__ import annotations

import pytest

from titration.ka_temperature import ACETIC_ACID_IONIZATION_THERMODYNAMICS, pKa_at_temperature
from titration.solver import solve_equilibrium
from titration.types import SpeciesAmountInput


@pytest.mark.parametrize("temperature_k,expected_pKa", [(273.15, 4.781), (298.15, 4.756), (323.15, 4.788)])
def test_pKa_at_temperature_matches_the_published_values(temperature_k: float, expected_pKa: float) -> None:
    """The three data points Goldberg, Kishore & Lennen (2002) are reported (via web search during
    this session) to give for acetic acid, reproduced here from only deltaH and deltaCp via this
    module's own derivation of the pK(T) relation (not copied from any one printed equation)."""
    pKa = pKa_at_temperature(4.756, ACETIC_ACID_IONIZATION_THERMODYNAMICS, temperature_k)
    assert pKa == pytest.approx(expected_pKa, abs=0.005)


def test_pKa_at_298_15k_is_exactly_the_reference_value() -> None:
    assert pKa_at_temperature(4.756, ACETIC_ACID_IONIZATION_THERMODYNAMICS, 298.15) == pytest.approx(4.756, abs=1e-12)


def test_pKa_at_temperature_has_a_shallow_minimum_near_room_temperature() -> None:
    """A real, documented feature of acetic acid's pKa(T) curve (driven by the small negative
    deltaH and large negative deltaCp): pKa dips to a shallow minimum near 25 degC and rises on
    either side, rather than monotonically increasing or decreasing with temperature."""
    pKa_cold = pKa_at_temperature(4.756, ACETIC_ACID_IONIZATION_THERMODYNAMICS, 273.15)
    pKa_room = pKa_at_temperature(4.756, ACETIC_ACID_IONIZATION_THERMODYNAMICS, 298.15)
    pKa_hot = pKa_at_temperature(4.756, ACETIC_ACID_IONIZATION_THERMODYNAMICS, 323.15)
    assert pKa_room < pKa_cold
    assert pKa_room < pKa_hot


def test_acetic_acid_solves_across_its_full_validated_range_not_just_the_generic_band() -> None:
    """Acetic acid's own Ka(T) model (273.15 K to 323.15 K) is wider than the generic +/-10 K band
    (288.15 K to 308.15 K) every other weak system is restricted to; solving at 0 degC and 50 degC
    -- outside the generic band -- must succeed precisely because of that model."""
    for temperature_k in (273.15, 283.15, 298.15, 313.15, 323.15):
        result = solve_equilibrium(species=[SpeciesAmountInput("acetic-acid", 0.001)], volume_l=0.1, temperature_k=temperature_k)
        assert result.status == "SUCCEEDED", (temperature_k, result.reason)


def test_acetic_acid_pH_vs_temperature_is_consistent_with_its_pKa_vs_temperature_shape() -> None:
    """Since the solution is dilute, pH should echo pKa's own shallow-minimum-near-25-degC shape."""
    phs = {}
    for temperature_k in (273.15, 298.15, 323.15):
        result = solve_equilibrium(species=[SpeciesAmountInput("acetic-acid", 0.01)], volume_l=0.1, temperature_k=temperature_k)
        assert result.status == "SUCCEEDED"
        phs[temperature_k] = result.pH
    assert phs[298.15] < phs[273.15]
    assert phs[298.15] < phs[323.15]


def test_acetic_acid_outside_its_own_wider_range_is_still_unsupported() -> None:
    result = solve_equilibrium(species=[SpeciesAmountInput("acetic-acid", 0.001)], volume_l=0.1, temperature_k=330.0)
    assert result.status == "UNSUPPORTED"
    assert "acetic-acid" in result.reason and "273.15" in result.reason and "323.15" in result.reason  # type: ignore[operator]


def test_other_weak_species_without_a_temperature_model_still_use_the_generic_narrow_band() -> None:
    """Ammonia has no `ionization_thermodynamics` entry, so it must still be restricted to the
    generic +/-10 K band even though 0 degC is well within water's own validated range."""
    result = solve_equilibrium(species=[SpeciesAmountInput("ammonia", 0.001)], volume_l=0.1, temperature_k=273.15)
    assert result.status == "UNSUPPORTED"
    assert "ammonia" in result.reason  # type: ignore[operator]


def test_assumptions_note_the_temperature_model_actually_used() -> None:
    with_model = solve_equilibrium(species=[SpeciesAmountInput("acetic-acid", 0.001)], volume_l=0.1, temperature_k=310.0)
    assert any("van't Hoff" in note or "heat-capacity" in note for note in with_model.assumptions)

    without_model = solve_equilibrium(species=[SpeciesAmountInput("acetic-acid", 0.001), SpeciesAmountInput("hydrochloric-acid", 0.001)], volume_l=0.1, temperature_k=298.15)
    assert not any("van't Hoff" in note for note in without_model.assumptions)  # no correction applied at the reference temperature itself
