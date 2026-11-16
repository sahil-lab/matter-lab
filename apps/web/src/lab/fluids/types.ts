import type {
  ApparatusRuntimeState, Quaternion, RuntimeSnapshot, StationStatus, UUID,
} from '@matterlab/contracts';
import type { SceneQualityPreset } from '../environment/types';

export interface FluidScope {
  readonly runId: UUID;
  readonly stationId: UUID;
  readonly epoch: number;
  readonly simulationTimeS: number;
  readonly status: StationStatus;
  readonly lastSequence: number;
}

export interface FluidVisualSettings {
  readonly quality?: SceneQualityPreset;
  readonly lowPower?: boolean;
  readonly reducedMotion?: boolean;
  /** Explicit material fallback after a renderer/material error; never selects a second renderer. */
  readonly materialMode?: 'physical' | 'opacity';
  readonly enabled?: boolean;
}

export interface ResolvedFluidSettings {
  readonly quality: SceneQualityPreset;
  readonly lowPower: boolean;
  readonly reducedMotion: boolean;
  readonly materialMode: 'physical' | 'opacity';
  readonly enabled: boolean;
  readonly angularSegments: number;
  readonly surfaceRings: number;
  readonly maxDroplets: number;
  readonly motionUpdatesPerS: number;
  readonly maxSurfaceAmplitudeM: number;
}

export type StirringState = ApparatusRuntimeState['stirring'];
export type FluidOrientation = Quaternion;
export type ColorSrgb = readonly [number, number, number];

export function fluidScope(snapshot: RuntimeSnapshot, stationId: UUID): FluidScope | undefined {
  const station = snapshot.stationStates[stationId];
  if (!station) return undefined;
  return {
    runId: snapshot.runId, stationId, epoch: station.epoch,
    simulationTimeS: station.simulationTimeS, status: station.status,
    lastSequence: snapshot.lastSequence,
  };
}

export function sameFluidScope(a: FluidScope, b: FluidScope): boolean {
  return a.runId === b.runId && a.stationId === b.stationId && a.epoch === b.epoch;
}
