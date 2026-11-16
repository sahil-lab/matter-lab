"""Helpers shared by the tests."""

from __future__ import annotations

import os
import time
from typing import Any

from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator

TERMINAL = ("succeeded", "failed", "cancelled", "unsupported")

ASPIRIN = "CC(=O)Oc1ccccc1C(=O)O"
ASPIRIN_INCHIKEY = "BSYNRYMUTXBXSQ-UHFFFAOYSA-N"
BENZENE_INCHIKEY = "UHOVQNZJYSORNB-UHFFFAOYSA-N"
PENTAVALENT_CARBON = "CC(C)(C)(C)C"
# A long, flexible chain: a conformer search on it keeps a worker busy for a long time.
LONG_CHAIN = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC(=O)OCCCCCCCCCCCCCCCCCCCC"

WATER_ATOMS = [
    {"element": "O", "x": 0.0, "y": 0.0, "z": 0.117},
    {"element": "H", "x": 0.0, "y": 0.757, "z": -0.469},
    {"element": "H", "x": 0.0, "y": -0.757, "z": -0.469},
]


def smiles(text: str) -> dict[str, str]:
    return {"format": "smiles", "data": text}


def submit(client: TestClient, kind: str, job_input: dict[str, Any], settings: dict[str, Any] | None = None, **extra: Any) -> dict[str, Any]:
    body: dict[str, Any] = {"kind": kind, "input": job_input, **extra}
    if settings is not None:
        body["settings"] = settings
    response = client.post("/v1/jobs", json=body)
    assert response.status_code == 202, response.text
    return response.json()


def wait_for_job(client: TestClient, job_id: str, *, statuses: tuple[str, ...] = TERMINAL, timeout: float = 180.0) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    job: dict[str, Any] = {}
    while time.monotonic() < deadline:
        response = client.get(f"/v1/jobs/{job_id}")
        assert response.status_code == 200, response.text
        job = response.json()
        if job["status"] in statuses:
            return job
        time.sleep(0.1)
    raise AssertionError(f"job {job_id} did not reach {statuses} within {timeout} s; last state: {job.get('status')} {job.get('messages')}")


def run_job(client: TestClient, kind: str, job_input: dict[str, Any], settings: dict[str, Any] | None = None, **extra: Any) -> dict[str, Any]:
    return wait_for_job(client, submit(client, kind, job_input, settings, **extra)["id"])


def process_alive(pid: int) -> bool:
    """True while the process exists and is not a zombie."""
    try:
        with open(f"/proc/{pid}/stat", encoding="ascii", errors="replace") as handle:
            state = handle.read().rsplit(")", 1)[1].split()[0]
    except (FileNotFoundError, ProcessLookupError, IndexError):
        return False
    return state != "Z"


def wait_until_dead(pid: int, timeout: float = 15.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not process_alive(pid):
            return True
        time.sleep(0.05)
    return not process_alive(pid)


class Contract:
    """Validates real responses against the OpenAPI schema the service publishes."""

    def __init__(self, spec: dict[str, Any]) -> None:
        self.spec = spec
        self.checked: set[tuple[str, str]] = set()

    def operations(self) -> set[tuple[str, str]]:
        return {(method.upper(), path) for path, item in self.spec["paths"].items() for method in item}

    def _resolve(self, schema: dict[str, Any]) -> dict[str, Any]:
        while "$ref" in schema:
            schema = self.spec["components"]["schemas"][schema["$ref"].rsplit("/", 1)[-1]]
        return schema

    def absent_fields(self, schema: dict[str, Any], instance: Any, path: str = "") -> list[str]:
        """Fields that the schema declares for an object but that the response leaves out.

        The API's convention is that every declared field is present and a missing value is null.
        """
        schema = self._resolve(schema)
        for keyword in ("anyOf", "oneOf"):
            if keyword in schema:
                for option in schema[keyword]:
                    if Draft202012Validator({**self._resolve(option), "components": self.spec["components"]}).is_valid(instance):
                        return self.absent_fields(option, instance, path)
                return []
        absent: list[str] = []
        for option in schema.get("allOf", []):
            absent += self.absent_fields(option, instance, path)
        if isinstance(instance, dict):
            properties = schema.get("properties", {})
            absent += [f"{path}.{name}" for name in properties if name not in instance]
            for name, value in instance.items():
                if name in properties:
                    absent += self.absent_fields(properties[name], value, f"{path}.{name}")
                elif isinstance(schema.get("additionalProperties"), dict):
                    absent += self.absent_fields(schema["additionalProperties"], value, f"{path}.{name}")
        elif isinstance(instance, list) and isinstance(schema.get("items"), dict):
            for index, item in enumerate(instance[:25]):
                absent += self.absent_fields(schema["items"], item, f"{path}[{index}]")
        return absent

    def check(self, method: str, template: str, response: Any) -> Any:
        """Asserts that the status code is documented for the operation, that the JSON body
        validates against the documented schema and that no declared field is left out. Returns
        the parsed body (None for 204)."""
        operation = self.spec["paths"][template][method.lower()]
        documented = operation["responses"].get(str(response.status_code))
        assert documented is not None, f"{method} {template} answered {response.status_code}, which its OpenAPI entry does not document: {response.text[:300]}"
        content = documented.get("content", {})
        body = None
        if "application/json" in content:
            body = response.json()
            schema = {**content["application/json"]["schema"], "components": self.spec["components"]}
            validator = Draft202012Validator(schema, format_checker=Draft202012Validator.FORMAT_CHECKER)
            problems = sorted(validator.iter_errors(body), key=lambda e: list(e.absolute_path))
            assert not problems, f"{method} {template} {response.status_code} does not match its schema: " + "; ".join(
                f"{'/'.join(str(p) for p in e.absolute_path)}: {e.message[:200]}" for e in problems[:5]
            )
            absent = self.absent_fields(content["application/json"]["schema"], body)
            assert not absent, f"{method} {template} {response.status_code} leaves out declared fields: {absent[:8]}"
        elif response.status_code != 204:
            assert response.headers["content-type"].split(";")[0] in content, f"{method} {template}: undocumented content type {response.headers['content-type']}"
        if response.status_code < 400:
            self.checked.add((method.upper(), template))
        return body


def is_error_shape(body: Any) -> bool:
    return (
        isinstance(body, dict)
        and set(body) == {"error"}
        and isinstance(body["error"], dict)
        and set(body["error"]) == {"code", "message", "details"}
        and isinstance(body["error"]["code"], str)
        and isinstance(body["error"]["message"], str)
    )


def running_in_container() -> bool:
    return os.path.exists("/.dockerenv")
