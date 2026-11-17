"""Build docs/api/science-api.md from the running service.

    python scripts/build_api_reference.py OUTPUT.md

Nothing in the generated reference is typed by hand twice: the endpoint list, parameters, request
fields and status codes are read from the service's own OpenAPI schema, and every example is a
real HTTP exchange with a real instance of the service.

To keep the development database clean the script creates a temporary database on the configured
PostgreSQL server, starts the service against it on a spare port (migrations and seeds run as on
any start), sends the example requests over HTTP, and drops the database again.
"""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import psycopg
from psycopg.conninfo import make_conninfo

SERVICE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_ROOT))

from matterlab_science.config import load_settings  # noqa: E402

PUBLIC_BASE = "http://127.0.0.1:8787"
PORT = 8799
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
TERMINAL = ("succeeded", "failed", "cancelled", "unsupported")
LONG_CHAIN = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC(=O)OCCCCCCCCCCCCCCCCCCCC"
WATER = [
    {"element": "O", "x": 0.0, "y": 0.0, "z": 0.117},
    {"element": "H", "x": 0.0, "y": 0.757, "z": -0.469},
    {"element": "H", "x": 0.0, "y": -0.757, "z": -0.469},
]


# ---------------------------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------------------------


class Client:
    def __init__(self, base: str) -> None:
        self.base = base

    def request(self, method: str, path: str, *, body: Any = None, raw: bytes | None = None, headers: dict[str, str] | None = None) -> tuple[int, dict[str, str], Any]:
        data = raw
        send = dict(headers or {})
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            send["Content-Type"] = "application/json"
        request = urllib.request.Request(self.base + path, data=data, method=method, headers=send)
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                status, received, payload = response.status, dict(response.headers.items()), response.read()
        except urllib.error.HTTPError as error:
            status, received, payload = error.code, dict(error.headers.items()), error.read()
        kind = received.get("content-type", received.get("Content-Type", ""))
        if payload and (kind.startswith("application/json") or kind.startswith("application/problem+json")):
            return status, received, json.loads(payload)
        return status, received, payload

    def json(self, method: str, path: str, body: Any = None) -> Any:
        return self.request(method, path, body=body)[2]

    def wait_for_job(self, job_id: str, statuses: tuple[str, ...] = TERMINAL, timeout: float = 300.0) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        while True:
            job = self.json("GET", f"/v1/jobs/{job_id}")
            if job["status"] in statuses:
                return job
            if time.monotonic() > deadline:
                raise RuntimeError(f"job {job_id} is still {job['status']}")
            time.sleep(0.2)


def multipart(filename: str, content: bytes, media_type: str) -> tuple[bytes, dict[str, str]]:
    boundary = f"matterlab{uuid.uuid4().hex}"
    head = f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\nContent-Type: {media_type}\r\n\r\n'.encode()
    return head + content + f"\r\n--{boundary}--\r\n".encode(), {"Content-Type": f"multipart/form-data; boundary={boundary}"}


# ---------------------------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------------------------


def abbreviate(value: Any, *, items: int = 2, text: int = 160, depth: int = 99) -> Any:
    """Shortens long lists, long texts and (beyond `depth`) nested documents so that examples stay
    readable. Every cut is marked."""
    if isinstance(value, dict):
        if depth <= 0 and value:
            return f"{{… {len(value)} fields}}"
        return {key: abbreviate(item, items=items, text=text, depth=depth - 1) for key, item in value.items()}
    if isinstance(value, list):
        if depth <= 0 and value:
            return f"[… {len(value)} items]"
        if len(value) > items + 1:
            return [abbreviate(item, items=items, text=text, depth=depth - 1) for item in value[:items]] + [f"… {len(value) - items} more"]
        return [abbreviate(item, items=items, text=text, depth=depth - 1) for item in value]
    if isinstance(value, str) and len(value) > text:
        return f"{value[: text - 40]}… ({len(value)} characters)"
    return value


def code(value: Any, language: str = "json") -> str:
    body = value if isinstance(value, str) else json.dumps(value, indent=2, ensure_ascii=False)
    return f"```{language}\n{body}\n```"


def type_of(schema: dict[str, Any], components: dict[str, Any]) -> str:
    if "$ref" in schema:
        return schema["$ref"].rsplit("/", 1)[-1]
    if "anyOf" in schema:
        return " | ".join(dict.fromkeys(type_of(option, components) for option in schema["anyOf"]))
    if "oneOf" in schema:
        return " | ".join(dict.fromkeys(type_of(option, components) for option in schema["oneOf"]))
    if "enum" in schema:
        return " | ".join(f"`{v}`" for v in schema["enum"])
    if "const" in schema:
        return f"`{schema['const']}`"
    kind = schema.get("type")
    if kind == "array":
        return f"array of {type_of(schema.get('items', {}), components)}"
    if kind == "string" and schema.get("format"):
        return f"string ({schema['format']})"
    return str(kind or "any")


def cell(text: Any) -> str:
    return " ".join(str(text).split()).replace("|", "\\|")


def resolve(schema: dict[str, Any], components: dict[str, Any]) -> dict[str, Any]:
    while "$ref" in schema:
        schema = components[schema["$ref"].rsplit("/", 1)[-1]]
    return schema


