"""Generates the JSON fixtures in this directory from the real solver -- nothing in the fixtures
is hand-typed. Run `python -m titration.fixtures.generate_fixtures` from `services/science/` to
regenerate them after a change to the solver; `tests/test_titration_fixtures.py` checks the
committed files are still exactly what the solver produces, so a silent numeric drift cannot pass
unnoticed.

These are the integration fixtures named in the brief's deliverables ("integration fixtures for
Agent 07/10"): a consumer in another language only needs to reproduce the `input` of each case
through its own channel (e.g. an HTTP call to `POST /v1/titration/solve`) and compare the `expected`
fields within `tolerance`.
"""

from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path
from typing import Any

from .. import species as species_registry
from ..indicators import INDICATORS
from ..solver import solve_equilibrium
from ..titration_curve import TitrationSetup, compare_endpoint_to_equivalence, equivalence_volume_l, half_equivalence_volume_l, titration_curve
from ..types import SpeciesAmountInput

FIXTURES_DIR = Path(__file__).resolve().parent


def _solve_case(case_id: str, description: str, species: list[SpeciesAmountInput], volume_l: float, temperature_k: float = 298.15, tolerance_ph: float = 1e-6) -> dict[str, Any]:
    result = solve_equilibrium(species=species, volume_l=volume_l, temperature_k=temperature_k)
    return {
        "case_id": case_id,
        "description": description,
        "input": {
            "species": [{"species_id": s.species_id, "moles": s.moles} for s in species],
            "volume_l": volume_l,
            "temperature_k": temperature_k,
        },
        "expected": {
            "status": result.status,
            "pH": result.pH,
            "evidence": result.evidence,
            "tolerance_pH": tolerance_ph,
            "reason_contains": None if result.status == "SUCCEEDED" else _key_phrase(result.reason),
        },
    }


def _key_phrase(reason: str | None) -> str | None:
    """A short, stable substring of a `reason` safe to assert on (the full sentence may be
    reworded; this phrase should not)."""
    if reason is None:
        return None
    for phrase in ("dosed together", "diprotic", "triprotic", "diacidic", "weak-acid system", "weak-base system", "is not a resolved chemical species", "outside the validated range", "must be a positive"):
        if phrase in reason:
            return phrase
    return reason.split(".")[0]


def _titration_curve_fixture(case_id: str, description: str, setup: TitrationSetup, fractions_of_equivalence: list[float]) -> dict[str, Any]:
    equivalence = equivalence_volume_l(setup)
    half_equivalence = half_equivalence_volume_l(setup)
    volumes = [f * equivalence for f in fractions_of_equivalence]
    points = titration_curve(setup, volumes)
    return {
        "case_id": case_id,
        "description": description,
        "setup": {
            "analyte_species_id": setup.analyte_species_id,
            "analyte_concentration_molar": setup.analyte_concentration_molar,
            "analyte_volume_l": setup.analyte_volume_l,
            "titrant_species_id": setup.titrant_species_id,
            "titrant_concentration_molar": setup.titrant_concentration_molar,
            "temperature_k": setup.temperature_k,
        },
        "equivalence_volume_l": equivalence,
        "half_equivalence_volume_l": half_equivalence,
        "points": [
            {"fraction_of_equivalence": f, "delivered_volume_l": p.delivered_volume_l, "total_volume_l": p.total_volume_l, "pH": p.pH, "status": p.result.status}
            for f, p in zip(fractions_of_equivalence, points)
        ],
        "tolerance_pH": 1e-6,
    }


def _indicator_fixture() -> dict[str, Any]:
    strong_setup = TitrationSetup("hydrochloric-acid", 0.100, 0.02500, "sodium-hydroxide", 0.100)
    weak_setup = TitrationSetup("acetic-acid", 0.100, 0.02500, "sodium-hydroxide", 0.100)
    indicators_out = []
    for indicator in INDICATORS:
        indicators_out.append(
            {
                "indicator_id": indicator.indicator_id,
                "name": indicator.name,
                "pKin": indicator.pKin,
                "acid_color_hex": indicator.acid_color.as_hex(),
                "base_color_hex": indicator.base_color.as_hex(),
                "visual_range": list(indicator.visual_range),
                "endpoint_vs_equivalence": {
                    "strong_acid_strong_base_hcl_naoh": asdict(compare_endpoint_to_equivalence(strong_setup, indicator)),
                    "weak_acid_strong_base_acetic_acid_naoh": asdict(compare_endpoint_to_equivalence(weak_setup, indicator)),
                },
            }
        )
    return {"indicators": indicators_out}


