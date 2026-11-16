"""Import an .xlsx workbook.

Validation happens in three layers, each reported precisely:
  1. workbook: readable .xlsx, only known sheet names;
  2. headers: every sheet has exactly its columns, units included (a column in another unit is an error);
  3. rows: types, required values, references and chemistry (RDKit) per row.

A workbook that fails layer 1 or 2 is rejected as a whole. Otherwise valid rows are written and
invalid rows are reported with their sheet, row number, column and reason. Everything is written
in one transaction, and what a row writes is written inside a savepoint of its own, so a bad row
can never leave partial data behind, and a failure of the import as a whole leaves the database
exactly as it was.

Rows identical to the database are left alone (their provenance is untouched). Rows that are new
or changed are stored with the workbook as their provenance, together with the source the row
itself declares.
"""

from __future__ import annotations

import hashlib
import io
import logging
import zipfile
from datetime import datetime, timezone
from typing import Any

import psycopg
from openpyxl import load_workbook

from ..db import Database, DatabaseUnavailable, Jsonb
from .exporter import sheet_columns
from .sheets import IMPORT_ORDER, SHEETS, ImportContext, RowError
from .spec import OMITTED_COLUMN, PROVENANCE_COLUMNS, SHEET_ORDER, CellError, Column, decode, split_header

log = logging.getLogger("matterlab.excel")

MAX_ERRORS_REPORTED = 500


def _problem(sheet: str | None, row: int | None, column: str | None, code: str, message: str) -> dict[str, Any]:
    return {"sheet": sheet, "row": row, "column": column, "code": code, "message": message}


def _check_headers(name: str, found: list[Any]) -> tuple[dict[int, Column], list[dict[str, Any]]]:
    """Maps column positions to column specs, or explains what is wrong with the header row."""
    expected = sheet_columns(name)
    by_header = {c.header: c for c in expected}
    by_base = {c.base_and_unit[0]: c for c in expected}
    problems: list[dict[str, Any]] = []
    mapping: dict[int, Column] = {}
    seen: set[str] = set()
    for position, raw in enumerate(found):
        if raw is None or str(raw).strip() == "":
            continue
        header = str(raw).strip()
        column = by_header.get(header)
        if column is None:
            base, unit = split_header(header)
            similar = by_base.get(base)
            if similar is not None:
                wanted = similar.base_and_unit[1]
                problems.append(
                    _problem(
                        name,
                        1,
                        header,
                        "unit_mismatch",
                        f"column '{header}' does not match the expected header '{similar.header}'"
                        + (f": values must be in {wanted}, not {unit or 'an unstated unit'}" if wanted else ""),
                    )
                )
            else:
                problems.append(_problem(name, 1, header, "unknown_column", f"sheet '{name}' has no column '{header}'"))
            continue
        if header in seen:
            problems.append(_problem(name, 1, header, "duplicate_column", f"column '{header}' appears more than once"))
            continue
        seen.add(header)
        mapping[position] = column
    for column in expected:
        optional = column.read_only or column is OMITTED_COLUMN or column in PROVENANCE_COLUMNS
        if column.header not in seen and not optional:
            problems.append(_problem(name, 1, column.header, "missing_column", f"sheet '{name}' is missing the column '{column.header}'"))
    return mapping, problems


def _read_rows(worksheet: Any, mapping: dict[int, Column]) -> list[tuple[int, dict[str, Any], list[dict[str, Any]]]]:
    """(row number, raw values by field, cell-level problems) for every non-empty data row."""
    rows = []
    for cells in worksheet.iter_rows(min_row=2):
        raw: dict[str, Any] = {}
        problems: list[dict[str, Any]] = []
        row_number = None
        for position, cell in enumerate(cells):
            column = mapping.get(position)
            if column is None:
                continue
            row_number = cell.row if row_number is None else row_number
            if cell.data_type == "f":
                problems.append(_problem(worksheet.title, cell.row, column.header, "formula_not_allowed", "the cell holds a formula; enter the value itself"))
                continue
            if cell.data_type == "e":
                problems.append(_problem(worksheet.title, cell.row, column.header, "error_value", f"the cell holds the spreadsheet error {cell.value}"))
                continue
            raw[column.field] = cell.value
        if row_number is None or all(value is None or str(value).strip() == "" for value in raw.values()) and not problems:
            continue
        rows.append((row_number, raw, problems))
    return rows