def fields_table(schema: dict[str, Any], components: dict[str, Any]) -> list[str]:
    schema = resolve(schema, components)
    properties = schema.get("properties", {})
    if not properties:
        return []
    required = set(schema.get("required", []))
    lines = ["| Field | Type | Required | Default | Description |", "|---|---|---|---|---|"]
    for name, spec in properties.items():
        default = f"`{json.dumps(spec['default'])}`" if "default" in spec else ""
        lines.append(f"| `{name}` | {cell(type_of(spec, components))} | {'yes' if name in required else 'no'} | {default} | {cell(spec.get('description', ''))} |")
    return lines


class Document:
    def __init__(self, client: Client, spec: dict[str, Any]) -> None:
        self.client = client
        self.spec = spec
        self.components = spec["components"]["schemas"]
        self.lines: list[str] = []
        self.described: set[tuple[str, str]] = set()

    def add(self, *lines: str) -> None:
        self.lines.extend(lines)
        self.lines.append("")

    def endpoint(self, method: str, path: str) -> None:
        """Heading, summary, description, parameters, request body and status codes of one operation, from the OpenAPI schema."""
        operation = self.spec["paths"][path][method.lower()]
        self.described.add((method, path))
        self.add(f"### `{method} {path}`")
        self.add(f"**{operation['summary']}.**" + (f" {' '.join(operation['description'].split())}" if operation.get("description") else ""))
        parameters = operation.get("parameters", [])
        if parameters:
            rows = ["| Parameter | In | Type | Required | Default | Description |", "|---|---|---|---|---|---|"]
            for parameter in parameters:
                schema = parameter.get("schema", {})
                default = f"`{json.dumps(schema['default'])}`" if "default" in schema else ""
                description = parameter.get("description") or schema.get("description", "")
                rows.append(
                    f"| `{parameter['name']}` | {parameter['in']} | {cell(type_of(schema, self.components))} | {'yes' if parameter.get('required') else 'no'} | {default} | {cell(description)} |"
                )
            self.add(*rows)
        body = operation.get("requestBody", {}).get("content", {})
        if "application/json" in body:
            schema = body["application/json"]["schema"]
            self.add(f"Request body (`application/json`): `{type_of(schema, self.components)}`")
            resolved = resolve(schema, self.components)
            if "oneOf" in resolved or "anyOf" in resolved:
                self.add("One of: " + ", ".join(f"`{type_of(option, self.components)}`" for option in resolved.get("oneOf", resolved.get("anyOf", []))) + " (selected by `kind`).")
            else:
                table = fields_table(schema, self.components)
                if table:
                    self.add(*table)
        elif "multipart/form-data" in body:
            self.add("Request body (`multipart/form-data`): one part named `file` holding the workbook.")
        responses = []
        for status, response in sorted(operation["responses"].items()):
            content = response.get("content", {})
            schema = content.get("application/json", {}).get("schema")
            what = f"`{type_of(schema, self.components)}`" if schema else (", ".join(f"`{media}`" for media in content) or "no body")
            responses.append(f"`{status}` {what}")
        self.add("Responses: " + "; ".join(responses) + ".")

    def example(
        self,
        method: str,
        path: str,
        body: Any = None,
        *,
        title: str | None = None,
        raw: bytes | None = None,
        headers: dict[str, str] | None = None,
        shown_body: str | None = None,
        items: int = 2,
        text: int = 160,
        depth: int = 99,
        show_headers: tuple[str, ...] = (),
    ) -> Any:
        """Performs the request for real and records request and response in the document."""
        status, received, payload = self.client.request(method, path, body=body, raw=raw, headers=headers)
        if title:
            self.add(f"*{title}*")
        request_lines = [f"{method} {path}"]
        if body is not None:
            request_lines.append(json.dumps(body, ensure_ascii=False))
        elif shown_body:
            request_lines.append(shown_body)
        self.add(code("\n".join(request_lines), "http"))
        lower = {key.lower(): value for key, value in received.items()}
        head = [f"HTTP {status}"] + [f"{name}: {lower[name.lower()]}" for name in show_headers if name.lower() in lower]
        if isinstance(payload, (dict, list)):
            self.add(code("\n".join(head), "http") if len(head) > 1 else f"`{head[0]}`", code(abbreviate(payload, items=items, text=text, depth=depth)))
        elif payload:
            self.add(code("\n".join(head) + f"\n\n({len(payload)} bytes of binary content)", "http"))
        else:
            self.add(f"`{head[0]}` (no body)")
        return payload


# ---------------------------------------------------------------------------------------------
# The reference
# ---------------------------------------------------------------------------------------------


def smiles(text: str) -> dict[str, str]:
    return {"format": "smiles", "data": text}


