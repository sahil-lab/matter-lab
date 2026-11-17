/**
 * Spreadsheet-formula-injection guard for the Excel export.
 *
 * Verified empirically (see apps/api/test/excel.test.ts "does not let formula-like text become a
 * real formula"): exceljs stores a plain JS string as a shared-string cell (`t="s"` in the
 * underlying XML) regardless of its content, so a value such as `"=1+1"` is never reinterpreted as
 * a formula by Excel when it opens the workbook - only an explicit `{ formula }` cell value is. This
 * module never constructs a `{ formula }` value from exported data (`writeText` always assigns a
 * primitive string), and additionally neutralises a leading formula-trigger character for free-text
 * (user-supplied) fields, so the exported text is visibly inert even to a tool that later
 * re-interprets the cell content outside this workbook (e.g. after a save-as-CSV round trip).
 */
import type { Cell } from 'exceljs';

const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

/** Neutralises free-text content that could be misread as a formula by a less careful consumer. */
export function sanitizeFreeText(value: string): string {
  return FORMULA_TRIGGER.test(value) ? `'${value}` : value;
}

/** Assigns `text` to `cell` as a literal, formula-neutralised string. Never pass a `{ formula }` object through this function. */
export function writeText(cell: Cell, text: string): void {
  cell.value = sanitizeFreeText(text);
}