def _import_sheet(ctx: ImportContext, name: str, worksheet: Any, mapping: dict[int, Column], errors: list[dict[str, Any]]) -> dict[str, int]:
    sheet = SHEETS[name]
    counts = {"rows": 0, "inserted": 0, "updated": 0, "unchanged": 0, "rejected": 0}
    present = {column.field for column in mapping.values()}
    current = {sheet.key(record): record for record in sheet.export_rows(ctx.conn)}
    seen: dict[tuple[Any, ...], int] = {}

    for row_number, raw, problems in _read_rows(worksheet, mapping):
        counts["rows"] += 1
        row: dict[str, Any] = {}
        for column in (*sheet.columns, *PROVENANCE_COLUMNS, OMITTED_COLUMN):
            if column.read_only and column.field not in sheet.key_fields:
                continue
            try:
                row[column.field] = decode(column, raw.get(column.field))
            except CellError as exc:
                problems.append(_problem(name, row_number, column.header, exc.code, exc.message))
        if problems:
            errors.extend(problems)
            counts["rejected"] += 1
            continue

        omitted_headers = {part.strip() for part in (row.get("omitted_fields") or "").split(";") if part.strip()}
        left_out = {c.field for c in sheet.columns if c.header in omitted_headers}
        # A column that is absent from the sheet (allowed for read-only ones) is treated like an omitted field.
        omitted = left_out | {c.field for c in sheet.columns if c.field not in present and c.field not in sheet.key_fields}
        try:
            # Fields left out of the export are taken from the stored record before validation.
            try:
                early_key = sheet.key(row)
            except (KeyError, TypeError):
                early_key = None
            stored = current.get(early_key) if early_key is not None else None
            if stored is not None:
                for field_name in omitted:
                    row[field_name] = stored.get(field_name)
            # Validation only reads from the database; everything a row writes happens in apply().
            prepared = sheet.prepare(row, ctx)
            key = sheet.key(prepared)
            if key in seen:
                raise RowError("duplicate_key", f"this row has the same key as row {seen[key]} of the sheet")
            existing = current.get(key)
            if existing is None and left_out:
                # Importing the row would store the record without these values, silently.
                missing = ", ".join(c.header for c in sheet.columns if c.field in left_out)
                raise RowError(
                    "omitted_field",
                    f"{missing} was left out of the workbook (the value is longer than a cell can hold) and this record does not exist in the "
                    "database, so it cannot be imported from the workbook alone",
                    OMITTED_COLUMN.header,
                )
            changed: list[str] = []
            if existing is not None:
                for field_name in omitted:
                    prepared[field_name] = existing.get(field_name)
                changed = sheet.differs(prepared, existing, omitted)
                # A number the workbook did not change keeps its stored value to the last digit
                # (a worksheet cell holds one significant digit less than a double).
                for column in sheet.columns:
                    if column.kind == "float" and column.field not in changed and existing.get(column.field) is not None:
                        prepared[column.field] = existing[column.field]
            if existing is not None and not changed:
                outcome = "unchanged"
            else:
                # Savepoint: whatever the row has written is undone completely if it turns out to be invalid.
                with ctx.conn.transaction():
                    sheet.apply(ctx, prepared, existing, changed)
                outcome = "inserted" if existing is None else "updated"
            seen[key] = row_number
            counts[outcome] += 1
        except RowError as exc:
            errors.append(_problem(name, row_number, exc.column, exc.code, exc.message))
            counts["rejected"] += 1
        except psycopg.Error as exc:
            if isinstance(exc, psycopg.OperationalError) or ctx.conn.info.transaction_status == psycopg.pq.TransactionStatus.INERROR:
                # The connection failed, or a statement failed outside a row's savepoint: the import as a whole is rolled back.
                raise
            constraint = getattr(exc.diag, "constraint_name", None)
            detail = (exc.diag.message_primary or str(exc)).strip()
            errors.append(
                _problem(name, row_number, None, "database_constraint", f"the database refused the row: {detail}" + (f" (constraint {constraint})" if constraint else ""))
            )
            counts["rejected"] += 1
    return counts