def build(client: Client) -> str:
    spec = client.json("GET", "/openapi.json")
    doc = Document(client, spec)
    health = client.json("GET", "/health")
    engines = {e["id"]: e for e in client.json("GET", "/v1/engines")["engines"]}
    operations = [(method.upper(), path, operation) for path, item in spec["paths"].items() for method, operation in item.items()]

    doc.add("# MATTER LAB science API")
    doc.add(
        "<!-- Generated by services/science/scripts/build_api_reference.py. Do not edit by hand: change the script or the service and regenerate. -->"
    )
    doc.add(
        f"Reference for the science service, version {health['version']}. Base URL of the development stack: **`{PUBLIC_BASE}`** "
        "(`docker compose -p matterlab up -d`). Interactive documentation: `/docs`; machine-readable schema: `/openapi.json` "
        "(a copy is in [`openapi.json`](openapi.json))."
    )
    versions = ", ".join(f"{e['name']} {e['version']}" if e["available"] else f"{e['name']} not installed" for e in engines.values())
    doc.add(
        "**How this file was made.** The endpoint list, parameters, request fields and status codes below are read from the service's OpenAPI schema. "
        f"Every example is a real HTTP exchange, captured on {datetime.now(timezone.utc).strftime('%Y-%m-%d')} from the service running on a freshly migrated "
        f"and seeded database (schema version {health['database']['schema_version']}; engines: {versions}). Nothing in the examples was edited, with one exception that is always "
        "marked: long lists are cut to their first items followed by `\"… N more\"`, long texts end in `… (N characters)`, and in a few places a nested document is "
        "replaced by `\"{… N fields}\"` or `\"[… N items]\"`."
    )

    doc.add("## Conventions")
    doc.add(
        "- **JSON everywhere.** Request and response bodies are JSON (the workbook export and upload excepted).",
        "- **Legacy errors.** Legacy `/v1` non-2xx responses are `{\"error\": {\"code\": \"...\", \"message\": \"...\", \"details\": ...}}`. `code` is stable and machine-readable; "
        "`details` depends on the code (for `validation_error` it is a list of `{location, message, type}`). See [Errors](#errors).",
        "- **Laboratory authentication/errors.** `/api/v1/lab` requires a scoped bearer token and uses RFC 9457 problem details. Owner isolation, revision checks, "
        "shared Node replay and export semantics are documented in [LABORATORY.md](../../services/science/LABORATORY.md). Legacy `/v1` remains a local shared API.",
        "- **Units.** Molecular coordinates are in angstrom; laboratory apparatus coordinates are meters. Every numeric field carries its unit in its name (`energy_hartree`, `melting_point_k`, `molecular_weight_g_per_mol`) "
        "or in a `units`/`unit` field next to it.",
        "- **Time.** Timestamps are ISO 8601 in UTC with a `Z` suffix. Retrieval dates are ISO dates.",
        "- **Nulls.** Legacy response fields are present with `null` for absent values. Versioned laboratory DTOs also have explicitly optional fields; consult their schema.",
        "- **Identifiers.** Records have UUIDs. Catalogue compounds, solvents and catalysts have name-based (version 5) UUIDs derived from the InChIKey or the name, "
        "so the same record has the same id in every instance.",
        "- **Provenance.** Every stored record has a source in the registry (`GET /v1/data-sources`). List responses carry `items[].source` (a key into the page's "
        "`sources` map); detail responses embed a `provenance` object with source, version, URL, retrieval date, licence (where the source states one) and citations. "
        "The object has the fields of the `Provenance` type of `packages/core` (`source`, `version`, `citations`, `url`, `retrieved`, `license`, `notes`) plus "
        "`source_key`, `kind` and `publisher`.",
        "- **Evidence labels.** `reference` (taken from a published dataset or service), `computed` (calculated by an engine from the given input), `rule-based` "
        "(an empirical model or a pattern definition), `user-input` (typed in or imported; not verified by the service), `unsupported`, `illustrative` (never assigned by the service itself).",
        "- **No invented results.** A structure RDKit rejects comes back with RDKit's own messages. A calculation an engine cannot do ends as `unsupported` or `failed` "
        "with the reason; such a job has no `result`. A search that finds nothing says which catalogue was searched, how many records it held and when, and nothing more.",
        "- **CORS.** Allowed origins: `http://127.0.0.1:5273`, `http://localhost:5273`, `http://127.0.0.1:4273`, `http://localhost:4273`, `http://tauri.localhost` "
        "(setting `MATTERLAB_CORS_ORIGINS`).",
    )

    doc.add("## Endpoints")
    rows = ["| Method | Path | Purpose |", "|---|---|---|"]
    for method, path, operation in operations:
        rows.append(f"| `{method}` | `{path}` | {cell(operation['summary'])} |")
    doc.add(*rows)

    doc.add("## Authenticated instrument laboratory")
    doc.add(
        "These additive endpoints share the versioned browser contracts and solver/runtime, not a second chemistry implementation. "
        "See [LABORATORY.md](../../services/science/LABORATORY.md) for units, credential provisioning, immutable replay and resource bounds."
    )
    for method, path, _ in operations:
        if path.startswith("/api/v1/lab"):
            doc.endpoint(method, path)
    doc.example("GET", "/api/v1/lab/scenes", title="A missing bearer credential is rejected")

    # ------------------------------------------------------------------ service
    doc.add("## Service")
    doc.endpoint("GET", "/")
    doc.example("GET", "/")
    doc.endpoint("GET", "/health")
    doc.example("GET", "/health")
    doc.endpoint("GET", "/v1/engines")
    doc.add(
        "An engine is listed as available only after it has been imported and has completed a small real calculation in this instance (`self_test`). "
        "Job kinds of an engine that is not available answer with status `unsupported`."
    )
    doc.example("GET", "/v1/engines", items=3)

    # ------------------------------------------------------------------ chemistry
    doc.add("## Chemistry (synchronous, RDKit)")
    doc.add("A structure is always given as `{\"format\": \"smiles\" | \"molblock\", \"data\": \"...\"}`.")
    doc.endpoint("POST", "/v1/chem/validate")
    doc.example("POST", "/v1/chem/validate", {"structure": smiles("c1ccccc1")}, title="Benzene")
    doc.example("POST", "/v1/chem/validate", {"structure": smiles("CC(C)(C)(C)C")}, title="A carbon with five bonds: a normal answer (HTTP 200) with `valid: false` and RDKit's message")
    doc.endpoint("POST", "/v1/chem/3d")
    doc.example("POST", "/v1/chem/3d", {"structure": smiles("CCO")}, title="Ethanol")
    doc.example("POST", "/v1/chem/3d", {"structure": smiles("CB(O)O")}, title="MMFF94 has no parameters for boron here, so UFF is used, and the response says so", items=1)
    doc.endpoint("POST", "/v1/chem/descriptors")
    doc.example("POST", "/v1/chem/descriptors", {"structure": smiles("CC(=O)Oc1ccccc1C(=O)O")}, title="Aspirin")
    doc.endpoint("POST", "/v1/chem/functional-groups")
    doc.example(
        "POST",
        "/v1/chem/functional-groups",
        {"structure": smiles("CC(=O)Oc1ccccc1C(=O)O"), "sets": ["rdkit-functional-group-hierarchy"]},
        title="Aspirin against one of the three definition sets",
    )

    # ------------------------------------------------------------------ jobs
    doc.add("## Jobs (asynchronous calculations)")
    doc.add(
        "A job is accepted with `202` and runs in a worker process of its own, so the API stays responsive. Poll `GET /v1/jobs/{id}` until `status` is terminal. "
        "Statuses: `queued`, `running`, `succeeded`, `failed`, `cancelled`, `unsupported`. Every job is a row of the `calculations` table and keeps its kind, input, "
        "settings (with defaults filled in), `input_hash`, engine and versions, timestamps, messages, and its result or error.",
        "",
        "`input_hash` is the SHA-256 of the canonical JSON (sorted keys, no insignificant whitespace) of `{kind, input, settings}` after defaults have been applied; "
        "`timeout_seconds` is not part of it. The same request always has the same hash, so earlier runs can be found with `GET /v1/jobs?input_hash=...`.",
        "",
        "`DELETE /v1/jobs/{id}` cancels: a queued job at once, a running job by terminating its worker process (SIGTERM, then SIGKILL after 3 s). "
        "A job that exceeds its time limit, or whose worker dies, ends as `failed` with error code `timeout` or `worker_crashed`.",
    )
    doc.endpoint("GET", "/v1/job-kinds")
    kinds = client.json("GET", "/v1/job-kinds")["kinds"]
    rows = ["| Kind | Engine | Available here | What it does |", "|---|---|---|---|"]
    for kind in kinds:
        rows.append(f"| `{kind['kind']}` | {kind['engine']} | {'yes' if kind['available'] else 'no: ' + cell('; '.join(kind['unavailable_reasons']))} | {cell(kind['description'])} |")
    doc.add(*rows)
    for kind in kinds:
        doc.add(f"Settings of `{kind['kind']}`:")
        rows = ["| Setting | Type | Default | Description |", "|---|---|---|---|"]
        definitions = kind["settings_schema"].get("$defs", {})
        for name, schema in kind["settings_schema"].get("properties", {}).items():
            default = f"`{json.dumps(schema['default'])}`" if "default" in schema else ""
            rows.append(f"| `{name}` | {cell(type_of(schema, definitions))} | {default} | {cell(schema.get('description', ''))} |")
        doc.add(*rows)
    doc.add(
        "Input of the `rdkit.*` kinds: `{\"structure\": {format, data}}` (coordinates in a molblock are used as the starting geometry). "
        "Input of the `xtb.*` and `pyscf.*` kinds: `{\"structure\": ..., \"charge\": int, \"multiplicity\": int}`, where the structure may also be "
        "`{\"format\": \"atoms\", \"atoms\": [{\"element\", \"x\", \"y\", \"z\"}]}` with coordinates in angstrom. The full schemas, including the result of every kind, "
        "are in the response of `GET /v1/job-kinds`."
    )
    doc.example("GET", "/v1/job-kinds", items=1, text=120, depth=4)

    doc.endpoint("POST", "/v1/jobs")
    accepted = doc.example("POST", "/v1/jobs", {"kind": "rdkit.geometry_optimization", "input": {"structure": smiles("CCO")}}, title="Submit: MMFF94 geometry optimisation of ethanol")
    client.wait_for_job(accepted["id"])
    doc.endpoint("GET", "/v1/jobs/{job_id}")
    done = doc.example("GET", f"/v1/jobs/{accepted['id']}", title="The same job once it has finished")
    doc.add("*A failure is reported, never hidden: the same job kind with a structure RDKit rejects*")
    failed = client.json("POST", "/v1/jobs", {"kind": "rdkit.geometry_optimization", "input": {"structure": smiles("CC(C)(C)(C)C")}})
    client.wait_for_job(failed["id"])
    doc.example("GET", f"/v1/jobs/{failed['id']}")
    doc.add("*`unsupported`: neither MMFF94 nor UFF has parameters for xenon difluoride, so no geometry is returned*")
    unsupported = client.json("POST", "/v1/jobs", {"kind": "rdkit.geometry_optimization", "input": {"structure": smiles("F[Xe]F")}})
    client.wait_for_job(unsupported["id"])
    doc.example("GET", f"/v1/jobs/{unsupported['id']}")

    water = {"structure": {"format": "atoms", "atoms": WATER}}
    if engines["xtb"]["available"]:
        job = client.json("POST", "/v1/jobs", {"kind": "xtb.single_point", "input": water})
        client.wait_for_job(job["id"])
        doc.example("GET", f"/v1/jobs/{job['id']}", title="GFN2-xTB single point on water (tblite)", items=3)
    if engines["pyscf"]["available"]:
        job = client.json("POST", "/v1/jobs", {"kind": "pyscf.single_point", "input": water, "settings": {"method": "dft", "functional": "b3lyp", "basis": "6-31g"}})
        client.wait_for_job(job["id"])
        doc.example("GET", f"/v1/jobs/{job['id']}", title="B3LYP/6-31G single point on water (PySCF)", items=3)

    doc.endpoint("DELETE", "/v1/jobs/{job_id}")
    long_job = client.json("POST", "/v1/jobs", {"kind": "rdkit.conformer_search", "input": {"structure": smiles(LONG_CHAIN)}, "settings": {"num_conformers": 2000, "max_iterations": 100000}})
    client.wait_for_job(long_job["id"], statuses=("running", *TERMINAL))
    time.sleep(1.0)
    doc.example("DELETE", f"/v1/jobs/{long_job['id']}", title="Cancel a running conformer search")
    client.wait_for_job(long_job["id"])
    doc.example("GET", f"/v1/jobs/{long_job['id']}", title="Shortly afterwards: the worker process is gone and the job is `cancelled`")
    doc.endpoint("GET", "/v1/jobs")
    doc.example("GET", f"/v1/jobs?input_hash={done['input_hash']}", title="All runs of one request")

    # ------------------------------------------------------------------ reference data
    doc.add("## Reference data")
    doc.endpoint("GET", "/v1/data-sources")
    doc.example("GET", "/v1/data-sources", items=2)
    doc.endpoint("GET", "/v1/elements")
    doc.example("GET", "/v1/elements", items=1)
    doc.endpoint("GET", "/v1/elements/{element}")
    doc.example("GET", "/v1/elements/Fe", items=3)
    doc.endpoint("GET", "/v1/isotopes")
    doc.example("GET", "/v1/isotopes?symbol=H&stability=R", items=2)
    doc.endpoint("GET", "/v1/functional-groups/sets")
    doc.example("GET", "/v1/functional-groups/sets", items=3)
    doc.endpoint("GET", "/v1/functional-groups")
    doc.example("GET", "/v1/functional-groups?group_set=rdkit-functional-groups&limit=2")
    doc.add(
        "Solvents and catalysts hold names, identifiers and structures only. The single stored property is the molecular weight that PubChem returned, "
        "kept together with its source. No boiling points, polarities or similar numbers are stored, because none were retrieved from a citable source."
    )
    doc.endpoint("GET", "/v1/solvents")
    solvents = doc.example("GET", "/v1/solvents?limit=2")
    doc.endpoint("GET", "/v1/solvents/{solvent_id}")
    doc.example("GET", f"/v1/solvents/{solvents['items'][0]['id']}")
    doc.endpoint("GET", "/v1/catalysts")
    catalysts = doc.example("GET", "/v1/catalysts?limit=2")
    doc.endpoint("GET", "/v1/catalysts/{catalyst_id}")
    doc.example("GET", f"/v1/catalysts/{catalysts['items'][0]['id']}")

    # ------------------------------------------------------------------ catalogue
    doc.add("## Compound catalogue and search")
    doc.add(
        "The catalogue is a starter set of common compounds retrieved from PubChem (see `services/science/seed/pubchem/snapshot.json`). Canonical SMILES, InChI, "
        "InChIKey, formula, masses and fingerprints are computed by RDKit from the structure PubChem returned.",
        "",
        "**Where the searches run.** Exact lookups by InChIKey, name, formula or CID are answered by PostgreSQL from stored columns. Substructure and similarity "
        "searches run *in the science service* with RDKit, on the catalogue rows (structures and stored fingerprints) loaded from PostgreSQL. PostgreSQL has no "
        "chemistry cartridge in this stack. Every search response has a `scope` that states the catalogue, the number of records searched, the time and the method.",
    )
    doc.endpoint("GET", "/v1/compounds")
    compounds = doc.example("GET", "/v1/compounds?name=aspirin")
    doc.example("GET", "/v1/compounds?formula=C2H6O", title="By formula (isomers share a formula)")
    doc.endpoint("POST", "/v1/compounds/search/exact")
    doc.example("POST", "/v1/compounds/search/exact", {"structure": smiles("OC(=O)c1ccccc1OC(C)=O")}, title="Aspirin, written differently")
    doc.example("POST", "/v1/compounds/search/exact", {"structure": smiles("OC(=O)C1CC1c1ccncc1")}, title="A structure that is not in the catalogue: an empty result and its scope, nothing more")
    doc.endpoint("POST", "/v1/compounds/search/substructure")
    doc.example("POST", "/v1/compounds/search/substructure", {"query": {"format": "smarts", "data": "c1ccccc1C(=O)[OH]"}, "limit": 3}, title="Benzoic acids")
    doc.endpoint("POST", "/v1/compounds/search/similarity")
    doc.example("POST", "/v1/compounds/search/similarity", {"structure": smiles("CC(=O)Oc1ccccc1C(=O)O"), "threshold": 0.4, "limit": 3}, title="Neighbours of aspirin")
    doc.endpoint("GET", "/v1/compounds/{compound_id}")
    doc.example("GET", f"/v1/compounds/{compounds['items'][0]['id']}", items=3)

    # ------------------------------------------------------------------ reactions
    doc.add("## Reactions")
    doc.add("A reaction is stored as a reaction SMILES that RDKit has parsed. The service checks the atom balance and records it; it does not predict products, yields or rates.")
    doc.endpoint("POST", "/v1/reactions")
    reaction = doc.example("POST", "/v1/reactions", {"name": "Hydrogenation of ethene", "reaction_smiles": "C=C.[H][H]>>CC", "temperature_k": 298.15})
    doc.endpoint("GET", "/v1/reactions")
    doc.example("GET", "/v1/reactions")
    doc.endpoint("GET", "/v1/reactions/{reaction_id}")
    doc.add(f"Returns the document shown for `POST /v1/reactions` (here: `GET /v1/reactions/{reaction['id']}`).")
    doc.endpoint("DELETE", "/v1/reactions/{reaction_id}")

    # ------------------------------------------------------------------ experiments
    doc.add("## Experiments")
    doc.add(
        "An experiment stores what the client needs to reopen a piece of work: `inputs`, `settings` and `results` are client-defined JSON documents kept verbatim, "
        "and `calculation_ids` links jobs. Computed results stay in the jobs. `revision` increases with every change; pass `expected_revision` to refuse a lost update (409)."
    )
    doc.endpoint("POST", "/v1/experiments")
    experiment = doc.example(
        "POST",
        "/v1/experiments",
        {
            "title": "Ethanol geometry",
            "kind": "molecule",
            "inputs": {"structure": smiles("CCO")},
            "settings": {"force_field": "auto"},
            "tags": ["demo"],
            "reaction_id": reaction["id"],
            "calculation_ids": [done["id"]],
        },
    )
    doc.endpoint("GET", "/v1/experiments/{experiment_id}")
    doc.add("Returns the same document as `POST /v1/experiments`.")
    doc.endpoint("PATCH", "/v1/experiments/{experiment_id}")
    doc.example("PATCH", f"/v1/experiments/{experiment['id']}", {"notes": "Converged in the first run.", "expected_revision": 1}, items=1)
    doc.example("PATCH", f"/v1/experiments/{experiment['id']}", {"notes": "A second writer with a stale copy", "expected_revision": 1}, title="A stale revision is refused")
    doc.endpoint("PUT", "/v1/experiments/{experiment_id}")
    doc.endpoint("POST", "/v1/experiments/{experiment_id}/rerun")
    rerun = doc.example("POST", f"/v1/experiments/{experiment['id']}/rerun", items=1)
    for submitted in rerun["submitted"]:
        client.wait_for_job(submitted["id"])
    doc.endpoint("GET", "/v1/experiments")
    doc.example("GET", "/v1/experiments?tag=demo")
    doc.endpoint("DELETE", "/v1/experiments/{experiment_id}")
    doc.add("Answers `204` without a body. The linked calculations are kept.")

    # ------------------------------------------------------------------ discoveries
    doc.add("## Discovery candidates")
    doc.add(
        "A candidate is a structure a user proposes. The service normalises it with RDKit, searches the local catalogue (exact InChIKey and Morgan/Tanimoto similarity) "
        "and, only when asked with `query_pubchem: true`, asks PubChem for the InChIKey. Every step is written to an append-only evidence trail.",
        "",
        "The status ladder, in order: `user-created`, `structurally-validated`, `no-match-in-searched-catalogs`, `computationally-plausible`, `experimentally-observed`, "
        "`independently-validated`. The service sets the first three. The later rungs are requested by the user, one at a time, and each needs its evidence: a succeeded, "
        "converged calculation on the same structure; an experimental observation with a reference; an independent validation with a reference. The service records "
        "user evidence as asserted by the user and does not verify it.",
        "",
        "**What `no-match-in-searched-catalogs` means.** Exactly what it says: the catalogues listed in `searched_catalogs` had no record with this InChIKey at the stated "
        "times. `searched_catalogs` always names each catalogue, the number of records searched (when the catalogue reports it) and when. No response describes a candidate "
        "as new or previously unknown; an absent match is not evidence of that. A failed external lookup is recorded as `error` and does not count as a search. A later "
        "match in any catalogue returns the candidate to `structurally-validated`.",
    )
    doc.endpoint("POST", "/v1/discoveries")
    candidate = doc.example(
        "POST", "/v1/discoveries", {"title": "Candidate A", "structure": smiles("OC(=O)C1CC1c1ccncc1")}, title="A structure that is not in the local catalogue", items=3, text=500
    )
    known = doc.example("POST", "/v1/discoveries", {"title": "Rediscovered", "structure": smiles("CC(=O)Oc1ccccc1C(=O)O")}, title="A structure that is in the catalogue stays at `structurally-validated`", items=1, depth=3)
    doc.endpoint("POST", "/v1/discoveries/{discovery_id}/searches")
    doc.add(
        "With `{\"query_pubchem\": true}` the service sends one request to PubChem PUG REST (`/compound/inchikey/<key>/cids/JSON`) and records the request URL, the time, "
        "the HTTP status and the outcome. The example below repeats the local searches only."
    )
    doc.example("POST", f"/v1/discoveries/{candidate['id']}/searches", {}, items=1, depth=3)
    doc.endpoint("POST", "/v1/discoveries/{discovery_id}/evidence")
    job = client.json("POST", "/v1/jobs", {"kind": "rdkit.geometry_optimization", "input": {"structure": smiles("OC(=O)C1CC1c1ccncc1")}})
    client.wait_for_job(job["id"])
    doc.example("POST", f"/v1/discoveries/{candidate['id']}/evidence", {"kind": "calculation", "calculation_id": job["id"]}, title="Attach a finished calculation", items=1, depth=3)
    doc.endpoint("POST", "/v1/discoveries/{discovery_id}/status")
    doc.example(
        "POST",
        f"/v1/discoveries/{candidate['id']}/status",
        {"status": "independently-validated", "justification": "skipping ahead"},
        title="Rungs cannot be skipped",
    )
    doc.example(
        "POST",
        f"/v1/discoveries/{candidate['id']}/status",
        {"status": "computationally-plausible", "justification": "MMFF94 optimisation converged"},
        title="One rung up, backed by the attached calculation",
        items=1,
        depth=3,
    )
    doc.endpoint("GET", "/v1/discoveries/{discovery_id}")
    doc.example("GET", f"/v1/discoveries/{candidate['id']}", title="The candidate with its searches and its complete evidence trail", items=12, text=400)
    doc.endpoint("PATCH", "/v1/discoveries/{discovery_id}")
    doc.endpoint("GET", "/v1/discoveries")
    doc.example("GET", "/v1/discoveries")
    doc.endpoint("DELETE", "/v1/discoveries/{discovery_id}")
    doc.example("DELETE", f"/v1/discoveries/{known['id']}")

    # ------------------------------------------------------------------ excel
    doc.add("## Excel")
    doc.add(
        "PostgreSQL is the authoritative store; a workbook is an interchange copy. The export has exactly ten worksheets, in this order: "
        + ", ".join(sheet["name"] for sheet in client.json("GET", "/v1/excel/format")["sheets"])
        + ". Units are part of the header text (`Atomic mass (u)`), every row ends with six provenance columns, and export time, schema version and service version "
        "are written to the workbook's document properties (and repeated in the response headers).",
        "",
        "Import rules:",
        "- Sheet names and headers are checked first. An unknown sheet, an unknown column, or a header in another unit (`Melting point (C)`) rejects the whole workbook (422 `workbook_rejected`); nothing is written.",
        "- A workbook may contain any subset of the ten sheets. Read-only columns (derived values such as InChI or formula) may be left out; they are recomputed by RDKit and never trusted.",
        "- Rows are validated one by one: cell types, required values, references, and chemistry (RDKit parses every SMILES, SMARTS and reaction SMILES). "
        "Invalid rows are listed with sheet, row, column, code and message; valid rows are applied.",
        "- Everything happens in one transaction, and what a row writes is written inside its own savepoint. `atomic=true` writes nothing unless every row is valid; `dry_run=true` never writes.",
        "- A row that is identical to the database is left untouched and keeps its provenance. Numbers are compared to a relative tolerance of 1e-14, "
        "because a worksheet cell stores 16 significant digits.",
        "- A new or changed row gets the workbook as its provenance (file name, SHA-256, time) together with the source named in the row's `Source` columns, recorded "
        "as declared and not verified. Such records are labelled `user-input`.",
        "- Calculations cannot be changed by import, and a finished calculation is accepted only if its input hash matches its kind, input and settings. "
        "The status, structure, searches and evidence of an existing discovery candidate cannot be changed by import.",
        "- A cell holds at most 32,767 characters. On export a longer value is left out and its header is listed in `Omitted fields`; on import such a field keeps its "
        "stored value, and a record that does not exist yet is refused (`omitted_field`) rather than stored incomplete.",
        "- Every import, applied or not, is logged in the `data_imports` table.",
    )
    doc.endpoint("GET", "/v1/excel/format")
    layout = doc.example("GET", "/v1/excel/format", items=2)
    doc.endpoint("GET", "/v1/excel/export")
    status, headers, workbook_bytes = client.request("GET", "/v1/excel/export")
    lower = {key.lower(): value for key, value in headers.items()}
    doc.add(
        code(
            "GET /v1/excel/export\n\n"
            f"HTTP {status}\n"
            + "\n".join(f"{name}: {lower[name.lower()]}" for name in ("Content-Type", "Content-Disposition", "X-MatterLab-Schema-Version", "X-MatterLab-Exported-At"))
            + f"\n\n({len(workbook_bytes)} bytes: the .xlsx workbook)",
            "http",
        )
    )
    from openpyxl import Workbook, load_workbook

    exported = load_workbook(io.BytesIO(workbook_bytes), read_only=True)
    rows = ["| Worksheet | Rows in this export |", "|---|---|"]
    for name in exported.sheetnames:
        rows.append(f"| {name} | {sum(1 for _ in exported[name].iter_rows(min_row=2))} |")
    doc.add(*rows)

    doc.endpoint("POST", "/v1/excel/import")
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Compounds"
    columns = [column["header"] for column in next(s for s in layout_full(client) if s["name"] == "Compounds")["columns"]]
    sheet.append(columns)
    for values in ({"Name": "Phenacetin", "Canonical SMILES": "CCOc1ccc(NC(C)=O)cc1", "Source title": "Lab inventory", "Source version": "2026"}, {"Name": "Broken entry", "Canonical SMILES": "C(C"}):
        sheet.append([values.get(header) for header in columns])
    buffer = io.BytesIO()
    workbook.save(buffer)
    raw, upload_headers = multipart("lab-compounds.xlsx", buffer.getvalue(), XLSX)
    doc.example(
        "POST",
        "/v1/excel/import",
        raw=raw,
        headers=upload_headers,
        shown_body="(multipart upload of lab-compounds.xlsx: a `Compounds` sheet with two rows, one of them with the SMILES `C(C`)",
        title="A workbook with one valid and one invalid row",
        items=2,
    )
    doc.example("GET", "/v1/compounds?name=Phenacetin", title="The valid row is in the catalogue, labelled as imported")

    # ------------------------------------------------------------------ errors
    doc.add("## Errors")
    rows = ["| Status | `code` | When |", "|---|---|---|"]
    for status_code, error_code, when in (
        (404, "not_found", "The path or the record does not exist."),
        (405, "method_not_allowed", "The path exists but not with this method."),
        (409, "revision_conflict, status_transition_not_allowed, structure_not_valid", "The request conflicts with the state of the record. `details` holds the current state."),
        (413, "payload_too_large", "An uploaded workbook exceeds `MATTERLAB_MAX_UPLOAD_BYTES`."),
        (422, "validation_error", "The request does not match the schema. `details` lists `{location, message, type}`."),
        (422, "invalid_structure", "RDKit could not interpret the structure. `message` and `details.errors` carry RDKit's own messages and the atoms concerned."),
        (
            422,
            "invalid_query, invalid_reaction, structure_too_large, unknown_reference, unknown_functional_group_set, no_inchikey, external_lookups_disabled, empty_upload, workbook_rejected",
            "Other well-formed requests that cannot be carried out; the message says why.",
        ),
        (500, "internal_error", "An unexpected failure. It is logged; the response carries only the exception type."),
        (503, "database_unavailable, database_error", "PostgreSQL cannot be reached or could not complete the request. Documented on every operation that uses the database; `Retry-After` is set."),
    ):
        rows.append(f"| {status_code} | `{error_code}` | {when} |")
    doc.add(*rows)
    doc.example("GET", f"/v1/compounds/{uuid.UUID(int=0)}", title="Not found")
    doc.example("POST", "/v1/chem/validate", {"structure": {"format": "xyz", "data": "C"}}, title="Schema violation")
    doc.example("POST", "/v1/chem/3d", {"structure": smiles("CC(C)(C)(C)C")}, title="A structure RDKit rejects")
    doc.example("POST", "/v1/compounds/search/substructure", {"query": {"format": "smarts", "data": "[#6"}}, title="An unparseable SMARTS query")

    missing = sorted(set((method, path) for method, path, _ in operations) - doc.described)
    if missing:
        raise SystemExit(f"operations without a section in the reference: {missing}")
    return "\n".join(doc.lines).rstrip() + "\n"


