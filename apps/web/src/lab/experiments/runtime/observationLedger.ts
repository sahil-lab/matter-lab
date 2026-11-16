/**
 * Append-only store of solver-derived `Observation`s, plus the staleness guard the engine needs
 * because solver calls are async while ticks and user actions keep changing state (brief item 6:
 * "Sensor models read solver results, not ambient invented readings").
 *
 * Race this guards against: a container changes at tick N (request A fired), changes again at tick
 * N+1 before A resolves (request B fired), and A's response arrives *after* B's. Without a
 * generation counter, A's stale answer would overwrite B's newer one. Each apparatus has its own
 * monotonically increasing `generation`; a response is only ever recorded if it is still the latest
 * generation requested for that apparatus.
 */
import type { Observation, ObservationType, UUID } from '@matterlab/contracts';

export interface ObservationLedgerState {
  readonly observations: readonly Observation[];
  readonly latestGenerationByApparatus: Readonly<Record<UUID, number>>;
}

export const EMPTY_OBSERVATION_LEDGER: ObservationLedgerState = Object.freeze({
  observations: [],
  latestGenerationByApparatus: {},
});

/** Call when *starting* a solver request for `apparatusId`; its returned generation travels with the request. */
export function beginRecompute(state: ObservationLedgerState, apparatusId: UUID): { state: ObservationLedgerState; generation: number } {
  const generation = (state.latestGenerationByApparatus[apparatusId] ?? 0) + 1;
  return {
    state: { ...state, latestGenerationByApparatus: { ...state.latestGenerationByApparatus, [apparatusId]: generation } },
    generation,
  };
}

export function isStale(state: ObservationLedgerState, apparatusId: UUID, generation: number): boolean {
  return (state.latestGenerationByApparatus[apparatusId] ?? 0) !== generation;
}

export interface RecordObservationsOutcome {
  readonly state: ObservationLedgerState;
  /** False exactly when this response was discarded for being stale. */
  readonly accepted: boolean;
}

export function recordObservations(
  state: ObservationLedgerState,
  apparatusId: UUID,
  generation: number,
  observations: readonly Observation[],
): RecordObservationsOutcome {
  if (isStale(state, apparatusId, generation)) return { state, accepted: false };
  if (observations.length === 0) return { state, accepted: true };
  return { state: { ...state, observations: [...state.observations, ...observations] }, accepted: true };
}

export function observationsFor(state: ObservationLedgerState, apparatusId: UUID): readonly Observation[] {
  return state.observations.filter((o) => o.apparatusId === apparatusId);
}

export function latestObservation(state: ObservationLedgerState, apparatusId: UUID, type?: ObservationType): Observation | undefined {
  const matching = observationsFor(state, apparatusId).filter((o) => !type || o.type === type);
  return matching.length > 0 ? matching[matching.length - 1] : undefined;
}
