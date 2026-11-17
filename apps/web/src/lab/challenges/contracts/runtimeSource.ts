/**
 * Read-only view onto Agent 07's authoritative runtime (the real `ExperimentEngine`, live) or a
 * replayed/fixture log (for testing and for replay/compare). Agent 08 never calls a mutator here:
 * operating apparatus is dispatched through `LabAction`s (built with `@matterlab/contracts`'
 * action builders and Agent 07's `apps/web/src/lab/experiments` action helpers), not through this
 * read surface.
 *
 * Shaped to match `ExperimentEngine`'s own public surface closely (see
 * `apps/web/src/lab/experiments/runtime/engine.ts`) so adapting a real engine instance is nearly
 * free — see `integration/realEngineSource.ts`.
 */
import type { ExperimentScene, LabEventRecord, Observation, UUID } from '@matterlab/contracts';

export interface ExperimentRuntimeSource {
  /** Whether a real engine is behind this source. See `NOT_CONNECTED_SOURCE` below. */
  readonly connectionStatus: 'connected' | 'not-connected';
  getScene(): ExperimentScene | null;
  getEventLog(): readonly LabEventRecord[];
  getObservations(apparatusId?: UUID): readonly Observation[];
  /** Notifies `listener` whenever the event log, scene or observations change. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

/**
 * Honest default used until a real engine is wired in: reports an explicit `not-connected` status
 * rather than silently behaving as if an empty lab were a completed one. UI built against this
 * must show an "experiment runtime not connected" state, not a blank success.
 */
export const NOT_CONNECTED_SOURCE: ExperimentRuntimeSource = {
  connectionStatus: 'not-connected',
  getScene: () => null,
  getEventLog: () => [],
  getObservations: () => [],
  subscribe: () => () => {},
};
