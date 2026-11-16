-- 0005: audit log of workbook imports (Excel is an interchange format; PostgreSQL stays authoritative).

CREATE TABLE data_imports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename        text,
  sha256          text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes      bigint NOT NULL CHECK (size_bytes >= 0),
  dry_run         boolean NOT NULL,
  outcome         text NOT NULL CHECK (outcome IN ('applied', 'dry-run', 'rejected')),
  rows_inserted   integer NOT NULL CHECK (rows_inserted >= 0),
  rows_updated    integer NOT NULL CHECK (rows_updated >= 0),
  rows_unchanged  integer NOT NULL CHECK (rows_unchanged >= 0),
  rows_rejected   integer NOT NULL CHECK (rows_rejected >= 0),
  report          jsonb NOT NULL CHECK (jsonb_typeof(report) = 'object'),
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE data_imports IS 'One row per workbook import attempt, with the per-sheet outcome and the row-level error report.';
COMMENT ON COLUMN data_imports.sha256 IS 'SHA-256 (hex) of the uploaded workbook bytes.';
COMMENT ON COLUMN data_imports.outcome IS
  'applied = valid rows were committed; dry-run = validated only, nothing written; rejected = nothing written because the workbook failed validation.';

CREATE INDEX data_imports_created_at_idx ON data_imports (created_at DESC);
