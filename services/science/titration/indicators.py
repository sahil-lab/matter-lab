"""Acid-base indicator transition models.

Governing model
----------------
An indicator is itself a weak acid/base pair, HIn <=> In- + H+ (or the base form), with its own
`pKin` ("Ka" of the indicator). At equilibrium, by the same Henderson-Hasselbalch relation used
for the solver's weak-acid systems:

    fraction_basic_form(pH) = 1 / (1 + 10^(pKin - pH))     (identical in form to alpha_A- above)

A colour is rendered by linearly interpolating the acid-form and base-form colours in that
fraction; this is a model of the *titration-curve-level* indicator state for the lab's display,
not a measured absorption spectrum, so colours are labelled `ILLUSTRATIVE` even though the
underlying fraction is `MODEL_CALCULATED` from a cited pKin.

Why the visual endpoint differs from the stoichiometric equivalence point
---------------------------------------------------------------------------
The equivalence point is defined purely by stoichiometry (moles of titrant delivered equal moles
of analyte); the colour change is seen when the *indicator's own* equilibrium shifts near its
`pKin`, which is a fixed chemical property of the dye, not of the titration. The two coincide only
when `pKin` happens to equal the pH at equivalence; otherwise there is a small but real titration
error. `endpoint_volume` (in `titration_curve.py`) computes the delivered volume at which the
curve's pH crosses `pKin`, separately from the stoichiometric equivalence volume, so that
difference is an explicit, computed quantity rather than an assertion.
"""

from __future__ import annotations

from dataclasses import dataclass

from .provenance import Citation, Provenance

_ENGINEERING_TOOLBOX_AND_WIRED_CHEMIST = Citation(
    title="Standard acid-base indicator transition (pH) ranges and colours",
    source="The Engineering ToolBox; Wired Chemist acid-base indicator tables",
)


@dataclass(frozen=True)
class RGBColor:
    r: int
    g: int
    b: int

    def as_hex(self) -> str:
        return f"#{self.r:02x}{self.g:02x}{self.b:02x}"

    def as_tuple(self) -> tuple[int, int, int]:
        return (self.r, self.g, self.b)


@dataclass(frozen=True)
class IndicatorDefinition:
    indicator_id: str
    name: str
    pKin: float
    acid_color_name: str
    acid_color: RGBColor
    base_color_name: str
    base_color: RGBColor
    #: Literature-cited visible transition range (pH); may not be symmetric around `pKin` (see
    #: module docstring) because the two forms are not equally easy for the eye to detect.
    visual_range: tuple[float, float]
    provenance: Provenance


INDICATORS: tuple[IndicatorDefinition, ...] = (
    IndicatorDefinition(
        indicator_id="phenolphthalein",
        name="Phenolphthalein",
        pKin=9.4,
        acid_color_name="colorless",
        acid_color=RGBColor(0xF5, 0xF2, 0xEA),
        base_color_name="pink/magenta",
        base_color=RGBColor(0xE0, 0x45, 0x9A),
        visual_range=(8.3, 10.0),
        provenance=Provenance(
            source="The Engineering ToolBox; Wired Chemist acid-base indicator tables",
            evidence="REFERENCE_MEASURED",
            citations=(_ENGINEERING_TOOLBOX_AND_WIRED_CHEMIST,),
            notes="Visible transition pH 8.3-10.0 (colorless to pink); pKin ~ 9.4-9.5, taken here as 9.4.",
        ),
    ),
    IndicatorDefinition(
        indicator_id="methyl-orange",
        name="Methyl orange",
        pKin=3.7,
        acid_color_name="red",
        acid_color=RGBColor(0xC8, 0x2C, 0x2C),
        base_color_name="yellow",
        base_color=RGBColor(0xF2, 0xC4, 0x1A),
        visual_range=(3.1, 4.4),
        provenance=Provenance(
            source="The Engineering ToolBox; Wired Chemist acid-base indicator tables",
            evidence="REFERENCE_MEASURED",
            citations=(_ENGINEERING_TOOLBOX_AND_WIRED_CHEMIST,),
            notes="Visible transition pH 3.1-4.4 (red to yellow); pKin ~ 3.4-3.5, taken here as the range midpoint 3.7 for the fractional model.",
        ),
    ),
    IndicatorDefinition(
        indicator_id="bromothymol-blue",
        name="Bromothymol blue",
        pKin=7.1,
        acid_color_name="yellow",
        acid_color=RGBColor(0xE8, 0xD3, 0x2A),
        base_color_name="blue",
        base_color=RGBColor(0x2A, 0x5C, 0xC8),
        visual_range=(6.0, 7.6),
        provenance=Provenance(
            source="The Engineering ToolBox; Wired Chemist acid-base indicator tables",
            evidence="REFERENCE_MEASURED",
            citations=(_ENGINEERING_TOOLBOX_AND_WIRED_CHEMIST,),
            notes="Visible transition pH 6.0-7.6 (yellow to blue); pKin ~ 7.1-7.3, taken here as 7.1.",
        ),
    ),
)

INDICATORS_BY_ID: dict[str, IndicatorDefinition] = {i.indicator_id: i for i in INDICATORS}


def lookup_indicator(indicator_id: str) -> IndicatorDefinition | None:
    return INDICATORS_BY_ID.get(indicator_id)


def fraction_basic_form(indicator: IndicatorDefinition, pH: float) -> float:
    """Fraction of the indicator present in its base (`base_color`) form at `pH`, by the
    Henderson-Hasselbalch relation for the indicator's own acid/base equilibrium."""
    return 1.0 / (1.0 + 10.0 ** (indicator.pKin - pH))


def indicator_color(indicator: IndicatorDefinition, pH: float) -> RGBColor:
    """Linear interpolation between the acid-form and base-form colours by `fraction_basic_form`.
    ILLUSTRATIVE: a simplified display model, not a measured transmission/absorption spectrum."""
    fraction = fraction_basic_form(indicator, pH)
    return RGBColor(
        r=round(indicator.acid_color.r + (indicator.base_color.r - indicator.acid_color.r) * fraction),
        g=round(indicator.acid_color.g + (indicator.base_color.g - indicator.acid_color.g) * fraction),
        b=round(indicator.acid_color.b + (indicator.base_color.b - indicator.acid_color.b) * fraction),
    )


def indicator_state_label(indicator: IndicatorDefinition, pH: float) -> str:
    """A short, human-readable description of which form dominates, for the scientific panel."""
    fraction = fraction_basic_form(indicator, pH)
    if fraction < 0.1:
        return f"predominantly {indicator.acid_color_name} ({indicator.name} acid form)"
    if fraction > 0.9:
        return f"predominantly {indicator.base_color_name} ({indicator.name} base form)"
    return f"transitioning ({indicator.name}, {fraction * 100:.0f}% base form)"
