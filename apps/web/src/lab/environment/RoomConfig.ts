/**
 * Room/workbench presets, lighting presets and environment serialization.
 *
 * `EnvironmentSettings` is the *only* thing this module persists: presentation (room vs. studio,
 * lighting mood, render quality, camera framing, grid visibility). Per the shared contract, scene
 * truth (apparatus, connections, container contents) is Agent 07/09's domain and must never be
 * written through here; `viewport` on `ExperimentScene` is the designated, opaque-to-them slot for
 * exactly this payload (`serializeEnvironment` / `deserializeEnvironment`).
 */
import type { PlanBounds } from './stations';
import type { CameraBookmark, CameraMode, CameraPoseData, EnvironmentMode, LightingPresetId, Projection, SceneQualityId, UUID, Vec3M } from './types';

export interface RoomDimensions {
  readonly widthM: number;
  readonly depthM: number;
  readonly heightM: number;
}

/** Walking space kept clear around the outermost station footprints, in metres. */
const ROOM_MARGIN_M = 2.4;
const ROOM_HEIGHT_M = 3.2;
const ROOM_MIN_SIZE_M = 5;

/** A room sized to comfortably contain the given station layout, with room to walk around it. */
export function roomDimensionsFor(bounds: PlanBounds): RoomDimensions {
  const width = Math.max(ROOM_MIN_SIZE_M, bounds.maxX - bounds.minX + ROOM_MARGIN_M * 2);
  const depth = Math.max(ROOM_MIN_SIZE_M, bounds.maxZ - bounds.minZ + ROOM_MARGIN_M * 2);
  return { widthM: width, depthM: depth, heightM: ROOM_HEIGHT_M };
}

export interface LightingPreset {
  readonly id: LightingPresetId;
  readonly label: string;
  readonly description: string;
  /** CSS hex colours; kept as simple tokens rather than textures so no licensed image asset is required. */
  readonly keyColor: string;
  readonly keyIntensity: number;
  readonly ambientColor: string;
  readonly ambientIntensity: number;
  readonly rimColor: string;
  readonly rimIntensity: number;
  readonly backgroundColor: string;
  readonly floorColor: string;
  readonly wallColor: string;
  /** Scene fog density per metre; 0 disables fog (used in studio mode, which has no walls to fade into). */
  readonly fogDensity: number;
  /**
   * Bloom only catches values brighter than this (linear light, 1 = white). Kept close to 1 in the
   * dim preset so glass highlights read as bright, not glowing (brief: "readable ... without
   * unrealistic levels of glow").
   */
  readonly bloomThreshold: number;
}

export const LIGHTING_PRESETS: Readonly<Record<LightingPresetId, LightingPreset>> = {
  'daylight-lab': {
    id: 'daylight-lab',
    label: 'Daylight lab',
    description: 'Bright, neutral overhead light, as in a teaching laboratory.',
    keyColor: '#eef4ff',
    keyIntensity: 3.2,
    ambientColor: '#cfe0ff',
    ambientIntensity: 0.55,
    rimColor: '#ffe9c7',
    rimIntensity: 0.6,
    backgroundColor: '#aab9cc',
    floorColor: '#9aa3ad',
    wallColor: '#e7ebf0',
    fogDensity: 0.012,
    bloomThreshold: 0.92,
  },
  'night-lab': {
    id: 'night-lab',
    label: 'Night lab',
    description: 'Dim ambient with warm practical lights, for a moody, dramatic read.',
    keyColor: '#ffd9a0',
    keyIntensity: 1.5,
    ambientColor: '#28344a',
    ambientIntensity: 0.16,
    rimColor: '#5ad8ff',
    rimIntensity: 0.9,
    backgroundColor: '#05070c',
    floorColor: '#0d1017',
    wallColor: '#12151d',
    fogDensity: 0.05,
    bloomThreshold: 0.98,
  },
  'studio-neutral': {
    id: 'studio-neutral',
    label: 'Studio neutral',
    description: 'A clean, grey product-photography sweep for the infinite workbench.',
    keyColor: '#ffffff',
    keyIntensity: 2.6,
    ambientColor: '#dfe6ee',
    ambientIntensity: 0.5,
    rimColor: '#bcd4ff',
    rimIntensity: 0.5,
    backgroundColor: '#71777f',
    floorColor: '#82868c',
    wallColor: '#9398a0',
    fogDensity: 0,
    bloomThreshold: 0.95,
  },
};

export const DEFAULT_LIGHTING_PRESET: Readonly<Record<EnvironmentMode, LightingPresetId>> = {
  room: 'daylight-lab',
  studio: 'studio-neutral',
};

// ---------- Environment serialization ----------

export interface CameraSettings {
  readonly mode: CameraMode;
  /** The last user-facing pose, so reopening a scene restores the same framing; `null` before any camera has run. */
  readonly pose: CameraPoseData | null;
  readonly bookmarks: readonly CameraBookmark[];
}

