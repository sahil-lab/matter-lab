-- Optional learning metadata is a client draft, never a verified score or scientific run output.
ALTER TABLE lab_scene ADD COLUMN learning_state jsonb;
ALTER TABLE lab_scene ADD CONSTRAINT lab_scene_learning_state_format CHECK (
  learning_state IS NULL OR (
    jsonb_typeof(learning_state) = 'object'
    AND learning_state ?& ARRAY['schemaVersion','kind','attempts']
    AND learning_state->>'kind' = 'MATTERLAB_LEARNING_STATE'
    AND learning_state->>'schemaVersion' = '1'
    AND jsonb_typeof(learning_state->'attempts') = 'array'
    AND octet_length(learning_state::text) <= 8 * 1024 * 1024
  )
);
ALTER TABLE lab_run ADD COLUMN learning_state_snapshot jsonb;
ALTER TABLE lab_run ADD CONSTRAINT lab_run_learning_state_format CHECK (
  learning_state_snapshot IS NULL OR (
    jsonb_typeof(learning_state_snapshot) = 'object'
    AND learning_state_snapshot ?& ARRAY['schemaVersion','kind','attempts']
    AND learning_state_snapshot->>'kind' = 'MATTERLAB_LEARNING_STATE'
    AND learning_state_snapshot->>'schemaVersion' = '1'
    AND jsonb_typeof(learning_state_snapshot->'attempts') = 'array'
    AND octet_length(learning_state_snapshot::text) <= 8 * 1024 * 1024
  )
);
COMMENT ON COLUMN lab_scene.learning_state IS 'Agent08 validated CLIENT/DRAFT metadata. Scores are derived by the learning module, not trusted or endorsed by the API.';
COMMENT ON COLUMN lab_run.learning_state_snapshot IS 'Frozen client learning metadata at enqueue; deliberately excluded from the scientific NodeRunRequest/inputHash.';
