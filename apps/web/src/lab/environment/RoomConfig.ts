import { assertPointM, transformMatrix } from './coordinates';
import { copyCameraView, DEFAULT_CAMERA_VIEW, validateCameraView } from './cameraMath';
import type {
  CameraBookmark, LabBoundsM, LabCameraView, LabTransform, LabWorldMode,
  LightingPreset, RoomPreset, SceneQualityPreset,
} from './types';

export interface RoomConfiguration {
  readonly widthM: number;
  readonly depthM: number;
  readonly heightM: number;
  readonly navigationBoundsM: LabBoundsM;
}
function room(widthM: number, depthM: number, heightM: number): RoomConfiguration {
  return {
    widthM, depthM, heightM,
    navigationBoundsM: { minM: [-widthM / 2 + 0.25, 0.15, -depthM / 2 + 0.25], maxM: [widthM / 2 - 0.25, heightM - 0.25, depthM / 2 - 0.25] },
  };
}
export const ROOM_PRESETS: Readonly<Record<RoomPreset, RoomConfiguration>> = Object.freeze({
  compact: room(6, 5, 3.2),
  teaching: room(9, 7, 3.6),
  gallery: room(12, 9, 4.2),
});
export const STUDIO_NAVIGATION_BOUNDS: LabBoundsM = { minM: [-20, 0.15, -20], maxM: [20, 12, 20] };

/** Layout suggestions only: never create station or apparatus instances. */
export function stationLayoutAnchors(count: number): readonly LabTransform[] {
  if (!Number.isInteger(count) || count < 0 || count > 8) throw new RangeError('Layout presets support zero to eight anchors.');
  const columns = Math.min(count, 2);
  const rows = Math.ceil(count / Math.max(columns, 1));
  return Array.from({ length: count }, (_, index) => ({
    positionM: [(index % columns - (columns - 1) / 2) * 3.1, 0, (Math.floor(index / columns) - (rows - 1) / 2) * 2.4],
    quaternion: [0, 0, 0, 1],
  }));
}

export interface EnvironmentSnapshot {
  readonly schemaVersion: 1;
  readonly units: 'm';
  readonly mode: LabWorldMode;
  readonly roomPreset: RoomPreset;
  readonly lightingPreset: LightingPreset;
  readonly quality: SceneQualityPreset;
  readonly showGrid: boolean;
  readonly isolateStation: boolean;
  readonly activeStationId?: string;
  readonly view: LabCameraView;
  readonly bookmarks: readonly CameraBookmark[];
  /** A view/layout snapshot, not permission to spawn or move authoritative apparatus. */
  readonly benchLayout: readonly { instanceId: string; stationId: string; transform: LabTransform }[];
}

export function defaultEnvironmentSnapshot(): EnvironmentSnapshot {
  return {
    schemaVersion: 1, units: 'm', mode: 'room', roomPreset: 'teaching',
    lightingPreset: 'daylight', quality: 'balanced', showGrid: false, isolateStation: false,
    view: copyCameraView(DEFAULT_CAMERA_VIEW), bookmarks: [], benchLayout: [],
  };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected environment object.');
  return value as Record<string, unknown>;
}
function string(value: unknown, max = 128): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new TypeError('Invalid environment identifier or label.');
  return value;
}
function enumeration<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new TypeError('Unknown environment option.');
  return value as T;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new TypeError('Expected environment boolean.');
  return value;
}
function view(value: unknown): LabCameraView {
  const source = object(value);
  if (!Array.isArray(source.positionM) || !Array.isArray(source.targetM) ||
      typeof source.fovDeg !== 'number' || typeof source.orthographicHeightM !== 'number') {
    throw new TypeError('Invalid camera view.');
  }
  assertPointM(source.positionM);
  assertPointM(source.targetM);
  const result: LabCameraView = {
    mode: enumeration(source.mode, ['orbit', 'first-person', 'top-down', 'inspection']),
    positionM: [source.positionM[0], source.positionM[1], source.positionM[2]],
    targetM: [source.targetM[0], source.targetM[1], source.targetM[2]],
    fovDeg: source.fovDeg, orthographicHeightM: source.orthographicHeightM,
  };
  validateCameraView(result);
  return result;
}
function transform(value: unknown): LabTransform {
  const source = object(value);
  if (!Array.isArray(source.positionM) || !Array.isArray(source.quaternion) ||
      source.quaternion.length !== 4 || !source.quaternion.every((n) => typeof n === 'number')) {
    throw new TypeError('Invalid bench transform.');
  }
  assertPointM(source.positionM);
  const result: LabTransform = {
    positionM: [source.positionM[0], source.positionM[1], source.positionM[2]],
    quaternion: [source.quaternion[0], source.quaternion[1], source.quaternion[2], source.quaternion[3]],
  };
  transformMatrix(result);
  return result;
}

/** Whitelists render settings; unknown fields (including chemistry) are never retained. */
export function parseEnvironmentSnapshot(value: unknown): EnvironmentSnapshot {
  const source = object(value);
  if (source.schemaVersion !== 1 || source.units !== 'm') throw new TypeError('Unsupported environment version or non-meter coordinates.');
  if (!Array.isArray(source.bookmarks) || source.bookmarks.length > 32 ||
      !Array.isArray(source.benchLayout) || source.benchLayout.length > 32) throw new RangeError('Invalid bounded environment layout.');
  const bookmarks = source.bookmarks.map((entry): CameraBookmark => {
    const bookmark = object(entry);
    return {
      id: string(bookmark.id), name: string(bookmark.name, 64), view: view(bookmark.view),
      ...(bookmark.stationId === undefined ? {} : { stationId: string(bookmark.stationId) }),
    };
  });
  const benchLayout = source.benchLayout.map((entry) => {
    const bench = object(entry);
    return { instanceId: string(bench.instanceId), stationId: string(bench.stationId), transform: transform(bench.transform) };
  });
  if (new Set(bookmarks.map((bookmark) => bookmark.id)).size !== bookmarks.length ||
      new Set(benchLayout.map((bench) => bench.instanceId)).size !== benchLayout.length) {
    throw new TypeError('Duplicate environment layout IDs.');
  }
  return {
    schemaVersion: 1, units: 'm',
    mode: enumeration(source.mode, ['room', 'studio']),
    roomPreset: enumeration(source.roomPreset, ['compact', 'teaching', 'gallery']),
    lightingPreset: enumeration(source.lightingPreset, ['daylight', 'evening', 'neutral']),
    quality: enumeration(source.quality, ['low', 'balanced', 'high']),
    showGrid: boolean(source.showGrid), isolateStation: boolean(source.isolateStation),
    ...(source.activeStationId === undefined ? {} : { activeStationId: string(source.activeStationId) }),
    view: view(source.view), bookmarks, benchLayout,
  };
}

export function serializeEnvironmentSnapshot(snapshot: EnvironmentSnapshot): string {
  return JSON.stringify(parseEnvironmentSnapshot(snapshot));
}
