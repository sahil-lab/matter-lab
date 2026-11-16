"""Workbook export and import."""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, File, Query, Response, UploadFile
from pydantic import BaseModel, Field

from ..errors import ApiError, error_responses
from ..excel.exporter import export_workbook, sheet_columns
from ..excel.importer import import_workbook
from ..excel.spec import MAX_CELL_CHARS, SHEET_ORDER, WORKBOOK_FORMAT
from .common import Ctx

router = APIRouter(prefix="/v1/excel", tags=["excel"])
# Routes that do not touch PostgreSQL (they are documented without the 503 response).
info_router = APIRouter(prefix="/v1/excel", tags=["excel"])

XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


class ColumnFormat(BaseModel):
    header: str = Field(description="Exact header text, unit included.")
    type: str = Field(description="int, float, str, bool, json, int_list, str_list, date, datetime or uuid.")
    unit: str | None = Field(description="Unit named in the header, when the header has one.")
    required: bool
    read_only: bool = Field(description="Exported for information and ignored on import.")
    allowed_values: list[str] | None


class SheetFormat(BaseModel):
    name: str
    key: list[str] = Field(description="Headers of the columns that identify a row.")
    columns: list[ColumnFormat]


class WorkbookFormat(BaseModel):
    format: str
    sheets: list[SheetFormat] = Field(description="The worksheets, in workbook order.")
    max_cell_characters: int
    notes: list[str]


class ImportProblem(BaseModel):
    sheet: str | None
    row: int | None = Field(description="Row number in the worksheet (the header is row 1).")
    column: str | None
    code: str
    message: str


class SheetReport(BaseModel):
    """Row counts of one worksheet. When `written` is false (dry run, or a rejected atomic
    import), `inserted` and `updated` count the rows that would have been written."""

    present: bool = Field(description="False when the workbook does not contain this sheet.")
    rows: int
    inserted: int
    updated: int
    unchanged: int = Field(description="Rows identical to the database; they are not touched and keep their provenance.")
    rejected: int


class ImportTotals(BaseModel):
    """Row counts over all worksheets. When `written` is false, `inserted` and `updated` count
    the rows that would have been written."""

    rows: int
    inserted: int
    updated: int
    unchanged: int
    rejected: int


class ImportReport(BaseModel):
    import_id: UUID | None = Field(description="Id of the entry in the import log (table data_imports).")
    outcome: Literal["applied", "dry-run", "rejected"]
    written: bool = Field(description="True only when rows were committed to the database.")
    dry_run: bool
    atomic: bool
    filename: str
    sha256: str
    size_bytes: int
    imported_at: datetime
    summary: str
    totals: ImportTotals
    sheets: dict[str, SheetReport]
    error_count: int
    errors_truncated: bool
    errors: list[ImportProblem] = Field(description="Row-level (and, for a rejected workbook, workbook-level) problems.")


@info_router.get("/format", response_model=WorkbookFormat, summary="The workbook format: sheets, headers, types and units")
def workbook_format() -> WorkbookFormat:
    from ..excel.sheets import SHEETS

    sheets = []
    for name in SHEET_ORDER:
        sheet = SHEETS[name]
        columns = sheet_columns(name)
        key_headers = [c.header for c in sheet.columns if c.field in sheet.key_fields]
        sheets.append(
            SheetFormat(
                name=name,
                key=key_headers,
                columns=[
                    ColumnFormat(
                        header=c.header,
                        type=c.kind,
                        unit=c.base_and_unit[1],
                        required=c.required and not c.read_only,
                        read_only=c.read_only,
                        allowed_values=list(c.choices) if c.choices else None,
                    )
                    for c in columns
                ],
            )
        )
    return WorkbookFormat(
        format=WORKBOOK_FORMAT,
        sheets=sheets,
        max_cell_characters=MAX_CELL_CHARS,
        notes=[
            "PostgreSQL is authoritative. A workbook is an export of the database or a batch of proposed changes to it.",
            "Units are part of the header text. A header that does not match exactly, for example a column in another unit, is rejected.",
            "Rows identical to the database are left untouched. New and changed rows are stored with the workbook as their provenance, together with the source declared in the row's 'Source' columns.",
            f"A cell cannot hold more than {MAX_CELL_CHARS} characters. On export longer values are left out and their headers listed in 'Omitted fields'; on import such fields keep their stored value.",
            "Structure-derived columns (InChI, formula, masses, fingerprints) are recomputed by RDKit on import; the values in the workbook are not trusted.",
        ],
    )


@router.get(
    "/export",
    summary="Download the database as an .xlsx workbook",
    response_class=Response,
    responses={
        200: {
            "description": "The workbook. Worksheets: " + ", ".join(SHEET_ORDER) + ".",
            "content": {XLSX_MEDIA_TYPE: {"schema": {"type": "string", "format": "binary"}}},
            "headers": {
                "Content-Disposition": {"schema": {"type": "string"}, "description": "attachment; filename=..."},
                "X-MatterLab-Schema-Version": {"schema": {"type": "string"}, "description": "Schema version of the exported database."},
                "X-MatterLab-Exported-At": {"schema": {"type": "string"}, "description": "Export time (ISO 8601, UTC)."},
            },
        }
    },
)
def export(ctx: Ctx) -> Response:
    """Exactly ten worksheets, in this order: Elements, Isotopes, Compounds, Functional Groups,
    Catalysts, Solvents, Reactions, Experiments, Discoveries, Calculations. Units are in the
    headers and every row ends with its provenance. Export time and schema version are stored in
    the workbook's document properties and repeated in the response headers."""
    content, summary = export_workbook(ctx.db)
    stamp = summary["exported_at"].replace("-", "").replace(":", "")
    return Response(
        content=content,
        media_type=XLSX_MEDIA_TYPE,
        headers={
            "Content-Disposition": f'attachment; filename="matterlab-export-{stamp}.xlsx"',
            "X-MatterLab-Schema-Version": str(summary["schema_version"]),
            "X-MatterLab-Exported-At": summary["exported_at"],
        },
    )


@router.post(
    "/import",
    response_model=ImportReport,
    responses=error_responses(413, 422),
    summary="Import an .xlsx workbook",
)
async def import_(
    ctx: Ctx,
    file: UploadFile = File(description="The .xlsx workbook."),
    dry_run: bool = Query(default=False, description="Validate against the database and report what would happen; write nothing."),
    atomic: bool = Query(default=False, description="Write nothing unless every row is valid."),
) -> ImportReport:
    """Sheet names, headers (units included), cell types, references and chemistry are validated.
    Valid rows are upserted with provenance and invalid rows are listed with sheet, row, column and
    reason. All writes happen in one transaction with a savepoint per row. A workbook with an
    unknown sheet or a wrong header is rejected as a whole (HTTP 422, with the report in `details`)."""
    from starlette.concurrency import run_in_threadpool

    limit = ctx.settings.max_upload_bytes
    content = await file.read(limit + 1)
    if len(content) > limit:
        raise ApiError(413, "payload_too_large", f"The workbook is larger than the limit of {limit} bytes.", {"max_bytes": limit})
    if not content:
        raise ApiError(422, "empty_upload", "The uploaded file is empty.", None)
    report: dict[str, Any] = await run_in_threadpool(import_workbook, ctx.db, content, filename=file.filename, dry_run=dry_run, atomic=atomic)
    if report["outcome"] == "rejected":
        raise ApiError(422, "workbook_rejected", f"{report['summary']} {report['error_count']} problem(s) found.", report)
    return ImportReport(**report)