def _species_fixture() -> dict[str, Any]:
    out = []
    for s in species_registry.all_species():
        out.append(
            {
                "species_id": s.species_id,
                "name": s.name,
                "formula": s.formula,
                "role": s.role,
                "pKa_298_15k": s.pKa_298_15k,
                "system_id": s.system_id,
                "unsupported_reason": s.unsupported_reason,
            }
        )
    return {"species": out}


def build_all_fixtures() -> dict[str, dict[str, Any]]:
    strong_setup = TitrationSetup("hydrochloric-acid", 0.100, 0.02500, "sodium-hydroxide", 0.100)
    weak_acid_setup = TitrationSetup("acetic-acid", 0.100, 0.02500, "sodium-hydroxide", 0.100)
    weak_base_setup = TitrationSetup("ammonia", 0.100, 0.02500, "hydrochloric-acid", 0.100)
    fractions = [0.0, 0.2, 0.4, 0.5, 0.6, 0.8, 0.96, 0.999, 1.0, 1.001, 1.04, 1.2, 1.6, 2.0]

    unsupported_cases = [
        _solve_case("sulfuric_acid_unsupported", "Diprotic acid, outside v1 monoprotic scope.", [SpeciesAmountInput("sulfuric-acid", 0.001)], 0.1),
        _solve_case("phosphoric_acid_unsupported", "Triprotic acid, outside v1 monoprotic scope.", [SpeciesAmountInput("phosphoric-acid", 0.001)], 0.1),
        _solve_case("weak_acid_mixture_unsupported", "Two distinct weak-acid systems dosed together.", [SpeciesAmountInput("acetic-acid", 0.001), SpeciesAmountInput("formic-acid", 0.001)], 0.1),
        _solve_case("weak_acid_weak_base_mixture_unsupported", "A weak acid and a weak base dosed together.", [SpeciesAmountInput("acetic-acid", 0.001), SpeciesAmountInput("ammonia", 0.001)], 0.1),
        _solve_case("temperature_out_of_range_unsupported", "500 K exceeds the validated aqueous equilibrium range.", [SpeciesAmountInput("hydrochloric-acid", 0.001)], 0.1, temperature_k=500.0),
        _solve_case("unknown_species_unsupported", "Species id not in the registry.", [SpeciesAmountInput("definitely-not-a-real-species", 0.001)], 0.1),
        _solve_case("negative_volume_failed", "Malformed physical input: negative volume.", [SpeciesAmountInput("hydrochloric-acid", 0.001)], -0.1),
    ]

    return {
        "strong_acid_strong_base_hcl_naoh": _titration_curve_fixture(
            "strong_acid_strong_base_hcl_naoh",
            "25.00 mL of 0.100 M HCl titrated by 0.100 M NaOH at 25 degC: theoretical equivalence at 25.00 mL, pH approx 7 at equivalence (brief benchmark #1).",
            strong_setup,
            fractions,
        ),
        "weak_acid_strong_base_acetic_acid_naoh": _titration_curve_fixture(
            "weak_acid_strong_base_acetic_acid_naoh",
            "25.00 mL of 0.100 M acetic acid titrated by 0.100 M NaOH at 25 degC: pH approx pKa (4.756) at half-equivalence, pH > 7 at equivalence (brief benchmark #2).",
            weak_acid_setup,
            fractions,
        ),
        "weak_base_strong_acid_ammonia_hcl": _titration_curve_fixture(
            "weak_base_strong_acid_ammonia_hcl",
            "25.00 mL of 0.100 M ammonia titrated by 0.100 M hydrochloric acid at 25 degC: pH approx pKa(NH4+) (9.25) at half-equivalence, pH < 7 at equivalence.",
            weak_base_setup,
            fractions,
        ),
        "unsupported_and_failed_cases": {"cases": unsupported_cases},
        "indicators": _indicator_fixture(),
        "species_registry": _species_fixture(),
    }


def write_fixtures() -> None:
    for name, payload in build_all_fixtures().items():
        path = FIXTURES_DIR / f"{name}.json"
        path.write_text(json.dumps(payload, indent=2, sort_keys=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    write_fixtures()
    print(f"Wrote fixtures to {FIXTURES_DIR}")
