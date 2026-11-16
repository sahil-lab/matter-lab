-- Laboratory state is additive: the molecular catalogue, experiments and calculations are unchanged.
CREATE TABLE lab_scene (
  id                uuid PRIMARY KEY,
  owner_id          uuid NOT NULL,
  title             text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 300),
  revision          integer NOT NULL CHECK (revision >= 1),
  schema_version    smallint NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  scene             jsonb NOT NULL CHECK (jsonb_typeof(scene) = 'object'),
  runtime_checkpoint jsonb CHECK (jsonb_typeof(runtime_checkpoint) = 'object'),
  catalog_snapshot  jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(catalog_snapshot) = 'object'),
  source_id         bigint NOT NULL REFERENCES data_sources(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, owner_id),
  CHECK (scene ?& ARRAY['id','revision','schemaVersion']),
  CHECK (scene->>'id' = id::text),
  CHECK ((scene->>'revision')::integer = revision),
  CHECK ((scene->>'schemaVersion')::integer = schema_version)
);
CREATE INDEX lab_scene_owner_updated_idx ON lab_scene(owner_id, updated_at DESC, id);
CREATE TRIGGER lab_scene_updated BEFORE UPDATE ON lab_scene
  FOR EACH ROW EXECUTE FUNCTION matterlab_set_updated_at();

CREATE TABLE lab_template (
  id                uuid PRIMARY KEY,
  owner_id          uuid NOT NULL,
  title             text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 300),
  kind              text NOT NULL CHECK (kind IN ('SCENE', 'ASSEMBLY')),
  schema_version    smallint NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  scene             jsonb NOT NULL CHECK (jsonb_typeof(scene) = 'object'),
  catalog_snapshot  jsonb NOT NULL CHECK (jsonb_typeof(catalog_snapshot) = 'object'),
  source_id         bigint NOT NULL REFERENCES data_sources(id),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lab_template_owner_created_idx ON lab_template(owner_id, created_at DESC, id);

CREATE TABLE lab_run (
  id                uuid PRIMARY KEY,
  scene_id          uuid NOT NULL,
  owner_id          uuid NOT NULL,
  scene_revision    integer NOT NULL CHECK (scene_revision >= 1),
  status            text NOT NULL CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED','UNSUPPORTED')),
  input_snapshot    jsonb NOT NULL CHECK (jsonb_typeof(input_snapshot) = 'object'),
  input_hash        text NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  contract_version  text NOT NULL CHECK (contract_version <> ''),
  runtime_version   text NOT NULL CHECK (runtime_version <> ''),
  method_id         text NOT NULL CHECK (method_id <> ''),
  method_version    text NOT NULL CHECK (method_version <> ''),
  runner_sha256     text CHECK (runner_sha256 ~ '^[a-f0-9]{64}$'),
  catalog_snapshot  jsonb NOT NULL CHECK (jsonb_typeof(catalog_snapshot) = 'object'),
  units_policy      jsonb NOT NULL CHECK (jsonb_typeof(units_policy) = 'object'),
  result            jsonb CHECK (jsonb_typeof(result) = 'object'),
  checkpoint        jsonb CHECK (jsonb_typeof(checkpoint) = 'object'),
  failure_code      text,
  artifacts         jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(artifacts) = 'array'),
  worker_id         uuid,
  heartbeat_at      timestamptz,
  cancel_requested  boolean NOT NULL DEFAULT false,
  source_id         bigint NOT NULL REFERENCES data_sources(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  completed_at      timestamptz,
  FOREIGN KEY (scene_id, owner_id) REFERENCES lab_scene(id, owner_id),
  UNIQUE (id, owner_id),
  CHECK (input_snapshot ?& ARRAY['runId','initialScene','steps','contractVersion','runtimeVersion','methodVersion']),
  CHECK (input_snapshot->>'runId' = id::text),
  CHECK (input_snapshot->'initialScene'->>'id' = scene_id::text),
  CHECK (input_snapshot->>'contractVersion' = contract_version),
  CHECK (input_snapshot->>'runtimeVersion' = runtime_version),
  CHECK (input_snapshot->>'methodVersion' = method_version),
  CHECK ((status IN ('QUEUED','RUNNING')) = (completed_at IS NULL)),
  CHECK (status <> 'RUNNING' OR (worker_id IS NOT NULL AND heartbeat_at IS NOT NULL AND started_at IS NOT NULL)),
  CHECK (status NOT IN ('SUCCEEDED','UNSUPPORTED') OR result IS NOT NULL),
  CHECK (status <> 'FAILED' OR failure_code IS NOT NULL),
  CHECK (result IS NULL OR (result->>'status' = status AND result->>'runId' = id::text AND result->>'inputHash' = input_hash))
);
CREATE INDEX lab_run_queue_idx ON lab_run(created_at, id) WHERE status = 'QUEUED';
CREATE INDEX lab_run_scene_idx ON lab_run(owner_id, scene_id, created_at DESC, id);
CREATE INDEX lab_run_heartbeat_idx ON lab_run(heartbeat_at) WHERE status = 'RUNNING';

