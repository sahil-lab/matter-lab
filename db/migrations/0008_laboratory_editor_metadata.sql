-- Editor selection/locks/groups are UI metadata, not a change to the authoritative runtime scene.
ALTER TABLE lab_scene ADD COLUMN editor_state jsonb;
ALTER TABLE lab_scene ADD CONSTRAINT lab_scene_editor_state_format CHECK (
  editor_state IS NULL OR (
    jsonb_typeof(editor_state) = 'object'
    AND editor_state ?& ARRAY['schemaVersion','sceneId']
    AND editor_state->>'schemaVersion' = '1'
    AND editor_state->>'sceneId' = id::text
    AND octet_length(editor_state::text) <= 512 * 1024
  )
);
ALTER TABLE lab_run ADD COLUMN editor_state_snapshot jsonb;
ALTER TABLE lab_run ADD CONSTRAINT lab_run_editor_state_format CHECK (
  editor_state_snapshot IS NULL OR (
    jsonb_typeof(editor_state_snapshot) = 'object'
    AND editor_state_snapshot ?& ARRAY['schemaVersion','sceneId']
    AND editor_state_snapshot->>'schemaVersion' = '1'
    AND editor_state_snapshot->>'sceneId' = scene_id::text
    AND octet_length(editor_state_snapshot::text) <= 512 * 1024
  )
);
COMMENT ON COLUMN lab_scene.editor_state IS 'Agent04 editor-only sidecar; never injected into runtime checkpoint scenes or scientific input hashes.';
