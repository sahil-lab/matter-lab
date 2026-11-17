"""API conventions: CORS for the frontend origins, one error shape for every failure, UTC timestamps."""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from matterlab_science.config import DEFAULT_CORS_ORIGINS, load_settings
from matterlab_science.context import AppContext

from .helpers import ASPIRIN, PENTAVALENT_CARBON, is_error_shape, run_job, smiles

FRONTEND_ORIGINS = ["http://127.0.0.1:5273", "http://localhost:5273", "http://127.0.0.1:4273", "http://localhost:4273", "http://tauri.localhost"]
OTHER_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5274", "https://localhost:5273", "http://evil.example", "null"]
UTC_TIMESTAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$")


# ---------------------------------------------------------------------------------------------
# CORS
# ---------------------------------------------------------------------------------------------


def test_default_origins_are_the_web_and_windows_desktop_origins(monkeypatch: pytest.MonkeyPatch) -> None:
    assert list(DEFAULT_CORS_ORIGINS) == FRONTEND_ORIGINS
    monkeypatch.delenv("MATTERLAB_CORS_ORIGINS", raising=False)
    assert list(load_settings().cors_origins) == FRONTEND_ORIGINS
    monkeypatch.setenv("MATTERLAB_CORS_ORIGINS", " http://localhost:9000 , http://127.0.0.1:9000,")
    assert load_settings().cors_origins == ("http://localhost:9000", "http://127.0.0.1:9000")


@pytest.mark.parametrize("origin", FRONTEND_ORIGINS)
def test_preflight_is_answered_for_the_frontend_origins(client: TestClient, origin: str) -> None:
    for method, path in (("POST", "/v1/chem/validate"), ("DELETE", "/v1/jobs/00000000-0000-4000-8000-000000000000"), ("PATCH", "/v1/experiments/x"), ("PUT", "/v1/experiments/x"), ("GET", "/api/v1/lab/scenes")):
        response = client.options(path, headers={"Origin": origin, "Access-Control-Request-Method": method, "Access-Control-Request-Headers": "content-type,authorization"})
        assert response.status_code == 200, (method, path, response.text)
        assert response.headers["access-control-allow-origin"] == origin
        assert method in response.headers["access-control-allow-methods"]
        assert "content-type" in response.headers["access-control-allow-headers"].lower()
        assert "authorization" in response.headers["access-control-allow-headers"].lower()
        assert "access-control-allow-credentials" not in response.headers, "the API does not use browser-managed cookie credentials"


@pytest.mark.parametrize("origin", FRONTEND_ORIGINS)
def test_responses_carry_the_cors_header_for_the_frontend_origins(client: TestClient, origin: str) -> None:
    headers = {"Origin": origin}
    ok = client.get("/v1/engines", headers=headers)
    assert ok.status_code == 200 and ok.headers["access-control-allow-origin"] == origin and "Origin" in ok.headers["vary"]
    # Errors must be readable by the browser too, not masked as CORS failures.
    for response in (
        client.get("/v1/compounds/00000000-0000-4000-8000-000000000000", headers=headers),
        client.post("/v1/chem/3d", json={"structure": smiles(PENTAVALENT_CARBON)}, headers=headers),
        client.post("/v1/chem/validate", content=b"{not json", headers={**headers, "Content-Type": "application/json"}),
        client.get("/nowhere", headers=headers),
    ):
        assert response.status_code in (404, 422) and is_error_shape(response.json())
        assert response.headers["access-control-allow-origin"] == origin
    export = client.get("/v1/excel/format", headers=headers)
    exposed = export.headers["access-control-expose-headers"]
    assert "Content-Disposition" in exposed and "X-MatterLab-Schema-Version" in exposed


@pytest.mark.parametrize("origin", OTHER_ORIGINS)
def test_other_origins_are_not_allowed(client: TestClient, origin: str) -> None:
    response = client.get("/v1/engines", headers={"Origin": origin})
    assert response.status_code == 200, "the request itself is served; the browser withholds the response without the header"
    assert "access-control-allow-origin" not in response.headers
    preflight = client.options("/v1/chem/validate", headers={"Origin": origin, "Access-Control-Request-Method": "POST"})
    assert preflight.status_code == 400 and "access-control-allow-origin" not in preflight.headers