CREATE FUNCTION matterlab_lab_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Laboratory runs are immutable audit records' USING ERRCODE = '23514';
  END IF;
  IF OLD.status NOT IN ('QUEUED','RUNNING') THEN
    RAISE EXCEPTION 'A terminal laboratory run is immutable' USING ERRCODE = '23514';
  END IF;
  IF (to_jsonb(NEW) - ARRAY['status','result','checkpoint','failure_code','artifacts','worker_id',
        'heartbeat_at','cancel_requested','started_at','completed_at'])
     IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status','result','checkpoint','failure_code','artifacts','worker_id',
        'heartbeat_at','cancel_requested','started_at','completed_at']) THEN
    RAISE EXCEPTION 'A laboratory run input snapshot is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'RUNNING' AND NEW.status = 'QUEUED' THEN
    RAISE EXCEPTION 'A running laboratory run cannot be requeued' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lab_run_immutable BEFORE UPDATE OR DELETE ON lab_run
  FOR EACH ROW EXECUTE FUNCTION matterlab_lab_run_guard();

CREATE TABLE lab_run_event (
  run_id     uuid NOT NULL REFERENCES lab_run(id),
  sequence   bigint NOT NULL CHECK (sequence >= 1),
  event_type text NOT NULL,
  data       jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, sequence)
);
CREATE TABLE lab_action_event (
  run_id     uuid NOT NULL REFERENCES lab_run(id),
  sequence   bigint NOT NULL CHECK (sequence >= 0),
  data       jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  PRIMARY KEY (run_id, sequence)
);
CREATE TABLE lab_observation (
  run_id      uuid NOT NULL REFERENCES lab_run(id),
  ordinal     integer NOT NULL CHECK (ordinal >= 0),
  observation jsonb NOT NULL CHECK (jsonb_typeof(observation) = 'object'),
  PRIMARY KEY (run_id, ordinal)
);
CREATE FUNCTION matterlab_lab_ledger_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Laboratory ledgers are append-only' USING ERRCODE = '23514';
  END IF;
  IF (SELECT status FROM lab_run WHERE id = NEW.run_id FOR UPDATE) NOT IN ('QUEUED','RUNNING') THEN
    RAISE EXCEPTION 'A terminal laboratory run ledger is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lab_run_event_guard BEFORE INSERT OR UPDATE OR DELETE ON lab_run_event
  FOR EACH ROW EXECUTE FUNCTION matterlab_lab_ledger_guard();
CREATE TRIGGER lab_action_event_guard BEFORE INSERT OR UPDATE OR DELETE ON lab_action_event
  FOR EACH ROW EXECUTE FUNCTION matterlab_lab_ledger_guard();
CREATE TRIGGER lab_observation_guard BEFORE INSERT OR UPDATE OR DELETE ON lab_observation
  FOR EACH ROW EXECUTE FUNCTION matterlab_lab_ledger_guard();

CREATE TABLE lab_idempotency (
  owner_id       uuid NOT NULL,
  route          text NOT NULL CHECK (length(route) <= 200),
  key            text NOT NULL CHECK (length(key) BETWEEN 1 AND 128),
  request_hash   text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  status_code    smallint NOT NULL CHECK (status_code BETWEEN 200 AND 299),
  response       jsonb NOT NULL CHECK (jsonb_typeof(response) = 'object'),
  etag           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, route, key)
);
COMMENT ON TABLE lab_idempotency IS 'Owner- and route-scoped committed responses; a key cannot silently change its request.';
COMMENT ON COLUMN lab_run.input_hash IS 'SHA-256 of RFC8785 canonical NodeRunRequest with only runId omitted.';
COMMENT ON COLUMN lab_scene.scene IS 'Exact canonical ExperimentScene; scene.revision is the durable revision, not RuntimeSnapshot.revision.';
