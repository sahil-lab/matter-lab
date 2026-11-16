/**
 * Droplet spawn scheduling and fall trajectory. Everything here is a function of the authoritative
 * `FluidOutflow.flowRateMlPerS` Agent 07 streams (never invented by this module) plus ordinary
 * free-fall kinematics (g = 9.81 m/s^2, real physics, not a chemistry result). A rate of exactly
 * zero spawns nothing and forgets any fractional drop that had been building up, so a paused or
 * finished transfer never produces a drop out of nowhere when flow resumes, and a reset can clear
 * in-flight drops without leaving a fractional carry-over to pay off later.
 */

/** A single drop is this many milliliters, a commonly cited rule of thumb for a burette tip (~20 drops/mL). */
export const DEFAULT_DROP_VOLUME_ML = 0.05;

export interface DropletSpawnState {
  /** Fractional milliliters delivered since the last whole drop fell. */
  readonly accumulatedMl: number;
}

export const INITIAL_DROPLET_SPAWN_STATE: DropletSpawnState = { accumulatedMl: 0 };

export interface DropletSpawnResult {
  readonly state: DropletSpawnState;
  /** Usually 0 or 1 for a normal frame; can exceed 1 after a large `dtS` (e.g. a tab was backgrounded). */
  readonly dropsSpawned: number;
}

/**
 * Advances the drop-formation accumulator by one simulation/render step. Call once per frame (or
 * once per fixed tick) with the current authoritative flow rate; each time the accumulated volume
 * reaches `dropVolumeMl`, one drop is reported and the remainder carries forward.
 */
export function advanceDropletSpawn(state: DropletSpawnState, flowRateMlPerS: number, dtS: number, dropVolumeMl: number = DEFAULT_DROP_VOLUME_ML): DropletSpawnResult {
  if (!(flowRateMlPerS > 0) || !(dtS > 0)) return { state: INITIAL_DROPLET_SPAWN_STATE, dropsSpawned: 0 };
  let accumulated = state.accumulatedMl + flowRateMlPerS * dtS;
  let drops = 0;
  const volume = Math.max(dropVolumeMl, 1e-6);
  while (accumulated >= volume) {
    accumulated -= volume;
    drops++;
  }
  return { state: { accumulatedMl: accumulated }, dropsSpawned: drops };
}

const GRAVITY_M_PER_S2 = 9.81;
/** Fall time used for a drop whose source and target sit at (or very near) the same height. */
const MIN_FALL_DURATION_S = 0.12;

/** Real free-fall time (seconds) between two world points, from `h = 1/2 g t^2`. */
export function dropletFallDurationS(fromPointM: readonly [number, number, number], toPointM: readonly [number, number, number]): number {
  const dropHeightM = fromPointM[1] - toPointM[1];
  if (!(dropHeightM > 0)) return MIN_FALL_DURATION_S;
  return Math.sqrt((2 * dropHeightM) / GRAVITY_M_PER_S2);
}

/**
 * World position of a falling drop at `ageS` seconds after release. Horizontal motion is linear;
 * vertical motion is quadratic in time, matching constant downward acceleration. Clamped to the
 * target point once `ageS >= durationS`, so a caller can safely keep calling this past landing.
 */
export function dropletPositionAt(
  fromPointM: readonly [number, number, number],
  toPointM: readonly [number, number, number],
  ageS: number,
  durationS: number,
): readonly [number, number, number] {
  const t = durationS > 0 ? Math.min(1, Math.max(0, ageS / durationS)) : 1;
  const x = fromPointM[0] + (toPointM[0] - fromPointM[0]) * t;
  const z = fromPointM[2] + (toPointM[2] - fromPointM[2]) * t;
  const y = fromPointM[1] + (toPointM[1] - fromPointM[1]) * (t * t);
  return [x, y, z];
}
