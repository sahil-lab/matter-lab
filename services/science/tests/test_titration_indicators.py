"""Indicator transition models: fraction/color correctness and the endpoint-vs-equivalence
divergence the brief asks for ("documented color interpolation and why endpoint differs from
equivalence")."""

from __future__ import annotations

import pytest

from titration.indicators import INDICATORS, fraction_basic_form, indicator_color, indicator_state_label, lookup_indicator
from titration.titration_curve import TitrationSetup, compare_endpoint_to_equivalence, equivalence_volume_l, indicator_endpoint_volume_l


@pytest.mark.parametrize("indicator", INDICATORS, ids=[i.indicator_id for i in INDICATORS])
def test_fraction_basic_form_is_half_at_pkin(indicator) -> None:
    assert fraction_basic_form(indicator, indicator.pKin) == pytest.approx(0.5, abs=1e-9)


@pytest.mark.parametrize("indicator", INDICATORS, ids=[i.indicator_id for i in INDICATORS])
def test_fraction_basic_form_is_monotonically_increasing_with_ph(indicator) -> None:
    phs = [indicator.pKin + delta for delta in (-4, -2, -1, -0.5, 0, 0.5, 1, 2, 4)]
    fractions = [fraction_basic_form(indicator, ph) for ph in phs]
    assert all(0.0 < f < 1.0 for f in fractions)
    for earlier, later in zip(fractions, fractions[1:]):
        assert later > earlier


@pytest.mark.parametrize("indicator", INDICATORS, ids=[i.indicator_id for i in INDICATORS])
def test_fraction_basic_form_approaches_pure_forms_far_from_pkin(indicator) -> None:
    assert fraction_basic_form(indicator, indicator.pKin - 3) < 0.01
    assert fraction_basic_form(indicator, indicator.pKin + 3) > 0.99


@pytest.mark.parametrize("indicator", INDICATORS, ids=[i.indicator_id for i in INDICATORS])
def test_color_interpolates_between_acid_and_base_colors(indicator) -> None:
    low_color = indicator_color(indicator, indicator.pKin - 5)
    high_color = indicator_color(indicator, indicator.pKin + 5)
    assert low_color.as_tuple() == pytest.approx(indicator.acid_color.as_tuple(), abs=1)
    assert high_color.as_tuple() == pytest.approx(indicator.base_color.as_tuple(), abs=1)
    mid_color = indicator_color(indicator, indicator.pKin)
    # the midpoint colour must lie strictly between the two pure forms on every channel that differs
    for lo, mid, hi in zip(indicator.acid_color.as_tuple(), mid_color.as_tuple(), indicator.base_color.as_tuple()):
        if lo != hi:
            assert min(lo, hi) <= mid <= max(lo, hi)


def test_state_label_reports_dominant_form() -> None:
    phph = lookup_indicator("phenolphthalein")
    assert phph is not None
    assert "colorless" in indicator_state_label(phph, phph.pKin - 3)
    assert "pink" in indicator_state_label(phph, phph.pKin + 3)
    assert "transitioning" in indicator_state_label(phph, phph.pKin)


def test_unknown_indicator_id_returns_none() -> None:
    assert lookup_indicator("not-a-real-indicator") is None


# ---------------------------------------------------------------------------------------------
# "documented color interpolation and why endpoint differs from equivalence"
# ---------------------------------------------------------------------------------------------


