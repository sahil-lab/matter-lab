/**
 * Durable snapshot shape the engine saves and Agent 09 persists (brief item 7: "save, reopen and
 * replay"). Extends `@matterlab/contracts`' `ExperimentSnapshot` with the one field needed for a
 * *faithful* replay from scratch: the scene exactly as it was before the first event. `scene`
 * itself (inherited) stays the *current* scene, so anything reading this only as an
 * `ExperimentSnapshot` (e.g. Agent 09 showing "what does this station look like right now") still
 * works unmodified.
 */
import {
  EXPERIMENT_SNAPSHOT_SCHEMA,
  EXPERIMENT_SNAPSHOT_SCHEMA_VERSION,
  type ExperimentScene,
  type ExperimentSnapshot,
  type LabEventRecord,
  type Observation,
} from '@matterlab/contracts';

export interface EngineSnapshot extends ExperimentSnapshot {
  readonly baseScene: ExperimentScene;
}

export function buildEngineSnapshot(
  baseScene: ExperimentScene,
  scene: ExperimentScene,
  events: readonly LabEventRecord[],
  observations: readonly Observation[],
  savedAt: string,
): EngineSnapshot {
  return {
    schema: EXPERIMENT_SNAPSHOT_SCHEMA,
    schemaVersion: EXPERIMENT_SNAPSHOT_SCHEMA_VERSION,
    scene,
    events,
    observations,
    savedAt,
    baseScene,
  };
}
