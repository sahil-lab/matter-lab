"""Export the database to an .xlsx workbook.

Exactly ten worksheets, in a fixed order. Units are part of the column headers; every row ends
with the provenance of the record. Export time, schema version and service version are written
to the workbook's document properties, so no extra sheet is needed.
"""

from __future__ import annotations

import io
from datetime import datetime, timezone
from typing import Any

from openpyxl import Workbook
from openpyxl.packaging.custom import StringProperty
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

from .. import SERVICE_NAME, __version__
from ..db import Database
from .sheets import SHEETS
from .spec import ILLEGAL_CHARACTERS, MAX_CELL_CHARS, OMITTED_COLUMN, PROVENANCE_COLUMNS, SHEET_ORDER, WORKBOOK_FORMAT, Column, encode, write_text

_HEADER_FONT = Font(bold=True)
_HEADER_FILL = PatternFill("solid", start_color="FFE8EEF7")
_PROVENANCE_FILL = PatternFill("solid", start_color="FFF3EAD7")


def sheet_columns(name: str) -> tuple[Column, ...]:
    """All columns of a worksheet in order: data, the omitted-fields note, provenance."""
    return (*SHEETS[name].columns, OMITTED_COLUMN, *PROVENANCE_COLUMNS)


def _cell_value(column: Column, value: Any) -> tuple[Any, bool]:
    """(value to write, whether it had to be left out because a cell cannot hold it)."""
    encoded = encode(column, value)
    if isinstance(encoded, str) and (len(encoded) > MAX_CELL_CHARS or ILLEGAL_CHARACTERS.search(encoded)):
        return None, True
    return encoded, False


def export_workbook(db: Database) -> tuple[bytes, dict[str, Any]]:
    """Returns the workbook bytes and a summary (rows per sheet, schema version, export time)."""
    exported_at = datetime.now(timezone.utc)
    workbook = Workbook()
    workbook.remove(workbook.active)
    counts: dict[str, int] = {}
    omitted_total = 0

    # One repeatable-read transaction: every sheet shows the same moment of the database.
    with db.connection() as conn:
        conn.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        schema = conn.execute("SELECT max(version) AS version FROM schema_migrations").fetchone()
        schema_version = schema["version"] if schema else None
        for name in SHEET_ORDER:
            sheet = SHEETS[name]
            columns = sheet_columns(name)
            worksheet = workbook.create_sheet(title=name)
            for index, column in enumerate(columns, start=1):
                cell = worksheet.cell(row=1, column=index)
                write_text(cell, column.header)
                cell.font = _HEADER_FONT
                cell.fill = _PROVENANCE_FILL if column in PROVENANCE_COLUMNS else _HEADER_FILL
                cell.alignment = Alignment(vertical="top", wrap_text=True)
                worksheet.column_dimensions[get_column_letter(index)].width = column.width
            worksheet.freeze_panes = "A2"

            rows = sheet.export_rows(conn)
            for row_index, record in enumerate(rows, start=2):
                omitted: list[str] = []
                for index, column in enumerate(columns, start=1):
                    if column is OMITTED_COLUMN:
                        continue
                    value, left_out = _cell_value(column, record.get(column.field))
                    if left_out:
                        omitted.append(column.header)
                        continue
                    if value is None:
                        continue
                    cell = worksheet.cell(row=row_index, column=index)
                    if isinstance(value, str):
                        # Explicit string type: text such as "=O" must never be read as a formula.
                        write_text(cell, value)
                    else:
                        cell.value = value
                if omitted:
                    position = columns.index(OMITTED_COLUMN) + 1
                    write_text(worksheet.cell(row=row_index, column=position), "; ".join(omitted))
                    omitted_total += len(omitted)
            if rows:
                worksheet.auto_filter.ref = f"A1:{get_column_letter(len(columns))}{len(rows) + 1}"
            counts[name] = len(rows)

    stamp = exported_at.isoformat(timespec="seconds").replace("+00:00", "Z")
    properties = workbook.properties
    properties.title = "MATTER LAB database export"
    properties.creator = f"{SERVICE_NAME} {__version__}"
    properties.created = exported_at.replace(tzinfo=None)
    properties.modified = exported_at.replace(tzinfo=None)
    properties.description = (
        f"Exported {stamp} from schema version {schema_version} by {SERVICE_NAME} {__version__} ({WORKBOOK_FORMAT}). "
        "PostgreSQL is the authoritative store; this workbook is an interchange copy. Units are given in the column headers. "
        f"A cell cannot hold more than {MAX_CELL_CHARS} characters: longer values are left out and named in the 'Omitted fields' column."
    )
    properties.keywords = f"{WORKBOOK_FORMAT}; schema {schema_version}; exported {stamp}"
    for key, value in (
        ("matterlab_format", WORKBOOK_FORMAT),
        ("matterlab_schema_version", str(schema_version)),
        ("matterlab_exported_at_utc", stamp),
        ("matterlab_service_version", __version__),
    ):
        workbook.custom_doc_props.append(StringProperty(name=key, value=value))

    buffer = io.BytesIO()
    workbook.save(buffer)
    summary = {
        "exported_at": stamp,
        "schema_version": schema_version,
        "format": WORKBOOK_FORMAT,
        "sheets": counts,
        "omitted_cells": omitted_total,
        "size_bytes": buffer.tell(),
    }
    return buffer.getvalue(), summary
