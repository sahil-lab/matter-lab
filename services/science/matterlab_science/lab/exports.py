"""Scoped JSON archives and readable, non-executable laboratory workbooks."""

from __future__ import annotations

import io
import re
from datetime import datetime, timezone
from typing import Any, Iterable

from openpyxl import Workbook
from openpyxl.packaging.custom import StringProperty
from openpyxl.styles import Font, PatternFill
from openpyxl.utils import get_column_letter

from ..excel.spec import ILLEGAL_CHARACTERS, MAX_CELL_CHARS, write_text
from .catalog import source_ids
from .problems import LabProblem
from .store import run_resource, scene_resource
from .validation import UNITS_POLICY, canonical_bytes

SHEETS = ("Equipment", "Stations", "Connections", "Conditions", "Trial Measurements", "Titration Curve", "Observations", "Sources")
MAX_ROWS = 100_000


def export_document(scene: dict[str, Any], runs: list[dict[str, Any]]) -> dict[str, Any]:
    rows = [run_resource(run) for run in runs]
    if sum(len((run["result"] or {}).get("observations", [])) for run in runs) > MAX_ROWS:
        raise LabProblem(413, "EXPORT_LIMIT", "A notebook export accepts at most 100,000 observations; select a single run.")
    return {
        "format": "matterlab-lab-notebook", "schemaVersion": 1,
        "exportedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        **scene_resource(scene), "catalogSnapshot": scene["catalog_snapshot"], "unitsPolicy": UNITS_POLICY, "runs": rows,
        "notes": [
            "The scene and optional browser checkpoint are saved drafts, not verified scientific results.",
            "Only server replay results are authoritative model outputs. Imported JSON never creates trusted run results.",
            "JSON preserves all submitted scene/checkpoint fields; XLSX is a readable interchange view, not an executable protocol.",
        ],
    }


def _text(value: Any) -> Any:
    if isinstance(value, (dict, list)):
        return canonical_bytes(value).decode("utf-8")
    return value


def _append(sheet: Any, row: Iterable[Any]) -> None:
    row_number = sheet.max_row + 1
    if sheet.max_row == 1 and sheet.cell(1, 1).value is None:
        row_number = 1
    for index, value in enumerate(row, start=1):
        value = _text(value)
        if value is None:
            continue
        cell = sheet.cell(row_number, index)
        if isinstance(value, str):
            if len(value) > MAX_CELL_CHARS:
                raise LabProblem(413, "WORKSHEET_CELL_TOO_LARGE", "A value cannot fit in one Excel cell. Use exact JSON export; no value was silently truncated.")
            # Workbook XML cannot represent control characters; the exact JSON archive can.
            value = ILLEGAL_CHARACTERS.sub("\ufffd", value)
            write_text(cell, value)
            if re.match(r"^[\s]*[=+\-@]", value):
                cell.quotePrefix = True
        else:
            cell.value = value