def import_workbook(db: Database, content: bytes, *, filename: str | None = None, dry_run: bool = False, atomic: bool = False) -> dict[str, Any]:
    """Imports a workbook and returns the report (also stored in data_imports).

    dry_run  validate and report exactly what would happen, write nothing
    atomic   write nothing unless every row is valid
    """
    started = datetime.now(timezone.utc)
    sha256 = hashlib.sha256(content).hexdigest()
    display_name = filename or "workbook.xlsx"
    errors: list[dict[str, Any]] = []
    sheets: dict[str, dict[str, Any]] = {}
    outcome = "rejected"

    workbook = None
    try:
        workbook = load_workbook(io.BytesIO(content), data_only=False)
    except (zipfile.BadZipFile, KeyError, ValueError, OSError) as exc:
        errors.append(_problem(None, None, None, "invalid_workbook", f"the file is not a readable .xlsx workbook ({type(exc).__name__}: {exc})"))
    except Exception as exc:  # openpyxl raises a variety of errors on damaged files
        errors.append(_problem(None, None, None, "invalid_workbook", f"the file could not be read as an .xlsx workbook ({type(exc).__name__}: {exc})"))

    mappings: dict[str, dict[int, Column]] = {}
    if workbook is not None:
        for name in workbook.sheetnames:
            if name not in SHEETS:
                errors.append(
                    _problem(name, None, None, "unknown_sheet", f"unknown worksheet '{name}'; the workbook may only contain: {', '.join(SHEET_ORDER)}")
                )
        for name in SHEET_ORDER:
            if name not in workbook.sheetnames:
                sheets[name] = {"present": False, "rows": 0, "inserted": 0, "updated": 0, "unchanged": 0, "rejected": 0}
                continue
            header_row = next(workbook[name].iter_rows(min_row=1, max_row=1, values_only=True), ())
            mapping, problems = _check_headers(name, list(header_row))
            errors.extend(problems)
            mappings[name] = mapping
            sheets[name] = {"present": True, "rows": 0, "inserted": 0, "updated": 0, "unchanged": 0, "rejected": 0}

    structural_errors = len(errors)
    if workbook is not None and structural_errors == 0:
        with db.connection() as conn:
            try:
                with conn.transaction() as batch:
                    ctx = ImportContext(conn=conn, filename=display_name, sha256=sha256, started_at=started)
                    for name in IMPORT_ORDER:
                        if name in mappings:
                            sheets[name].update(_import_sheet(ctx, name, workbook[name], mappings[name], errors))
                    rejected = sum(s["rejected"] for s in sheets.values())
                    if dry_run:
                        outcome = "dry-run"
                        raise psycopg.Rollback(batch)
                    if atomic and rejected:
                        outcome = "rejected"
                        raise psycopg.Rollback(batch)
                    outcome = "applied"
            except psycopg.OperationalError:
                # The connection or the server failed: nothing was committed. This is an outage, not a problem of the workbook.
                raise
            except psycopg.Error as exc:
                # Unexpected database failure: the whole import is rolled back by the context manager.
                log.exception("workbook import failed")
                outcome = "rejected"
                for counts in sheets.values():
                    counts.update(inserted=0, updated=0)
                errors.append(_problem(None, None, None, "database_error", f"the import was rolled back: {(exc.diag.message_primary or str(exc)).strip()}"))

    written = outcome == "applied"
    totals = {key: sum(s[key] for s in sheets.values()) for key in ("rows", "inserted", "updated", "unchanged", "rejected")}
    report = {
        "outcome": outcome,
        "written": written,
        "dry_run": dry_run,
        "atomic": atomic,
        "filename": display_name,
        "sha256": sha256,
        "size_bytes": len(content),
        "imported_at": started.isoformat(timespec="seconds").replace("+00:00", "Z"),
        "summary": (
            "The workbook was rejected; nothing was written."
            if outcome == "rejected"
            else "Dry run: the workbook was validated against the database; nothing was written."
            if outcome == "dry-run"
            else f"{totals['inserted']} row(s) inserted, {totals['updated']} updated, {totals['unchanged']} unchanged, {totals['rejected']} rejected."
        ),
        "totals": totals,
        "sheets": sheets,
        "error_count": len(errors),
        "errors_truncated": len(errors) > MAX_ERRORS_REPORTED,
        "errors": errors[:MAX_ERRORS_REPORTED],
    }
    try:
        with db.connection() as conn:
            row = conn.execute(
                """
                INSERT INTO data_imports (filename, sha256, size_bytes, dry_run, outcome, rows_inserted, rows_updated, rows_unchanged,
                                          rows_rejected, report)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id
                """,
                (
                    display_name,
                    sha256,
                    len(content),
                    dry_run,
                    outcome,
                    totals["inserted"] if written else 0,
                    totals["updated"] if written else 0,
                    totals["unchanged"],
                    totals["rejected"],
                    Jsonb(report),
                ),
            ).fetchone()
        report["import_id"] = str(row["id"]) if row else None
    except (psycopg.Error, DatabaseUnavailable):
        log.exception("could not record the workbook import in data_imports")
        report["import_id"] = None
    return report
