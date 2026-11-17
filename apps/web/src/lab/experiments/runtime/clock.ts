/**
 * Per-station simulation clock (brief item 5: "configurable fixed simulation ticks and render
 * interpolation"; item 7: "pause, resume, replay, simulation speed, reset"). Each station has its
 * own independent clock so pausing one never affects another (acceptance test: "Two stations can
 * run independently").
 *
 * This module only holds clock *state transitions*; the engine decides what a tick actually does
 * (generate `TRANSFER`s from open valves) and is the only thing that calls `stepOnce`.
 */
import { DEFAULT_SIMULATION_SPEED, DEFAULT_SIMULATION_TIME_STEP_S, type ClockStatus, type UUID } from '@matterlab/contracts';

export interface StationClockState {
  readonly stationId: UUID;
  readonly status: ClockStatus;
  /** Simulation time elapsed for this station, in seconds; advances only in whole `timeStepS` increments. */
  readonly simulationS: number;
  /** Multiplier applied to real elapsed time by `ticksForElapsed`. Always > 0. */
  readonly speed: number;
  readonly timeStepS: number;
  /** Count of ticks executed since this clock was created or last reset; seeds deterministic tick action ids. */
  readonly tickIndex: number;
}

export function createStationClock(
  stationId: UUID,
  timeStepS: number = DEFAULT_SIMULATION_TIME_STEP_S,
  speed: number = DEFAULT_SIMULATION_SPEED,
): StationClockState {
  return { stationId, status: 'IDLE', simulationS: 0, speed, timeStepS, tickIndex: 0 };
}

export function startClock(clock: StationClockState): StationClockState {
  return clock.status === 'RUNNING' ? clock : { ...clock, status: 'RUNNING' };
}

export function pauseClock(clock: StationClockState): StationClockState {
  return clock.status !== 'RUNNING' ? clock : { ...clock, status: 'PAUSED' };
}

export function setClockSpeed(clock: StationClockState, speed: number): StationClockState {
  if (!Number.isFinite(speed) || speed <= 0) return clock;
  return { ...clock, speed };
}

export function resetClock(clock: StationClockState): StationClockState {
  return createStationClock(clock.stationId, clock.timeStepS, clock.speed);
}

/** One fixed tick: advances simulation time and the tick counter by exactly one step, unconditionally. */
export function stepOnce(clock: StationClockState): StationClockState {
  return { ...clock, simulationS: clock.simulationS + clock.timeStepS, tickIndex: clock.tickIndex + 1 };
}

/**
 * How many whole ticks `elapsedRealS` of real time should produce at this clock's `speed`, capped
 * at `maxTicks` so a tab that was hidden for an hour does not try to replay thousands of ticks in
 * one burst (a conventional "spiral of death" guard, not a scientific assumption).
 */
export function ticksForElapsed(clock: StationClockState, elapsedRealS: number, maxTicks: number): number {
  if (clock.status !== 'RUNNING' || !Number.isFinite(elapsedRealS) || elapsedRealS <= 0) return 0;
  const exact = Math.floor((elapsedRealS * clock.speed) / clock.timeStepS);
  return Math.min(Math.max(0, exact), maxTicks);
}
