/**
 * Reactive environment state: presentation only (room/studio, lighting mood, quality, which
 * station is active, camera mode, bookmarks, grid visibility). Apparatus, connections and
 * container contents are Agent 07's store, not this one; `LabWorld` renders whatever Agent
 * 03/04/07 supply for each station inside the slots this module lays out.
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { DEFAULT_LIGHTING_PRESET } from './RoomConfig';
import { createStation } from './stations';
import type { CameraBookmark, CameraMode, EnvironmentMode, LightingPresetId, SceneQualityId, StationRecord, UUID } from './types';

export interface EnvironmentState {
  mode: EnvironmentMode;
  lightingPresetId: LightingPresetId;
  qualityId: SceneQualityId;
  stations: StationRecord[];
  activeStationId: UUID | null;
  cameraMode: CameraMode;
  bookmarks: CameraBookmark[];
  gridVisible: boolean;
  lightingTestRigVisible: boolean;
  reducedMotion: boolean;
  introPlayed: boolean;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function initialEnvironmentState(): EnvironmentState {
  const first = createStation('Station 1');
  return {
    mode: 'room',
    lightingPresetId: DEFAULT_LIGHTING_PRESET.room,
    qualityId: 'balanced',
    stations: [first],
    activeStationId: first.id,
    cameraMode: 'orbit',
    bookmarks: [],
    gridVisible: true,
    lightingTestRigVisible: false,
    reducedMotion: prefersReducedMotion(),
    introPlayed: false,
  };
}

export const useEnvironment = create<EnvironmentState>()(subscribeWithSelector(initialEnvironmentState));

/** Imperative access for code outside React (actions, persistence bridges, tests). */
export const environment = {
  get: useEnvironment.getState,
  set: useEnvironment.setState,
  subscribe: useEnvironment.subscribe,
};