def layout_full(client: Client) -> list[dict[str, Any]]:
    return client.json("GET", "/v1/excel/format")["sheets"]


# ---------------------------------------------------------------------------------------------
# Temporary instance
# ---------------------------------------------------------------------------------------------


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        print(__doc__)
        return 2
    output = Path(argv[0])
    settings = load_settings()
    name = f"matterlab_docs_{uuid.uuid4().hex[:12]}"
    admin = make_conninfo(settings.database_conninfo, dbname="postgres")
    with psycopg.connect(admin, autocommit=True) as conn:
        conn.execute(f'CREATE DATABASE "{name}"')
    environment = {**os.environ, "MATTERLAB_DB_NAME": name, "MATTERLAB_DATABASE_URL": "", "MATTERLAB_PORT": str(PORT), "MATTERLAB_HOST": "127.0.0.1", "MATTERLAB_LOG_LEVEL": "WARNING"}
    server = subprocess.Popen([sys.executable, "-m", "matterlab_science", "serve"], cwd=str(SERVICE_ROOT), env=environment)
    client = Client(f"http://127.0.0.1:{PORT}")
    try:
        deadline = time.monotonic() + 180
        while True:
            try:
                if client.request("GET", "/health")[0] == 200:
                    break
            except (urllib.error.URLError, ConnectionError):
                pass
            if server.poll() is not None:
                raise RuntimeError(f"the service exited with code {server.returncode} during start-up")
            if time.monotonic() > deadline:
                raise RuntimeError("the service did not become healthy within 180 s")
            time.sleep(0.5)
        output.write_text(build(client), encoding="utf-8")
        print(f"wrote {output}", file=sys.stderr)
    finally:
        server.terminate()
        try:
            server.wait(timeout=30)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait(timeout=10)
        with psycopg.connect(admin, autocommit=True) as conn:
            conn.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