export interface EnvironmentSettings {
  readonly schemaVersion: 1;
  readonly mode: EnvironmentMode;
  readonly lightingPresetId: LightingPresetId;
  readonly qualityId: SceneQualityId;
  readonly activeStationId: UUID | null;
  readonly camera: CameraSettings;
  readonly gridVisible: boolean;
  /** Whether the skippable first-run cinematic traversal has already played this scene. */
  readonly introPlayed: boolean;
}

export const DEFAULT_ENVIRONMENT_SETTINGS: EnvironmentSettings = {
  schemaVersion: 1,
  mode: 'room',
  lightingPresetId: 'daylight-lab',
  qualityId: 'balanced',
  activeStationId: null,
  camera: { mode: 'orbit', pose: null, bookmarks: [] },
  gridVisible: true,
  introPlayed: false,
};

function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function isVec3M(x: unknown): x is Vec3M {
  return Array.isArray(x) && x.length === 3 && x.every(isFiniteNumber);
}

function isProjection(x: unknown): x is Projection {
  return x === 'perspective' || x === 'orthographic';
}

function isEnvironmentMode(x: unknown): x is EnvironmentMode {
  return x === 'room' || x === 'studio';
}

function isCameraMode(x: unknown): x is CameraMode {
  return x === 'orbit' || x === 'first-person' || x === 'top-down' || x === 'inspect' || x === 'cinematic';
}

function isLightingPresetId(x: unknown): x is LightingPresetId {
  return typeof x === 'string' && Object.prototype.hasOwnProperty.call(LIGHTING_PRESETS, x);
}

function isSceneQualityId(x: unknown): x is SceneQualityId {
  return x === 'efficient' || x === 'balanced' || x === 'quality';
}

function isCameraPoseData(x: unknown): x is CameraPoseData {
  if (!x || typeof x !== 'object') return false;
  const p = x as Record<string, unknown>;
  return isVec3M(p.position) && isVec3M(p.target) && isFiniteNumber(p.zoom) && isProjection(p.projection);
}

function isCameraBookmark(x: unknown): x is CameraBookmark {
  if (!x || typeof x !== 'object') return false;
  const b = x as Record<string, unknown>;
  return typeof b.id === 'string' && typeof b.name === 'string' && isCameraMode(b.mode) && isCameraPoseData(b);
}

/**
 * The environment-only slice of a scene, as a plain JSON value suitable for
 * `ExperimentScene.viewport`. Deliberately excludes apparatus, connections and container state.
 */
export function serializeEnvironment(settings: EnvironmentSettings): Record<string, unknown> {
  return JSON.parse(JSON.stringify(settings)) as Record<string, unknown>;
}

/**
 * Recovers `EnvironmentSettings` from a scene's `viewport` field. Never throws: any field that is
 * missing, the wrong type, or otherwise unrecognised falls back to its default individually, so a
 * scene saved by an older or foreign client still opens.
 */
export function deserializeEnvironment(viewport: unknown): EnvironmentSettings {
  if (!viewport || typeof viewport !== 'object') return DEFAULT_ENVIRONMENT_SETTINGS;
  const v = viewport as Record<string, unknown>;

  const cameraRaw = v.camera && typeof v.camera === 'object' ? (v.camera as Record<string, unknown>) : {};
  const bookmarksRaw = Array.isArray(cameraRaw.bookmarks) ? cameraRaw.bookmarks : [];

  return {
    schemaVersion: 1,
    mode: isEnvironmentMode(v.mode) ? v.mode : DEFAULT_ENVIRONMENT_SETTINGS.mode,
    lightingPresetId: isLightingPresetId(v.lightingPresetId) ? v.lightingPresetId : DEFAULT_ENVIRONMENT_SETTINGS.lightingPresetId,
    qualityId: isSceneQualityId(v.qualityId) ? v.qualityId : DEFAULT_ENVIRONMENT_SETTINGS.qualityId,
    activeStationId: typeof v.activeStationId === 'string' ? v.activeStationId : null,
    camera: {
      mode: isCameraMode(cameraRaw.mode) ? cameraRaw.mode : DEFAULT_ENVIRONMENT_SETTINGS.camera.mode,
      pose: isCameraPoseData(cameraRaw.pose) ? cameraRaw.pose : null,
      bookmarks: bookmarksRaw.filter(isCameraBookmark),
    },
    gridVisible: typeof v.gridVisible === 'boolean' ? v.gridVisible : DEFAULT_ENVIRONMENT_SETTINGS.gridVisible,
    introPlayed: typeof v.introPlayed === 'boolean' ? v.introPlayed : DEFAULT_ENVIRONMENT_SETTINGS.introPlayed,
  };
}
