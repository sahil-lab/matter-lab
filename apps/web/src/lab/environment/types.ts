/**
 * Shared types for the 3D laboratory environment (Agent 02's owned surface).
 *
 * These mirror the shapes defined in `00_SHARED_INTEGRATION_CONTRACT.md` section 3 so that
 * `WorldTransform` and `StationRecord` values can be handed directly to/from the eventual
 * `packages/contracts` module and to Agents 03/04/07/09 without translation. Nothing here is
 * simulation truth: apparatus identity, connections and chemical state belong to Agent 03/07 and
 * must not be serialized through this module (see `RoomConfig.ts`).
 */

export type UUID = string;

/** A position or offset in metres, the environment's canonical spatial unit. Y is up. */
export type Vec3M = readonly [number, number, number];

/** A unit quaternion `[x, y, z, w]`, matching the shared contract's `Transform.quaternion`. */
export type QuatTuple = readonly [number, number, number, number];

export const IDENTITY_QUATERNION: QuatTuple = [0, 0, 0, 1];

/** Structurally identical to the shared contract's `Transform`. Positions are in metres. */
export interface WorldTransform {
  readonly positionM: Vec3M;
  readonly quaternion: QuatTuple;
}

/** Structurally identical to the shared contract's `ExperimentScene.stations[i]`. */
export interface StationRecord {
  readonly id: UUID;
  readonly name: string;
}

/** The two environment presentations required by the brief; both host the same station contents. */
export type EnvironmentMode = 'room' | 'studio';

/** Camera behaviours required by the brief. `inspect` is a tightly constrained, close-range orbit. */
export type CameraMode = 'orbit' | 'first-person' | 'top-down' | 'inspect' | 'cinematic';

export type Projection = 'perspective' | 'orthographic';

export interface CameraPoseData {
  readonly position: Vec3M;
  readonly target: Vec3M;
  /** Orthographic zoom (viewport-heights per metre); ignored in perspective. */
  readonly zoom: number;
  readonly projection: Projection;
}

export interface CameraBookmark extends CameraPoseData {
  readonly id: UUID;
  readonly name: string;
  readonly mode: CameraMode;
}

export type LightingPresetId = 'daylight-lab' | 'night-lab' | 'studio-neutral';

export type SceneQualityId = 'efficient' | 'balanced' | 'quality';

/** Who currently owns pointer input on the canvas. Agent 04 claims `interaction` while dragging apparatus. */
export type PointerOwner = 'camera' | 'interaction';

export function createId(prefix: string): UUID {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
