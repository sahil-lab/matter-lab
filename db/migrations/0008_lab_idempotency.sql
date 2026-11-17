-- 0008: API idempotency keys for the lab REST endpoints (Astra 3D laboratory extension, Agent 09).
--
-- A client retrying a POST (scene create, scene duplicate, run create, template create) after a
-- dropped response supplies the same Idempotency-Key; the second request returns the first
-- response verbatim instead of creating a second resource.

CREATE TABLE api_idempotency_key (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope            text NOT NULL CHECK (btrim(scope) <> ''),
  idempotency_key  text NOT NULL CHECK (btrim(idempotency_key) <> ''),
  request_hash     text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  response_status  integer NOT NULL CHECK (response_status BETWEEN 100 AND 599),
  response_body    jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT api_idempotency_key_scope_key_key UNIQUE (scope, idempotency_key)
);

COMMENT ON TABLE api_idempotency_key IS
  'Replayed responses for POST requests carrying an Idempotency-Key header. request_hash detects a key reused with a different body (409, not a silent replay).';
COMMENT ON COLUMN api_idempotency_key.scope IS 'Logical endpoint the key belongs to, e.g. lab_scene_create or lab_run_create.';
COMMENT ON COLUMN api_idempotency_key.request_hash IS 'SHA-256 (hex) of the canonical JSON of the request body that produced response_body.';

CREATE INDEX api_idempotency_key_created_at_idx ON api_idempotency_key (created_at);
