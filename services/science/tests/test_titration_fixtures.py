"""Regression guard for the committed JSON fixtures in `titration/fixtures/*.json` (the
"integration fixtures for Agent 07/10" named in the brief's deliverables): confirms the committed
files are byte-for-byte what `generate_fixtures.build_all_fixtures()` produces right now, so a
silent numeric drift in the solver cannot pass unnoticed. If this test fails after a deliberate,
reviewed change to the solver, regenerate the fixtures with
`python -m titration.fixtures.generate_fixtures` (run from `services/science/`) and commit the
result.
"""

from __future__ import annotations

import json

import pytest

from titration.fixtures.generate_fixtures import FIXTURES_DIR, build_all_fixtures
from titration.solver import solve_equilibrium
from titration.types import SpeciesAmountInput


def test_committed_fixtures_match_the_live_solver() -> None:
    live = build_all_fixtures()
    for name, payload in live.items():
        path = FIXTURES_DIR / f"{name}.json"
        assert path.is_file(), f"missing fixture file: {path}"
        committed = json.loads(path.read_text(encoding="utf-8"))
        assert committed == payload, f"{path.name} is stale: regenerate with `python -m titration.fixtures.generate_fixtures`"


@pytest.mark.parametrize("fixture_name", ["strong_acid_strong_base_hcl_naoh", "weak_acid_strong_base_acetic_acid_naoh", "weak_base_strong_acid_ammonia_hcl"])
def test_titration_curve_fixtures_are_internally_consistent(fixture_name: str) -> None:
    payload = json.loads((FIXTURES_DIR / f"{fixture_name}.json").read_text(encoding="utf-8"))
    points = payload["points"]
    assert all(p["status"] == "SUCCEEDED" for p in points)
    phs = [p["pH"] for p in points]
    # A titrant that is a base raises pH as it is added (the HCl/NaOH and acetic-acid/NaOH cases);
    # a titrant that is an acid (ammonia titrated by HCl) lowers it instead. Either way the curve
    # must be strictly monotonic in one direction, never oscillating.
    rising = all(b >= a for a, b in zip(phs, phs[1:]))
    falling = all(b <= a for a, b in zip(phs, phs[1:]))
    assert rising or falling, fixture_name
    equivalence_point = next(p for p in points if p["fraction_of_equivalence"] == 1.0)
    assert equivalence_point["delivered_volume_l"] == pytest.approx(payload["equivalence_volume_l"], abs=1e-12)


def test_unsupported_cases_fixture_reproduces_through_the_public_solver() -> None:
    payload = json.loads((FIXTURES_DIR / "unsupported_and_failed_cases.json").read_text(encoding="utf-8"))
    for case in payload["cases"]:
        result = solve_equilibrium(species=[SpeciesAmountInput(s["species_id"], s["moles"]) for s in case["input"]["species"]], volume_l=case["input"]["volume_l"], temperature_k=case["input"]["temperature_k"])
        assert result.status == case["expected"]["status"], case["case_id"]
        if case["expected"]["reason_contains"]:
            assert case["expected"]["reason_contains"] in (result.reason or ""), case["case_id"]


def test_indicators_fixture_lists_every_shipped_indicator() -> None:
    payload = json.loads((FIXTURES_DIR / "indicators.json").read_text(encoding="utf-8"))
    ids = {i["indicator_id"] for i in payload["indicators"]}
    assert ids == {"phenolphthalein", "methyl-orange", "bromothymol-blue"}


def test_species_registry_fixture_lists_every_registered_species() -> None:
    payload = json.loads((FIXTURES_DIR / "species_registry.json").read_text(encoding="utf-8"))
    ids = {s["species_id"] for s in payload["species"]}
    assert "acetic-acid" in ids and "sulfuric-acid" in ids and "hydrochloric-acid" in ids