def export_workbook(document: dict[str, Any]) -> bytes:
    workbook = Workbook()
    workbook.remove(workbook.active)
    sheets = {name: workbook.create_sheet(name) for name in SHEETS}
    scene = document["scene"]
    definitions = {record["id"]: record for record in document["catalogSnapshot"].get("equipment", [])}
    _append(sheets["Equipment"], ["Instance ID", "Definition ID", "Definition version", "Kind", "Station ID", "X (m)", "Y (m)", "Z (m)", "Quaternion X", "Quaternion Y", "Quaternion Z", "Quaternion W", "Configuration JSON", "Calibration JSON"])
    for instance in scene["apparatus"]:
        definition = definitions.get(instance["definitionId"], {})
        _append(sheets["Equipment"], [
            instance["id"], instance["definitionId"], definition.get("version"), instance["kind"], instance["stationId"],
            *instance["transform"]["positionM"], *instance["transform"]["quaternion"], instance["config"], definition.get("vesselCalibration"),
        ])
    _append(sheets["Stations"], ["Station ID", "Name"])
    for station in scene["stations"]:
        _append(sheets["Stations"], [station["id"], station["name"]])
    _append(sheets["Connections"], ["Connection ID", "From apparatus", "From socket", "To apparatus", "To socket", "Kind", "Enabled"])
    for connection in scene["connections"]:
        _append(sheets["Connections"], [connection["id"], connection["from"]["instanceId"], connection["from"]["socketId"], connection["to"]["instanceId"], connection["to"]["socketId"], connection["kind"], connection["enabled"]])
    _append(sheets["Conditions"], ["Scope ID", "Setting", "Value", "Unit", "Evidence / note"])
    for name, value, unit in (("Title", document["title"], None), ("Durable revision", scene["revision"], None),
                             ("Method", scene["simulationConfig"]["methodId"], None), ("Time step", scene["simulationConfig"]["timeStepS"], "s"),
                             ("Units policy", document["unitsPolicy"], None)):
        _append(sheets["Conditions"], [scene["id"], name, value, unit, "Saved draft; not a measured result"])
    for identifier, contents in scene["containerStates"].items():
        for name, value, unit in (("Volume", contents["volumeL"], "L"), ("Temperature", contents["temperatureK"], "K"), ("Mixing", contents["mixing"], None)):
            _append(sheets["Conditions"], [identifier, name, value, unit, "Saved inventory"])
        for species in contents["species"]:
            _append(sheets["Conditions"], [identifier, species["speciesId"], species["moles"], "mol", species.get("sourceId", "UNVERIFIED: no source ID supplied")])
    headers = ["Run ID", "Station ID", "Epoch", "Apparatus ID", "Type", "Time (s)", "Value", "Unit", "Uncertainty", "Evidence", "Method", "Source IDs"]
    _append(sheets["Trial Measurements"], headers)
    _append(sheets["Observations"], [*headers, "Observation JSON"])
    _append(sheets["Titration Curve"], ["Run ID", "Station ID", "Epoch", "Receiver ID", "Titrant source ID", "Time (s)", "Delivered titrant (L)", "pH", "Evidence", "Association / limitation", "Source IDs"])
    sources: dict[tuple[str, bytes], tuple[dict[str, Any], set[str]]] = {}

    def retain_source(record: dict[str, Any], scope: str) -> None:
        key = (record["id"], canonical_bytes(record))
        if key not in sources:
            sources[key] = (record, set())
        sources[key][1].add(scope)

    for record in document["catalogSnapshot"].get("sources", []):
        retain_source(record, scene["id"])
    for run in document["runs"]:
        for record in run["catalogSnapshot"].get("sources", []):
            retain_source(record, run["runId"])
        result = run["result"]
        for name, value in (
            ("Status", run["status"]), ("Input hash (SHA-256 / RFC8785)", run["inputHash"]),
            ("Runner bundle SHA-256", run["runnerSha256"]), ("Contract version", run["inputSnapshot"]["contractVersion"]),
            ("Runtime version", run["inputSnapshot"]["runtimeVersion"]), ("Method version", run["inputSnapshot"]["methodVersion"]),
            ("Failure code", run["failureCode"]),
            ("Assumptions", result.get("assumptions", []) if result else []), ("Warnings", result.get("warnings", []) if result else []),
            ("Diagnostics", result.get("solverDiagnostics") if result else None),
        ):
            _append(sheets["Conditions"], [run["runId"], name, value, None, "Immutable server run"])
        ledger = [
            record for event in (run.get("runtimeCheckpoint") or {}).get("events", []) if event["type"] == "OBSERVATIONS"
            for record in event["observations"]
        ]
        records = ledger if ledger else [{"observation": value} for value in (result or {}).get("observations", [])]
        for record in records:
            observation = record["observation"]
            quantity = observation["quantity"]
            row = [
                run["runId"], record.get("stationId", observation.get("stationId")), record.get("epoch"), observation.get("apparatusId"), observation["type"],
                observation["timeS"], quantity["value"], quantity["unit"], quantity.get("uncertainty"),
                observation["evidence"], observation["methodId"], observation["sourceIds"],
            ]
            _append(sheets["Trial Measurements"], row)
            _append(sheets["Observations"], [*row, observation])
            if observation["type"] == "PH":
                titration = observation.get("titration")
                _append(sheets["Titration Curve"], [
                    run["runId"], record.get("stationId", observation.get("stationId")), record.get("epoch"),
                    titration["receiverInstanceId"] if titration else observation.get("apparatusId"),
                    titration["sourceInstanceId"] if titration else None, observation["timeS"],
                    titration["deliveredVolumeL"] if titration else None, quantity["value"], observation["evidence"],
                    "Runtime-associated accepted transfers" if titration else "No unambiguous delivered-titrant association; volume intentionally blank",
                    observation["sourceIds"],
                ])
    known_source_ids = {identifier for identifier, _ in sources}
    for identifier in source_ids(document) - known_source_ids:
        retain_source({"id": identifier, "title": "Unresolved source identifier", "evidence": "UNVERIFIED"}, scene["id"])
    _append(sheets["Sources"], ["Source ID", "Title", "Authors / provider", "URL", "Version", "Accessed on", "License", "Scene / run scope IDs", "Source JSON"])
    for (identifier, _), (source, scopes) in sorted(sources.items()):
        _append(sheets["Sources"], [
            identifier, source.get("title"), source.get("authors", source.get("provider")), source.get("url"),
            source.get("version", source.get("datasetVersion")), source.get("accessedOn", source.get("accessedAt")),
            source.get("sourceLicense", source.get("license")), sorted(scopes), source,
        ])
    for sheet in sheets.values():
        sheet.freeze_panes = "A2"
        sheet.auto_filter.ref = sheet.dimensions
        for cell in sheet[1]:
            cell.font = Font(bold=True, color="FFFFFF")
            cell.fill = PatternFill("solid", fgColor="193B42")
        for index in range(1, sheet.max_column + 1):
            sheet.column_dimensions[get_column_letter(index)].width = 24
    workbook.properties.title = document["title"]
    workbook.properties.creator = "MATTER LAB"
    workbook.properties.description = "Scoped laboratory export; model results retain units, evidence and provenance. Empty cells are not zeroes."
    workbook.custom_doc_props.append(StringProperty(name="matterlab_format", value="matterlab-lab-notebook"))
    workbook.custom_doc_props.append(StringProperty(name="matterlab_schema_version", value="1"))
    workbook.custom_doc_props.append(StringProperty(name="matterlab_exported_at_utc", value=document["exportedAt"]))
    buffer = io.BytesIO()
    workbook.save(buffer)
    workbook.close()
    return buffer.getvalue()
