-- 0007: lab runs -- immutable run snapshots, the replayed action log, run lifecycle events,
-- observations and challenge attempts (Astra 3D laboratory extension, Agent 09).

CREATE TABLE lab_run (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scene_id            uuid NOT NULL REFERENCES lab_scene (id) ON DELETE CASCADE,
  scene_revision      integer NOT NULL CHECK (scene_revision >= 1),
  status              text NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNSUPPORTED')),
  method_id           text NOT NULL CHECK (btrim(method_id) <> ''),
  method_version      text NOT NULL CHECK (btrim(method_version) <> ''),
  input_hash          text NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
  settings            jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
  -- Immutable copy of the scene (apparatus, connections, container inventories) and the action log
  -- the run was asked to replay, taken at run creation so that later edits to the live scene can
  -- never change what an already-queued or completed run reports.
  scene_snapshot      jsonb NOT NULL CHECK (jsonb_typeof(scene_snapshot) = 'object'),
  warnings            text[] NOT NULL DEFAULT '{}',
  assumptions         text[] NOT NULL DEFAULT '{}',
  solver_diagnostics  jsonb CHECK (solver_diagnostics IS NULL OR jsonb_typeof(solver_diagnostics) = 'object'),
  failure_code        text,
  failure_message     text,
  cancel_requested    boolean NOT NULL DEFAULT false,
  idempotency_key     text,
  owner_id            uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz,
  finished_at         timestamptz,
  CONSTRAINT lab_run_terminal_has_finished_at CHECK (
    (status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'UNSUPPORTED')) = (finished_at IS NOT NULL)
  ),
  CONSTRAINT lab_run_running_has_started_at CHECK (status = 'QUEUED' OR started_at IS NOT NULL),
  CONSTRAINT lab_run_failure_has_code CHECK (status NOT IN ('FAILED', 'UNSUPPORTED') OR failure_code IS NOT NULL)
);

COMMENT ON TABLE lab_run IS 'One immutable run of a scene''s current action log through a named method (RunResult). Never mutated except for status/result transitions.';
COMMENT ON COLUMN lab_run.scene_revision IS 'lab_scene.revision at the moment the run was created, so a result can always be tied to the exact scene state it was computed from.';
COMMENT ON COLUMN lab_run.input_hash IS 'SHA-256 (hex) of the canonical JSON of {sceneSnapshot, actions, methodId, settings}; identical requests share a hash.';
COMMENT ON COLUMN lab_run.scene_snapshot IS 'Read-only copy of stations/apparatus/connections/containerStates/simulationConfig and the requested action log at run creation.';
COMMENT ON COLUMN lab_run.failure_code IS 'Stable machine-readable reason for FAILED/UNSUPPORTED, e.g. unsupported_species or unbalanced_charge.';
COMMENT ON COLUMN lab_run.idempotency_key IS 'Client-supplied Idempotency-Key for POST .../runs; (scene_id, idempotency_key) is unique so a retried request returns the original run.';

