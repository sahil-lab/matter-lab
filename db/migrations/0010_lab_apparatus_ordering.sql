-- 0010: deterministic ordering for apparatus instances and connections (Astra lab extension).
--
-- created_at alone is not a reliable tie-breaker: apparatus placed in the same request can share a
-- timestamp, so the array order ExperimentScene.apparatus/connections was saved with would not
-- reliably survive a reopen. An explicit position column (populated in request order) fixes this,
-- mirroring lab_station.position (0006).

ALTER TABLE apparatus_instance ADD COLUMN position integer NOT NULL DEFAULT 0;
ALTER TABLE apparatus_connection ADD COLUMN position integer NOT NULL DEFAULT 0;

CREATE INDEX apparatus_instance_scene_position_idx ON apparatus_instance (scene_id, position);
CREATE INDEX apparatus_connection_scene_position_idx ON apparatus_connection (scene_id, position);

COMMENT ON COLUMN apparatus_instance.position IS 'Order within ExperimentScene.apparatus as last saved; not a scene coordinate.';
COMMENT ON COLUMN apparatus_connection.position IS 'Order within ExperimentScene.connections as last saved.';
