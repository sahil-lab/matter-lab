/**
 * The imperative camera/coordinate surface other agents integrate against. `CameraDirector.tsx`
 * installs the live implementation when it mounts; before that (or if it unmounts) every call is a
 * harmless no-op, so UI code, Agent 04's interaction layer and tests never need to check whether
 * the canvas exists yet. This mirrors `render/viewApi.ts`'s idle/install pattern.
 */
import type { CinematicWaypoint, FocusTarget } from './cameraModes';
import type { CameraMode, CameraPoseData, Vec3M } from './types';

export interface CameraDirectorApi {
  /**
   * The mode `CameraDirector` is currently rendering. Mode is a controlled prop, not something
   * this API sets directly (see `environmentActions.setCameraMode`, which is the integration
   * point): the owner that renders `<CameraDirector mode={...}>` is the single source of truth,
   * exactly as the molecular editor's `projection` lives in its own store rather than in `viewApi`.
   */
  getMode(): CameraMode;
  getPose(): CameraPoseData | null;
  /** Moves the camera to an explicit pose (e.g. a bookmark or a restored save). */
  goToPose(pose: CameraPoseData, animate?: boolean): void;
  /** Frames a single bounding sphere (an apparatus, a station). */
  focus(target: FocusTarget, animate?: boolean): void;
  /** Frames every given sphere at once (e.g. every station, for a "fit all" shot). */
  fitAll(targets: readonly FocusTarget[], animate?: boolean): void;
  /**
   * Claims or releases the camera's controls under a named reason. While any reason is held the
   * camera does not respond to pointer input; multiple holders are tracked independently; Agent 04
   * calls `pause('apparatus-drag')` on pointer-down over apparatus and `resume('apparatus-drag')`
   * on release.
   */
  pause(ownerId: string): void;
  resume(ownerId: string): void;
  isPaused(): boolean;
  /** Where a world-space (metre) point appears in the viewport, in CSS pixels; `null` if behind the camera. */
  project(point: Vec3M): [number, number] | null;
  /** Requests one more frame; needed because the canvas only renders on demand. */
  redraw(): void;
  /** Plays a scripted path (see `cameraModes.sampleCinematicPath`); resolves when it finishes or is skipped. */
  playIntro(waypoints: readonly CinematicWaypoint[]): Promise<void>;
  /** Jumps straight to the end of the running intro, if one is playing. */
  skipIntro(): void;
}

const idle: CameraDirectorApi = {
  getMode: () => 'orbit',
  getPose: () => null,
  goToPose: () => {},
  focus: () => {},
  fitAll: () => {},
  pause: () => {},
  resume: () => {},
  isPaused: () => false,
  project: () => null,
  redraw: () => {},
  playIntro: async () => {},
  skipIntro: () => {},
};

let current: CameraDirectorApi = idle;

export const cameraDirectorApi: CameraDirectorApi = {
  getMode: () => current.getMode(),
  getPose: () => current.getPose(),
  goToPose: (pose, animate) => current.goToPose(pose, animate),
  focus: (target, animate) => current.focus(target, animate),
  fitAll: (targets, animate) => current.fitAll(targets, animate),
  pause: (ownerId) => current.pause(ownerId),
  resume: (ownerId) => current.resume(ownerId),
  isPaused: () => current.isPaused(),
  project: (point) => current.project(point),
  redraw: () => current.redraw(),
  playIntro: (waypoints) => current.playIntro(waypoints),
  skipIntro: () => current.skipIntro(),
};

/** Installs the live implementation; returns a cleanup that restores the idle one (call from an effect's teardown). */
export function installCameraDirectorApi(impl: CameraDirectorApi): () => void {
  current = impl;
  return () => {
    if (current === impl) current = idle;
  };
}