# ---------------------------------------------------------------------------------------------
# Error shape
# ---------------------------------------------------------------------------------------------


def test_every_kind_of_failure_has_the_same_shape(client: TestClient) -> None:
    cases: list[tuple[Any, int, str]] = [
        (client.get("/nowhere"), 404, "not_found"),
        (client.get("/v1/nowhere"), 404, "not_found"),
        (client.get("/v1/compounds/00000000-0000-4000-8000-000000000000"), 404, "not_found"),
        (client.put("/v1/engines"), 405, "method_not_allowed"),
        (client.delete("/v1/chem/validate"), 405, "method_not_allowed"),
        (client.post("/v1/chem/validate", content=b"{not json", headers={"Content-Type": "application/json"}), 422, "validation_error"),
        (client.post("/v1/chem/validate", content=b"structure=CCO", headers={"Content-Type": "application/x-www-form-urlencoded"}), 422, "validation_error"),
        (client.post("/v1/chem/validate"), 422, "validation_error"),
        (client.post("/v1/chem/validate", json=[1, 2, 3]), 422, "validation_error"),
        (client.post("/v1/chem/validate", json={"structure": {"format": "smiles", "data": ""}}), 422, "validation_error"),
        (client.post("/v1/chem/validate", json={"structure": {"format": "xyz", "data": "C"}}), 422, "validation_error"),
        (client.post("/v1/chem/descriptors", json={"structure": smiles("C(C")}), 422, "invalid_structure"),
        (client.post("/v1/compounds/search/substructure", json={"query": {"format": "smarts", "data": "[#6"}}), 422, "invalid_query"),
        (client.get("/v1/jobs", params={"limit": "many"}), 422, "validation_error"),
        (client.get("/v1/jobs/not-a-uuid"), 422, "validation_error"),
        (client.post("/v1/jobs", json={"kind": "rdkit.geometry_optimization", "input": {"structure": smiles("CCO")}, "settings": {"no_such_setting": 1}}), 422, "validation_error"),
        (client.post("/v1/excel/import", files={"file": ("x.xlsx", b"", "application/octet-stream")}), 422, "empty_upload"),
    ]
    for response, status, code in cases:
        where = f"{response.request.method} {response.request.url.path}"
        assert response.status_code == status, f"{where}: {response.status_code} {response.text[:200]}"
        body = response.json()
        assert is_error_shape(body), f"{where}: {body}"
        assert body["error"]["code"] == code, f"{where}: {body}"
        assert body["error"]["message"].strip()
        assert response.headers["content-type"] == "application/json"

    # A validation error says where the problem is.
    body = client.post("/v1/chem/validate", json={"structure": {"format": "xyz", "data": "C"}}).json()
    assert body["error"]["details"][0]["location"] == ["body", "structure", "format"] and body["error"]["details"][0]["message"]
    assert "body.structure.format" in body["error"]["message"]
    # An invalid structure carries RDKit's own words.
    body = client.post("/v1/chem/descriptors", json={"structure": smiles(PENTAVALENT_CARBON)}).json()
    assert "Explicit valence for atom # 1 C, 5, is greater than permitted" in body["error"]["message"]
    assert body["error"]["details"]["engine"]["engine"] == "RDKit"


