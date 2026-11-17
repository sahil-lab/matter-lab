/**
 * Deterministic identifier helpers. Replay (brief item 7; acceptance test "replay produces
 * identical observations") depends on the simulation clock and the solver seam generating the
 * *same* ids given the same history, not fresh random ones each run.
 */

let fallbackCounter = 0;

/** Real random UUID for user-initiated actions (ids only need to be unique, not reproducible). */
export function generateUUID(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto && typeof g.crypto.randomUUID === 'function') return g.crypto.randomUUID();
  fallbackCounter += 1;
  return `id-${Date.now().toString(36)}-${fallbackCounter}-${Math.random().toString(36).slice(2)}`;
}

/**
 * The action id a fixed simulation tick uses for the synthetic `TRANSFER` it generates on one
 * fluid connection. Deterministic in `(stationId, connectionId, tickIndex)` so: (a) replaying the
 * same tick sequence reproduces the same ids, and (b) accidentally ticking twice for the same tick
 * index is caught as a `DUPLICATE` by the event log instead of double-transferring.
 */
export function tickTransferActionId(stationId: string, connectionId: string, tickIndex: number): string {
  return `tick:${stationId}:${connectionId}:${tickIndex}`;
}

/** The solver request id for the `generation`-th recompute of one apparatus's contents. */
export function solverRequestId(apparatusId: string, generation: number): string {
  return `solver:${apparatusId}:${generation}`;
}
