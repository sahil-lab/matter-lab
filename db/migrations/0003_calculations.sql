-- 0003: calculations (asynchronous jobs).
--
-- A calculation row is the persistent record of one job: what was asked (kind, input, settings and
-- their SHA-256), which engine and versions ran it, how it ended, and what it produced.

CREATE TABLE calculations (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              text NOT NULL CHECK (kind ~ '^[a-z0-9_]+(\.[a-z0-9_]+)*$'),
  status            text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'unsupported')),
  input             jsonb NOT NULL CHECK (jsonb_typeof(input) = 'object'),
  settings          jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
  input_hash        text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  engine            text NOT NULL CHECK (btrim(engine) <> ''),
  engine_version    text,
  software          jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(software) = 'object'),
  method            text,
  progress          double precision NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
  messages          jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(messages) = 'array'),
  result            jsonb CHECK (jsonb_typeof(result) = 'object'),
  converged         boolean,
  error             jsonb CHECK (jsonb_typeof(error) = 'object'),
  timeout_seconds   double precision NOT NULL CHECK (timeout_seconds > 0),
  cancel_requested  boolean NOT NULL DEFAULT false,
  origin            text NOT NULL DEFAULT 'service' CHECK (origin IN ('service', 'import')),
  source_id         bigint NOT NULL REFERENCES data_sources (id),
  supervisor_id     uuid,
  worker_pid        integer,
  heartbeat_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  finished_at       timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calculations_terminal_has_finished_at CHECK (
    (status IN ('succeeded', 'failed', 'cancelled', 'unsupported')) = (finished_at IS NOT NULL)
  ),
  CONSTRAINT calculations_running_has_started_at CHECK (status <> 'running' OR started_at IS NOT NULL),
  CONSTRAINT calculations_succeeded_has_result CHECK (status <> 'succeeded' OR result IS NOT NULL),
  CONSTRAINT calculations_only_succeeded_has_result CHECK (result IS NULL OR status = 'succeeded'),
  CONSTRAINT calculations_failure_has_error CHECK (status NOT IN ('failed', 'unsupported') OR error IS NOT NULL),
  CONSTRAINT calculations_imported_is_terminal CHECK (origin <> 'import' OR finished_at IS NOT NULL)
);

COMMENT ON TABLE calculations IS 'Asynchronous jobs: request, execution record and result of each calculation.';
COMMENT ON COLUMN calculations.kind IS 'Job kind, written engine.task (e.g. rdkit.geometry_optimization).';
COMMENT ON COLUMN calculations.input IS 'Validated job input with defaults applied (the canonical form that is hashed).';
COMMENT ON COLUMN calculations.settings IS 'Validated method settings with defaults applied (part of the hashed request).';
COMMENT ON COLUMN calculations.input_hash IS 'SHA-256 (hex) of the canonical JSON of {kind, input, settings}. Identical requests share a hash.';
COMMENT ON COLUMN calculations.engine_version IS 'Version of the engine detected when the job was accepted; NULL when the engine is not installed.';
COMMENT ON COLUMN calculations.software IS 'Versions of every library involved, as reported by the worker that ran the job.';
COMMENT ON COLUMN calculations.method IS 'Method actually used, as reported by the worker (e.g. MMFF94, GFN2-xTB, RKS/b3lyp/def2-svp).';
COMMENT ON COLUMN calculations.progress IS 'Fraction completed, 0 to 1.';
COMMENT ON COLUMN calculations.messages IS 'Array of {time, level, text} progress messages.';
COMMENT ON COLUMN calculations.result IS 'Result document; present only for succeeded jobs. Units are stated in the field names.';
COMMENT ON COLUMN calculations.converged IS 'Convergence status reported by the engine; NULL when the job produced no result.';
COMMENT ON COLUMN calculations.error IS 'Error document {code, message, details} for failed and unsupported jobs.';
COMMENT ON COLUMN calculations.timeout_seconds IS 'Wall-clock limit in seconds after which the worker is terminated and the job fails.';
COMMENT ON COLUMN calculations.origin IS 'service = executed by a worker of this service; import = record imported from a workbook, not executed here.';
COMMENT ON COLUMN calculations.source_id IS 'Provenance: the engine release that computed the row, or the import batch for imported rows.';
COMMENT ON COLUMN calculations.heartbeat_at IS 'Last time the owning supervisor confirmed the worker was alive; used to detect lost jobs.';

CREATE INDEX calculations_created_at_idx ON calculations (created_at DESC);
CREATE INDEX calculations_status_idx ON calculations (status, created_at DESC);
CREATE INDEX calculations_queue_idx ON calculations (created_at) WHERE status = 'queued';
CREATE INDEX calculations_running_idx ON calculations (heartbeat_at) WHERE status = 'running';
CREATE INDEX calculations_input_hash_idx ON calculations (input_hash);
CREATE INDEX calculations_kind_idx ON calculations (kind, created_at DESC);
CREATE INDEX calculations_source_id_idx ON calculations (source_id);

CREATE TRIGGER calculations_set_updated_at BEFORE UPDATE ON calculations
  FOR EACH ROW EXECUTE FUNCTION matterlab_set_updated_at();