def test_an_unexpected_failure_is_a_json_500_and_does_not_leak_details(client: TestClient, ctx: AppContext, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
    def broken(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("secret internal detail")

    monkeypatch.setattr(ctx.catalogue, "exact", broken)
    response = client.post("/v1/compounds/search/exact", json={"structure": smiles(ASPIRIN)}, headers={"Origin": FRONTEND_ORIGINS[0]})
    assert response.status_code == 500
    body = response.json()
    assert is_error_shape(body) and body["error"] == {"code": "internal_error", "message": "The service hit an unexpected error. It has been logged.", "details": {"type": "RuntimeError"}}
    assert "secret internal detail" not in response.text
    assert response.headers["access-control-allow-origin"] == FRONTEND_ORIGINS[0], "the browser can read the error"
    logged = [record for record in caplog.records if record.exc_info and "secret internal detail" in str(record.exc_info[1])]
    assert logged and logged[0].levelname == "ERROR", "the cause is in the log"
    monkeypatch.undo()
    assert client.post("/v1/compounds/search/exact", json={"structure": smiles(ASPIRIN)}).status_code == 200, "the service keeps working"


# ---------------------------------------------------------------------------------------------
# Timestamps
# ---------------------------------------------------------------------------------------------


def _timestamps(document: Any, path: str = "") -> Iterator[tuple[str, Any]]:
    """Every value whose key says it is a point in time."""
    if isinstance(document, dict):
        for key, value in document.items():
            where = f"{path}.{key}" if path else key
            if isinstance(value, (dict, list)):
                yield from _timestamps(value, where)
            elif key.endswith("_at") or key in ("time", "timestamp"):
                yield where, value
    elif isinstance(document, list):
        for index, value in enumerate(document):
            yield from _timestamps(value, f"{path}[{index}]")


def test_timestamps_are_iso_8601_utc(client: TestClient) -> None:
    before = datetime.now(timezone.utc) - timedelta(seconds=5)
    job = run_job(client, "rdkit.geometry_optimization", {"structure": smiles("CCO")})
    experiment = client.post("/v1/experiments", json={"title": "Timestamps", "calculation_ids": [job["id"]]}).json()
    candidate = client.post("/v1/discoveries", json={"title": "Timestamps", "structure": smiles("OC(=O)C1CC1c1ccncc1")}).json()
    reaction = client.post("/v1/reactions", json={"name": "Timestamps", "reaction_smiles": "C=C.[H][H]>>CC"}).json()
    compound = client.get("/v1/compounds", params={"name": "aspirin"}).json()["items"][0]
    documents = {
        "health": client.get("/health").json(),
        "engines": client.get("/v1/engines").json(),
        "job": job,
        "jobs": client.get("/v1/jobs", params={"limit": 20}).json(),
        "experiment": experiment,
        "experiments": client.get("/v1/experiments").json(),
        "discovery": candidate,
        "discoveries": client.get("/v1/discoveries").json(),
        "reaction": reaction,
        "data-sources": client.get("/v1/data-sources").json(),
        "compound": client.get(f"/v1/compounds/{compound['id']}").json(),
        "exact-search": client.post("/v1/compounds/search/exact", json={"structure": smiles(ASPIRIN)}).json(),
    }
    after = datetime.now(timezone.utc) + timedelta(seconds=5)
    found = 0
    for name, document in documents.items():
        for where, value in _timestamps(document):
            if value is None:
                continue
            found += 1
            assert isinstance(value, str) and UTC_TIMESTAMP.match(value), f"{name}: {where} = {value!r} is not an ISO 8601 UTC timestamp"
            datetime.fromisoformat(value.replace("Z", "+00:00"))
    assert found > 40, "the walk found the timestamps"
    for name in ("job", "experiment", "discovery", "reaction"):
        created = datetime.fromisoformat(documents[name]["created_at"].replace("Z", "+00:00"))
        assert before <= created <= after, f"{name}.created_at is the current time in UTC, not local time"
    for key in ("time",):
        now = datetime.fromisoformat(documents["health"][key].replace("Z", "+00:00"))
        assert before <= now <= after
    # Dates of retrieval are plain ISO dates.
    retrieved = [s["retrieved_on"] for s in documents["data-sources"]["items"] if s["retrieved_on"]]
    assert retrieved and all(re.fullmatch(r"\d{4}-\d{2}-\d{2}", value) for value in retrieved)
    for path in (f"/v1/experiments/{experiment['id']}", f"/v1/discoveries/{candidate['id']}", f"/v1/reactions/{reaction['id']}"):
        assert client.delete(path).status_code == 204
