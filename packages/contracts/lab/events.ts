/**
 * Append-only event log and versioned snapshot shapes (Agent 07 required implementation item 3;
 * Agent 09 required implementation item 3: "Persist immutable run snapshots and results"). The
 * event log is the source of truth for replay (00_SHARED_INTEGRATION_CONTRACT.md Section 6 step 7:
 * "Pause, resume, reset, save, reopen and replay"): re-applying the same ordered action list from
 * the same starting snapshot must reproduce the same scene and the same observations.
 */

import type { ExperimentScene, LabAction, Observation } from './types';

export type LabEventOutcome = 'APPLIED' | 'REJECTED' | 'DUPLICATE';

/**
 * One append-only record of something that was *attempted* against the experiment graph. Rejected
 * actions are recorded too (with a reason) so a replay or an audit trail can see exactly what a
 * user or the simulation clock tried, not only what stuck.
 */
export interface LabEventRecord {
  /** Monotonically increasing per scene; never reused, never reordered. */
  readonly sequence: number;
  readonly action: LabAction;
  /** Wall-clock time the action was accepted into the log (ISO 8601 UTC). */
  readonly receivedAt: string;
  readonly sceneRevisionBefore: number;
  readonly sceneRevisionAfter: number;
  readonly outcome: LabEventOutcome;
  readonly rejectionReason?: string;
  /** Solver requests queued as a direct consequence of this action, if any (see `solver.ts`). */
  readonly pendingObservationRequestIds?: readonly string[];
  /**
   * Non-fatal notices about an `APPLIED` action, e.g. a `TRANSFER` clamped to the volume actually
   * available in the source or the headroom actually available in the receiver. Conservation still
   * holds exactly for whatever volume *was* moved; this records that the requested amount and the
   * applied amount differed, instead of silently doing one or the other.
   */
  readonly warnings?: readonly string[];
}

export const EXPERIMENT_SNAPSHOT_SCHEMA = 'matterlab.lab.experiment-snapshot';
export const EXPERIMENT_SNAPSHOT_SCHEMA_VERSION = 1;

/**
 * A durable, versioned bundle of everything Agent 09 needs to persist and later reopen a station
 * exactly: the current authoritative scene, the full append-only log that produced it, and every
 * observation recorded so far. `events`/`observations` are kept alongside `scene` (not reconstructed
 * only from one or the other) so persistence does not have to replay history just to display it.
 */
export interface ExperimentSnapshot {
  readonly schema: typeof EXPERIMENT_SNAPSHOT_SCHEMA;
  readonly schemaVersion: typeof EXPERIMENT_SNAPSHOT_SCHEMA_VERSION;
  readonly scene: ExperimentScene;
  readonly events: readonly LabEventRecord[];
  readonly observations: readonly Observation[];
  readonly savedAt: string;
}

/** Scopes a `RESET` action: a single station, or the whole multi-station scene. */
export type ResetScope = 'STATION' | 'SCENE';

export interface ResetPayload extends Record<string, unknown> {
  readonly scope: ResetScope;
  /** Whether to also drop connections (default false: equipment stays rigged, chemicals are cleared). */
  readonly clearConnections?: boolean;
}

export function isLabEventRecord(value: unknown): value is LabEventRecord {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<LabEventRecord>;
  return typeof v.sequence === 'number' && typeof v.receivedAt === 'string' && typeof v.outcome === 'string';
}

export function nextEventSequence(events: readonly LabEventRecord[]): number {
  return events.length === 0 ? 0 : events[events.length - 1]!.sequence + 1;
}
