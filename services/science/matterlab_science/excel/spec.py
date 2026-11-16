"""Workbook format: column specifications and the encoding of values in cells.

Every numeric column carries its unit in the header text, e.g. `Atomic mass (u)`. On import the
header must match exactly, so a column in another unit is rejected instead of being misread.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Any
from uuid import UUID

WORKBOOK_FORMAT = "matterlab-workbook/1"
SHEET_ORDER = (
    "Elements",
    "Isotopes",
    "Compounds",
    "Functional Groups",
    "Catalysts",
    "Solvents",
    "Reactions",
    "Experiments",
    "Discoveries",
    "Calculations",
)

# Excel cannot hold more than 32,767 characters in a cell.
MAX_CELL_CHARS = 32_767
# Characters that are not allowed in XML 1.0 and therefore cannot be stored in a worksheet.
ILLEGAL_CHARACTERS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")

OMITTED_HEADER = "Omitted fields"

EVIDENCE_LEVELS = ("reference", "computed", "rule-based", "illustrative", "user-input", "unsupported")


@dataclass(frozen=True)
class Column:
    header: str
    field: str
    kind: str  # int | float | str | bool | json | int_list | str_list | date | datetime | uuid
    required: bool = False
    read_only: bool = False  # exported for information; ignored when importing
    json_type: str | None = None  # "object" | "array" for kind json
    width: int = 18
    choices: tuple[str, ...] | None = None

    @property
    def base_and_unit(self) -> tuple[str, str | None]:
        return split_header(self.header)


def split_header(header: str) -> tuple[str, str | None]:
    """('Atomic mass', 'u') for 'Atomic mass (u)'; ('Name', None) for 'Name'."""
    match = re.match(r"^(.*?)\s*\(([^()]*)\)\s*$", header.strip())
    if match:
        return match.group(1).strip().lower(), match.group(2).strip()
    return header.strip().lower(), None


PROVENANCE_COLUMNS = (
    Column("Source key", "source_key", "str", width=28),
    Column("Source version", "source_version", "str", width=26),
    Column("Source title", "source_title", "str", width=40),
    Column("Source URL", "source_url_declared", "str", width=40),
    Column("Source retrieved (ISO 8601 date)", "source_retrieved", "date", width=22),
    Column("Source licence", "source_license", "str", width=34),
)
OMITTED_COLUMN = Column(OMITTED_HEADER, "omitted_fields", "str", width=24)

# SELECT fragment (with `JOIN data_sources ds`) that fills the provenance columns of a sheet.
PROVENANCE_SELECT = (
    "ds.key AS source_key, ds.version AS source_version, ds.title AS source_title, ds.url AS source_url_declared, "
    "ds.retrieved_on AS source_retrieved, ds.license AS source_license"
)


class CellError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def write_text(cell: Any, text: str) -> None:
    """Stores text in a worksheet cell as text, whatever it looks like.

    openpyxl turns a value that starts with '=' into a formula and one that equals an error code
    such as '#N/A' into an error cell. Chemistry is full of such strings (the functional group
    '=O', SMILES fragments), so the cell type is set explicitly after the value.
    """
    cell.value = text
    cell.data_type = "s"


def compact_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def encode(column: Column, value: Any) -> Any:
    """Python value -> cell value."""
    if value is None:
        return None
    kind = column.kind
    if kind in ("int", "float", "bool"):
        return value
    if kind == "json":
        return compact_json(value)
    if kind == "int_list":
        return ", ".join(str(v) for v in value) if value else None
    if kind == "str_list":
        return compact_json(list(value)) if value else None
    if kind == "datetime":
        return iso(value)
    if kind == "date":
        return value.isoformat() if isinstance(value, date) else str(value)
    if kind == "uuid":
        return str(value)
    text = str(value)
    return text if text != "" else None


def _as_number(value: Any, header: str) -> float:
    if isinstance(value, bool):
        raise CellError("wrong_type", f"'{header}' must be a number, found a boolean")
    if isinstance(value, (int, float)):
        number = float(value)
    elif isinstance(value, str):
        try:
            number = float(value.strip())
        except ValueError:
            raise CellError("wrong_type", f"'{header}' must be a number, found text {value!r}") from None
    else:
        raise CellError("wrong_type", f"'{header}' must be a number, found {type(value).__name__}")
    if not math.isfinite(number):
        raise CellError("wrong_type", f"'{header}' must be a finite number")
    return number


def decode(column: Column, value: Any) -> Any:
    """Cell value -> Python value, or CellError with what is wrong."""
    header = column.header
    if isinstance(value, str):
        value = value.strip() if column.kind != "str" or column.field not in ("molblock", "input_structure") else value
        if value == "":
            value = None
    if value is None:
        if column.kind in ("int_list", "str_list"):
            return []
        return None
    kind = column.kind
    if kind == "int":
        number = _as_number(value, header)
        if number != int(number):
            raise CellError("wrong_type", f"'{header}' must be a whole number, found {value!r}")
        return int(number)
    if kind == "float":
        return _as_number(value, header)
    if kind == "bool":
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)) and value in (0, 1):
            return bool(value)
        if isinstance(value, str) and value.lower() in ("true", "false", "yes", "no"):
            return value.lower() in ("true", "yes")
        raise CellError("wrong_type", f"'{header}' must be TRUE or FALSE, found {value!r}")
    if kind == "json":
        if not isinstance(value, str):
            raise CellError("wrong_type", f"'{header}' must hold JSON text, found {type(value).__name__}")
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError as exc:
            raise CellError("invalid_json", f"'{header}' is not valid JSON: {exc.msg} at position {exc.pos}") from None
        if column.json_type == "object" and not isinstance(parsed, dict):
            raise CellError("wrong_type", f"'{header}' must be a JSON object")
        if column.json_type == "array" and not isinstance(parsed, list):
            raise CellError("wrong_type", f"'{header}' must be a JSON array")
        return parsed
    if kind == "int_list":
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            parts: list[Any] = [value]
        elif isinstance(value, str):
            parts = [p for p in re.split(r"[,;\s]+", value) if p]
        else:
            raise CellError("wrong_type", f"'{header}' must be a comma-separated list of whole numbers")
        numbers = []
        for part in parts:
            number = _as_number(part, header)
            if number != int(number):
                raise CellError("wrong_type", f"'{header}' must be a comma-separated list of whole numbers, found {part!r}")
            numbers.append(int(number))
        return numbers
    if kind == "str_list":
        if not isinstance(value, str):
            raise CellError("wrong_type", f"'{header}' must be a JSON array of texts")
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            raise CellError("invalid_json", f"'{header}' must be a JSON array of texts, e.g. [\"a\", \"b\"]") from None
        if not isinstance(parsed, list) or not all(isinstance(item, str) for item in parsed):
            raise CellError("wrong_type", f"'{header}' must be a JSON array of texts")
        return parsed
    if kind == "date":
        if isinstance(value, datetime):
            return value.date()
        if isinstance(value, date):
            return value
        try:
            return date.fromisoformat(str(value)[:10])
        except ValueError:
            raise CellError("wrong_type", f"'{header}' must be an ISO 8601 date (YYYY-MM-DD), found {value!r}") from None
    if kind == "datetime":
        if isinstance(value, datetime):
            return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        try:
            parsed_dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except ValueError:
            raise CellError("wrong_type", f"'{header}' must be an ISO 8601 timestamp, found {value!r}") from None
        return parsed_dt if parsed_dt.tzinfo else parsed_dt.replace(tzinfo=timezone.utc)
    if kind == "uuid":
        try:
            return UUID(str(value))
        except ValueError:
            raise CellError("wrong_type", f"'{header}' must be a UUID, found {value!r}") from None
    # str
    if isinstance(value, bool):
        text = "TRUE" if value else "FALSE"
    elif isinstance(value, float) and value == int(value):
        text = str(int(value))
    else:
        text = str(value)
    if column.choices is not None and text not in column.choices:
        raise CellError("invalid_value", f"'{header}' must be one of {', '.join(column.choices)}; found {text!r}")
    return text


def comparable(column: Column, value: Any) -> Any:
    """Normal form used to decide whether an imported value differs from the stored one."""
    if column.kind == "json":
        if value is None:
            return {} if column.json_type == "object" else ([] if column.json_type == "array" else None)
        return value
    if value is None or value == "" or value == []:
        return None
    if column.kind == "float":
        return float(value)
    if column.kind == "uuid":
        return str(value)
    if column.kind == "datetime" and isinstance(value, datetime):
        return value.astimezone(timezone.utc)
    if column.kind == "date" and isinstance(value, datetime):
        return value.date()
    return value


# openpyxl writes numbers with 16 significant digits, one short of what a double needs to survive
# a round trip unchanged. Numbers that agree to this relative tolerance are the same number.
FLOAT_RELATIVE_TOLERANCE = 1e-14


def same_value(column: Column, imported: Any, stored: Any) -> bool:
    """True when the value in the workbook is the stored value."""
    a, b = comparable(column, imported), comparable(column, stored)
    if column.kind == "float" and a is not None and b is not None:
        return math.isclose(a, b, rel_tol=FLOAT_RELATIVE_TOLERANCE, abs_tol=0.0)
    return bool(a == b)
