/**
 * The single entry point other code uses to change environment state or command the camera
 * through it. Agent 04/07/09/10 should call these functions rather than writing to
 * `useEnvironment`'s setState directly, so station bookkeeping, bookmarks and the live camera
 * pose always stay consistent with each other.
 */
import { addBookmark, createBookmark, removeBookmark, renameBookmark } from './cameraModes';
import { cameraDirectorApi } from './cameraDirectorApi';
import { environment } from './environmentStore';
import { DEFAULT_ENVIRONMENT_SETTINGS } from './RoomConfig';
import type { EnvironmentSettings } from './RoomConfig';
import { createStation, findSlot, layoutStations } from './stations';
import { REFERENCE_HEIGHTS_M } from './coordinates';
import { createId } from './types';
import type { CameraMode, EnvironmentMode, LightingPresetId, SceneQualityId, StationRecord, UUID, Vec3M } from './types';

export function setEnvironmentMode(mode: EnvironmentMode): void {
  environment.set({ mode });
}

export function setLightingPreset(id: LightingPresetId): void {
  environment.set({ lightingPresetId: id });
}

export function setQuality(id: SceneQualityId): void {
  environment.set({ qualityId: id });
}

export function setCameraMode(mode: CameraMode): void {
  environment.set({ cameraMode: mode });
}

export function setGridVisible(visible: boolean): void {
  environment.set({ gridVisible: visible });
}

export function setLightingTestRigVisible(visible: boolean): void {
  environment.set({ lightingTestRigVisible: visible });
}

export function setReducedMotion(value: boolean): void {
  environment.set({ reducedMotion: value });
}

export function addStation(name?: string): StationRecord {
  const station = createStation(name ?? `Station ${environment.get().stations.length + 1}`);
  environment.set((s) => ({ stations: [...s.stations, station], activeStationId: s.activeStationId ?? station.id }));
  return station;
}

export function removeStation(id: UUID): void {
  environment.set((s) => {
    const stations = s.stations.filter((st) => st.id !== id);
    return { stations, activeStationId: s.activeStationId === id ? (stations[0]?.id ?? null) : s.activeStationId };
  });
}

export function setActiveStation(id: UUID | null): void {
  environment.set({ activeStationId: id });
}

function stationFocusTarget(positionM: Vec3M, footprintWidthM: number, footprintDepthM: number): { center: Vec3M; radiusM: number } {
  return {
    center: [positionM[0], REFERENCE_HEIGHTS_M.benchTop, positionM[2]],
    radiusM: Math.max(footprintWidthM, footprintDepthM) * 0.75,
  };
}

/** Frames the active station (or the first one, if none is marked active). */
export function focusActiveStation(animate = true): void {
  const s = environment.get();
  const slots = layoutStations(s.stations, s.mode);
  const slot = (s.activeStationId && findSlot(slots, s.activeStationId)) || slots[0];
  if (!slot) return;
  cameraDirectorApi.focus(stationFocusTarget(slot.origin.positionM, slot.footprintM.widthM, slot.footprintM.depthM), animate);
}

/** Frames every station at once. */
export function fitAllStations(animate = true): void {
  const s = environment.get();
  const slots = layoutStations(s.stations, s.mode);
  cameraDirectorApi.fitAll(
    slots.map((slot) => stationFocusTarget(slot.origin.positionM, slot.footprintM.widthM, slot.footprintM.depthM)),
    animate,
  );
}

export function saveBookmarkHere(name: string): void {
  const pose = cameraDirectorApi.getPose();
  if (!pose) return;
  const bookmark = createBookmark(name, environment.get().cameraMode, pose, createId('bookmark'));
  environment.set((s) => ({ bookmarks: addBookmark(s.bookmarks, bookmark) }));
}

export function goToBookmark(id: UUID): void {
  const bookmark = environment.get().bookmarks.find((b) => b.id === id);
  if (!bookmark) return;
  environment.set({ cameraMode: bookmark.mode });
  cameraDirectorApi.goToPose(bookmark, true);
}

export function deleteBookmark(id: UUID): void {
  environment.set((s) => ({ bookmarks: removeBookmark(s.bookmarks, id) }));
}

export function renameBookmarkTo(id: UUID, name: string): void {
  environment.set((s) => ({ bookmarks: renameBookmark(s.bookmarks, id, name) }));
}

export function markIntroPlayed(): void {
  environment.set({ introPlayed: true });
}

/**
 * Restores presentation state from a saved scene's `viewport` (already parsed by
 * `RoomConfig.deserializeEnvironment`). Does not touch apparatus or simulation state.
 */
export function loadEnvironmentSettings(settings: EnvironmentSettings): void {
  environment.set((s) => ({
    mode: settings.mode,
    lightingPresetId: settings.lightingPresetId,
    qualityId: settings.qualityId,
    activeStationId: settings.activeStationId ?? s.activeStationId,
    cameraMode: settings.camera.mode,
    bookmarks: [...settings.camera.bookmarks],
    gridVisible: settings.gridVisible,
    introPlayed: settings.introPlayed,
  }));
  if (settings.camera.pose) cameraDirectorApi.goToPose(settings.camera.pose, false);
}

/** The environment-only slice to persist (pass to `RoomConfig.serializeEnvironment` and store in `scene.viewport`). */
export function currentEnvironmentSettings(): EnvironmentSettings {
  const s = environment.get();
  return {
    schemaVersion: 1,
    mode: s.mode,
    lightingPresetId: s.lightingPresetId,
    qualityId: s.qualityId,
    activeStationId: s.activeStationId,
    camera: { mode: s.cameraMode, pose: cameraDirectorApi.getPose() ?? DEFAULT_ENVIRONMENT_SETTINGS.camera.pose, bookmarks: s.bookmarks },
    gridVisible: s.gridVisible,
    introPlayed: s.introPlayed,
  };
}