def test_phenolphthalein_and_methyl_orange_both_approximate_equivalence_for_strong_acid_strong_base() -> None:
    """For a strong acid/strong base titration the pH gradient at equivalence is so steep that
    both a high-pKin and a low-pKin indicator give endpoints within a fraction of a mL (<0.15 mL
    here) of the true stoichiometric equivalence point -- the classic reason either indicator
    "works" for this titration -- but the two endpoints must still be numerically distinct from
    each other and from the equivalence volume, not silently equal to it."""
    setup = TitrationSetup("hydrochloric-acid", 0.100, 0.02500, "sodium-hydroxide", 0.100)
    equivalence = equivalence_volume_l(setup)
    phenolphthalein = compare_endpoint_to_equivalence(setup, lookup_indicator("phenolphthalein"))
    methyl_orange = compare_endpoint_to_equivalence(setup, lookup_indicator("methyl-orange"))

    assert phenolphthalein.indicator_endpoint_volume_l is not None
    assert methyl_orange.indicator_endpoint_volume_l is not None
    assert abs(phenolphthalein.difference_l) < 0.15e-3  # type: ignore[arg-type]
    assert abs(methyl_orange.difference_l) < 0.15e-3  # type: ignore[arg-type]
    assert phenolphthalein.indicator_endpoint_volume_l != methyl_orange.indicator_endpoint_volume_l
    assert phenolphthalein.difference_l != 0.0
    assert methyl_orange.difference_l != 0.0
    assert "equivalence" in phenolphthalein.explanation and "pKin" in phenolphthalein.explanation
    assert phenolphthalein.equivalence_volume_l == pytest.approx(equivalence, abs=1e-9)


def test_methyl_orange_is_a_poor_choice_for_a_weak_acid_strong_base_titration() -> None:
    """Pure 0.1 M acetic acid starts below methyl orange's pKin (pH approx 2.88 vs pKin 3.7), so
    the indicator's colour change is crossed almost as soon as titration begins -- long before the
    true equivalence point -- rather than never being crossed. That is a large, computed titration
    error (tens of percent of the equivalence volume), the concrete reason methyl orange is a poor
    choice here, distinct from the small-fraction-of-a-mL error for the strong-acid/strong-base
    case above."""
    setup = TitrationSetup("acetic-acid", 0.100, 0.02500, "sodium-hydroxide", 0.100)
    equivalence = equivalence_volume_l(setup)
    comparison = compare_endpoint_to_equivalence(setup, lookup_indicator("methyl-orange"))
    assert comparison.indicator_endpoint_volume_l is not None
    assert comparison.indicator_endpoint_volume_l < 0.1 * equivalence, "methyl orange changes colour very early in this titration, far short of equivalence"
    assert abs(comparison.difference_l) > 0.5 * equivalence  # type: ignore[operator]


def test_phenolphthalein_is_a_good_choice_for_a_weak_acid_strong_base_titration() -> None:
    """Phenolphthalein's pKin (9.4) sits inside the basic overshoot just after equivalence for
    acetic acid/NaOH (equivalence pH approx 8.73, see benchmarks), so its computed endpoint should
    fall close to, and after, the true equivalence volume."""
    setup = TitrationSetup("acetic-acid", 0.100, 0.02500, "sodium-hydroxide", 0.100)
    comparison = compare_endpoint_to_equivalence(setup, lookup_indicator("phenolphthalein"))
    assert comparison.indicator_endpoint_volume_l is not None
    assert comparison.difference_l is not None and comparison.difference_l > 0, "phenolphthalein's higher pKin means its colour change is seen slightly after equivalence for this weak-acid titration"
    assert abs(comparison.difference_l) < 0.5e-3  # within half a mL for a 25 mL-scale titration


def test_indicator_endpoint_search_reports_no_crossing_outside_its_search_range() -> None:
    """When the search range is restricted to a span the curve never reaches the indicator's pKin
    within, `indicator_endpoint_volume_l` must report `None` rather than extrapolating or guessing
    -- exercised directly (not inferred from a chemistry assumption) by deliberately searching only
    the very first microlitre of a strong-acid/strong-base titration, far short of any of the three
    shipped indicators' transition ranges."""
    setup = TitrationSetup("hydrochloric-acid", 0.100, 0.02500, "sodium-hydroxide", 0.100)
    for indicator_id in ("phenolphthalein", "methyl-orange", "bromothymol-blue"):
        indicator = lookup_indicator(indicator_id)
        assert indicator is not None
        result = indicator_endpoint_volume_l(setup, indicator, search_high_l=1e-6)
        assert result is None, indicator_id