CREATE INDEX lab_run_scene_id_idx ON lab_run (scene_id, created_at DESC);
CREATE INDEX lab_run_status_idx ON lab_run (status, created_at DESC);
CREATE INDEX lab_run_queue_idx ON lab_run (created_at) WHERE status = 'QUEUED';
CREATE UNIQUE INDEX lab_run_idempotency_key_idx ON lab_run (scene_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE lab_action_event (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id              uuid NOT NULL REFERENCES lab_run (id) ON DELETE CASCADE,
  sequence            integer NOT NULL CHECK (sequence >= 0),
  action_id           uuid NOT NULL,
  at_simulation_s     double precision NOT NULL CHECK (at_simulation_s >= 0),
  target_instance_id  uuid NOT NULL,
  type                text NOT NULL CHECK (type IN
                        ('PLACE', 'MOVE', 'ATTACH', 'DETACH', 'FILL', 'SET_VALVE', 'TRANSFER', 'START_STIRRER', 'SET_PROBE', 'RESET', 'CUSTOM')),
  payload             jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  actor_id            uuid,
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lab_action_event_run_sequence_key UNIQUE (run_id, sequence)
);

COMMENT ON TABLE lab_action_event IS 'Append-only replay log of the LabAction entries a run executed, in order; idempotency is by (run_id, action_id).';

CREATE INDEX lab_action_event_run_id_idx ON lab_action_event (run_id, sequence);
CREATE UNIQUE INDEX lab_action_event_run_action_idx ON lab_action_event (run_id, action_id);

CREATE TABLE lab_run_event (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id       uuid NOT NULL REFERENCES lab_run (id) ON DELETE CASCADE,
  sequence     integer NOT NULL CHECK (sequence >= 0),
  status       text NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNSUPPORTED')),
  message      text NOT NULL,
  observation  jsonb CHECK (observation IS NULL OR jsonb_typeof(observation) = 'object'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lab_run_event_run_sequence_key UNIQUE (run_id, sequence)
);

COMMENT ON TABLE lab_run_event IS 'Durable run-lifecycle/progress events, replayed by GET /runs/{id}/events (SSE); the stream is this table tailed in sequence order.';
COMMENT ON COLUMN lab_run_event.observation IS 'Observation payload for a progress tick that produced one, denormalised so the event is self-contained.';

CREATE INDEX lab_run_event_run_id_idx ON lab_run_event (run_id, sequence);

CREATE TABLE lab_observation (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                 uuid NOT NULL REFERENCES lab_run (id) ON DELETE CASCADE,
  scene_id               uuid NOT NULL REFERENCES lab_scene (id) ON DELETE CASCADE,
  sequence               integer NOT NULL CHECK (sequence >= 0),
  type                   text NOT NULL CHECK (type IN ('PH', 'TEMPERATURE', 'VOLUME', 'CONCENTRATION', 'INDICATOR', 'MASS')),
  apparatus_instance_id  uuid,
  time_s                 double precision NOT NULL CHECK (time_s >= 0),
  value                  double precision NOT NULL,
  unit                   text NOT NULL CHECK (btrim(unit) <> ''),
  uncertainty            double precision CHECK (uncertainty IS NULL OR uncertainty >= 0),
  evidence               text NOT NULL CHECK (evidence IN ('REFERENCE_MEASURED', 'MODEL_CALCULATED', 'ILLUSTRATIVE', 'UNVERIFIED', 'UNSUPPORTED')),
  method_id              text NOT NULL CHECK (btrim(method_id) <> ''),
  source_ids             text[] NOT NULL DEFAULT '{}',
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lab_observation_run_sequence_key UNIQUE (run_id, sequence)
);

COMMENT ON TABLE lab_observation IS 'One Observation produced by a run. Never fabricated: evidence and method_id always name how the value was obtained.';
COMMENT ON COLUMN lab_observation.apparatus_instance_id IS 'Apparatus (e.g. a PH_PROBE) the observation is attributed to; NULL for a bulk/whole-container quantity.';

CREATE INDEX lab_observation_run_id_idx ON lab_observation (run_id, sequence);
CREATE INDEX lab_observation_scene_id_idx ON lab_observation (scene_id, time_s);
CREATE INDEX lab_observation_type_idx ON lab_observation (scene_id, type);

-- ---------------------------------------------------------------------------------------------
-- Challenge attempts (Agent 08 is the authoritative owner of gameplay scoring; this table is an
-- additive, minimal persistence surface so attempts survive a reload. Agent 09 does not interpret
-- `details` or compute `score`.)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE challenge_attempt (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scene_id       uuid NOT NULL REFERENCES lab_scene (id) ON DELETE CASCADE,
  challenge_key  text NOT NULL CHECK (btrim(challenge_key) <> ''),
  status         text NOT NULL CHECK (status IN ('IN_PROGRESS', 'COMPLETED', 'ABANDONED')),
  score          double precision,
  details        jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  owner_id       uuid,
  started_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz,
  CONSTRAINT challenge_attempt_completed_has_timestamp CHECK (status <> 'COMPLETED' OR completed_at IS NOT NULL)
);

COMMENT ON TABLE challenge_attempt IS 'Persistence of one guided-challenge attempt against a scene; scoring logic belongs to Agent 08.';

CREATE INDEX challenge_attempt_scene_id_idx ON challenge_attempt (scene_id, started_at DESC);
CREATE INDEX challenge_attempt_challenge_key_idx ON challenge_attempt (challenge_key);
