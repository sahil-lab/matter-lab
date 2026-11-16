/**
 * STUB CONTRACT — pending Agent 07's real event/observation stream (`apps/web/src/lab/experiments/**`).
 *
 * Agent 07's brief requires an "append-only event log and versioned snapshots" and to "publish
 * event stream for graph, indicator, 3D renderer, UI and Agent 08 challenges" (see
 * `Agent_07_Experiment_Graph_State_and_Simulation_Runtime.md`, items 3 and 6). That runtime does
 * not exist in this worktree. This module defines the minimal read-only shape Agent 08's goal
 * evaluator, scoring rubric and notebook builder need from it, so they can be built and tested now
 * and re-pointed at the real runtime later without changing their logic.
 *
 * Non-negotiable: everything downstream of `ExperimentRuntimeSource` must treat it as the *only*
 * source of truth for scientific state. No code under `lab/challenges/**` may invent an
 * observation, a run result or a scene mutation — if the source has nothing, the honest answer is
 * "not enough data yet", never a fabricated value.
 */

import type { ExperimentScene, LabAction, Observation, RunResult, UUID } from './sceneTypes';

/**
 * One entry of Agent 07's append-only event log. `sequence` is a strictly increasing integer per
 * station so consumers (including replay) can detect gaps/reordering and so idempotent replays are
 * detectable (same `sequence` + same payload = already applied).
 */
export type LabEvent =
  | { readonly kind: 'ACTION_APPLIED'; readonly sequence: number; readonly stationId: UUID; readonly action: LabAction; readonly resultingSceneRevision: number }
  | { readonly kind: 'OBSERVATION_RECORDED'; readonly sequence: number; readonly stationId: UUID; readonly runId: UUID; readonly observation: Observation }
  | { readonly kind: 'RUN_RESULT'; readonly sequence: number; readonly stationId: UUID; readonly result: RunResult }
  | { readonly kind: 'SCENE_RESET'; readonly sequence: number; readonly stationId: UUID; readonly atSimulationS: number };

export function eventSequence(event: LabEvent): number {
  return event.sequence;
}

export function eventStationId(event: LabEvent): UUID {
  return event.stationId;
}

/**
 * Read-only view onto Agent 07's authoritative runtime (live) or a replayed/fixture log (for
 * testing and for replay/compare). Agent 08 never calls a mutator here: operating apparatus is
 * dispatched through Agent 04's `LabAction` dispatch, not through this contract.
 */
export interface ExperimentRuntimeSource {
  /** Whether a real Agent 07 runtime is behind this source. See `NOT_CONNECTED_SOURCE` below. */
  readonly connectionStatus: 'connected' | 'not-connected';
  /** The current authoritative scene for a station, or `null` before anything has been placed. */
  getScene(stationId: UUID): ExperimentScene | null;
  /** The full ordered event log observed so far for a station (actions + observations + run results). */
  getEvents(stationId: UUID): readonly LabEvent[];
  /** The run results observed so far for a station, most recent last. */
  getRunResults(stationId: UUID): readonly RunResult[];
  /** All station ids the source currently knows about. */
  listStations(): readonly UUID[];
  /** Notifies `listener` whenever the event log, scene or run results change. Returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

/**
 * Honest default used until Agent 07's runtime is wired in: reports zero stations and an explicit
 * `not-connected` status rather than silently behaving as if an empty lab were a completed one.
 * UI built against this must show an "experiment runtime not connected" state, not a blank success.
 */
export const NOT_CONNECTED_SOURCE: ExperimentRuntimeSource = {
  connectionStatus: 'not-connected',
  getScene: () => null,
  getEvents: () => [],
  getRunResults: () => [],
  listStations: () => [],
  subscribe: () => () => {},
};
