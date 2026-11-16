"""HTTP contract tests for `matterlab_science/api/titration.py`.

Deliberately independent of `conftest.py`'s session-scoped `client` fixture (which boots the full
application against a real PostgreSQL database): the titration router needs no database (see the
module docstring of `api/titration.py`), so these tests build the real application with
`create_app()` -- exercising the actual production wiring in `main.py` -- and drive it with a
`TestClient` that is never entered as a context manager, so the DB-dependent lifespan never runs.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from matterlab_science.main import create_app


@pytest.fixture(scope="module")
def titration_client() -> TestClient:
    app = create_app()
    return TestClient(app)


def test_openapi_schema_includes_every_titration_endpoint(titration_client: TestClient) -> None:
    schema = titration_client.app.openapi()  # type: ignore[attr-defined]
    paths = schema["paths"]
    for path, method in [
        ("/v1/titration/solve", "post"),
        ("/v1/titration/curve", "post"),
        ("/v1/titration/species", "get"),
        ("/v1/titration/indicators", "get"),
        ("/v1/titration/indicators/{indicator_id}/state", "get"),
        ("/v1/titration/endpoint-comparison", "post"),
    ]:
        assert path in paths, path
        assert method in paths[path], (path, method)
        assert "titration" in paths[path][method]["tags"]


def test_solve_endpoint_matches_the_equivalence_benchmark(titration_client: TestClient) -> None:
    response = titration_client.post(
        "/v1/titration/solve",
        json={"species": [{"species_id": "hydrochloric-acid", "moles": 0.0025}, {"species_id": "sodium-hydroxide", "moles": 0.0025}], "volume_l": 0.05},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "SUCCEEDED"
    assert body["pH"] == pytest.approx(7.0, abs=0.01)
    assert body["evidence"] == "MODEL_CALCULATED"
    assert body["model_id"] == "monoprotic-acid-base-electroneutrality-v1"
    assert body["diagnostics"]["charge_balance_residual_molar"] == pytest.approx(0.0, abs=1e-6)
    assert body["reference_quantities"]["kw"] == 1.0e-14


def test_solve_endpoint_reports_unsupported_without_an_error_status_code(titration_client: TestClient) -> None:
    """A syntactically valid request for out-of-scope chemistry is still a 200 with an explicit
    UNSUPPORTED body (see module docstring): the HTTP layer does not swallow or recode the status."""
    response = titration_client.post("/v1/titration/solve", json={"species": [{"species_id": "sulfuric-acid", "moles": 0.001}], "volume_l": 0.1})
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "UNSUPPORTED"
    assert body["pH"] is None
    assert "diprotic" in body["reason"].lower()


def test_solve_endpoint_reports_failed_for_malformed_physical_input(titration_client: TestClient) -> None:
    response = titration_client.post("/v1/titration/solve", json={"species": [{"species_id": "hydrochloric-acid", "moles": 0.001}], "volume_l": -1.0})
    assert response.status_code == 200
    assert response.json()["status"] == "FAILED"


def test_solve_endpoint_rejects_schema_violations_with_422(titration_client: TestClient) -> None:
    missing_volume = titration_client.post("/v1/titration/solve", json={"species": []})
    assert missing_volume.status_code == 422
    negative_moles_rejected_by_schema = titration_client.post("/v1/titration/solve", json={"species": [{"species_id": "x", "moles": -1}], "volume_l": 0.1})
    assert negative_moles_rejected_by_schema.status_code == 422  # moles has ge=0 at the schema level


def test_curve_endpoint_returns_equivalence_and_monotonic_points(titration_client: TestClient) -> None:
    response = titration_client.post(
        "/v1/titration/curve",
        json={
            "setup": {
                "analyte_species_id": "hydrochloric-acid",
                "analyte_concentration_molar": 0.100,
                "analyte_volume_l": 0.02500,
                "titrant_species_id": "sodium-hydroxide",
                "titrant_concentration_molar": 0.100,
            },
            "num_points": 11,
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["equivalence_volume_l"] == pytest.approx(0.025, abs=1e-9)
    assert body["half_equivalence_volume_l"] == pytest.approx(0.0125, abs=1e-9)
    phs = [p["pH"] for p in body["points"]]
    assert all(b >= a for a, b in zip(phs, phs[1:]))


def test_curve_endpoint_accepts_explicit_delivered_volumes(titration_client: TestClient) -> None:
    response = titration_client.post(
        "/v1/titration/curve",
        json={
            "setup": {
                "analyte_species_id": "acetic-acid",
                "analyte_concentration_molar": 0.100,
                "analyte_volume_l": 0.02500,
                "titrant_species_id": "sodium-hydroxide",
                "titrant_concentration_molar": 0.100,
            },
            "delivered_volumes_l": [0.0, 0.0125, 0.025],
        },
    )
    assert response.status_code == 200
    points = response.json()["points"]
    assert len(points) == 3
    assert points[1]["pH"] == pytest.approx(4.756, abs=0.01)  # half-equivalence, pH approx pKa


def test_curve_endpoint_rejects_unresolved_species_with_422(titration_client: TestClient) -> None:
    response = titration_client.post(
        "/v1/titration/curve",
        json={"setup": {"analyte_species_id": "not-a-species", "analyte_concentration_molar": 0.1, "analyte_volume_l": 0.025, "titrant_species_id": "sodium-hydroxide", "titrant_concentration_molar": 0.1}},
    )
    assert response.status_code == 422
    body = response.json()
    assert body["error"]["code"] == "unresolved_titration_species"


def test_species_endpoint_lists_known_entries_with_reasons_for_unsupported_ones(titration_client: TestClient) -> None:
    response = titration_client.get("/v1/titration/species")
    assert response.status_code == 200
    by_id = {s["species_id"]: s for s in response.json()}
    assert by_id["acetic-acid"]["pKa_298_15k"] == pytest.approx(4.756, abs=1e-6)
    assert by_id["acetic-acid"]["unsupported_reason"] is None
    assert by_id["acetic-acid"]["provenance"]["evidence"] == "REFERENCE_MEASURED"
    assert by_id["sulfuric-acid"]["unsupported_reason"] is not None
    assert "diprotic" in by_id["sulfuric-acid"]["unsupported_reason"].lower()


def test_indicators_endpoint_lists_the_three_shipped_indicators(titration_client: TestClient) -> None:
    response = titration_client.get("/v1/titration/indicators")
    assert response.status_code == 200
    ids = {i["indicator_id"] for i in response.json()}
    assert ids == {"phenolphthalein", "methyl-orange", "bromothymol-blue"}
    phph = next(i for i in response.json() if i["indicator_id"] == "phenolphthalein")
    assert phph["acid_color_hex"].startswith("#") and phph["base_color_hex"].startswith("#")
    assert phph["visual_range"] == [8.3, 10.0]


def test_indicator_state_endpoint(titration_client: TestClient) -> None:
    response = titration_client.get("/v1/titration/indicators/phenolphthalein/state", params={"pH": 9.4})
    assert response.status_code == 200
    body = response.json()
    assert body["fraction_base_form"] == pytest.approx(0.5, abs=1e-6)
    assert "transitioning" in body["state_label"]


def test_indicator_state_endpoint_404_for_unknown_indicator(titration_client: TestClient) -> None:
    response = titration_client.get("/v1/titration/indicators/not-a-real-indicator/state", params={"pH": 7.0})
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


def test_endpoint_comparison_endpoint(titration_client: TestClient) -> None:
    response = titration_client.post(
        "/v1/titration/endpoint-comparison",
        json={
            "setup": {
                "analyte_species_id": "hydrochloric-acid",
                "analyte_concentration_molar": 0.100,
                "analyte_volume_l": 0.02500,
                "titrant_species_id": "sodium-hydroxide",
                "titrant_concentration_molar": 0.100,
            },
            "indicator_id": "phenolphthalein",
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["equivalence_volume_l"] == pytest.approx(0.025, abs=1e-9)
    assert body["indicator_endpoint_volume_l"] is not None
    assert "equivalence" in body["explanation"] and "pKin" in body["explanation"]


def test_endpoint_comparison_404_for_unknown_indicator(titration_client: TestClient) -> None:
    response = titration_client.post(
        "/v1/titration/endpoint-comparison",
        json={
            "setup": {
                "analyte_species_id": "hydrochloric-acid",
                "analyte_concentration_molar": 0.1,
                "analyte_volume_l": 0.025,
                "titrant_species_id": "sodium-hydroxide",
                "titrant_concentration_molar": 0.1,
            },
            "indicator_id": "not-a-real-indicator",
        },
    )
    assert response.status_code == 404


def test_solve_endpoint_is_deterministic_across_requests(titration_client: TestClient) -> None:
    payload = {"species": [{"species_id": "acetic-acid", "moles": 0.0025}, {"species_id": "sodium-hydroxide", "moles": 0.00125}], "volume_l": 0.0375}
    first = titration_client.post("/v1/titration/solve", json=payload).json()
    second = titration_client.post("/v1/titration/solve", json=payload).json()
    assert first["pH"] == second["pH"]
    assert first["diagnostics"]["input_hash"] == second["diagnostics"]["input_hash"]
