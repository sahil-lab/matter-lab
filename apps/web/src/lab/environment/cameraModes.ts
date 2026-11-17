/**
 * Pure camera-mode logic: per-mode constraints, focus/fit trigonometry, orthographic zoom
 * conversion, bookmark bookkeeping, damped easing and cinematic path sampling. Kept free of
 * Three.js and React so it can be unit-tested directly; `CameraDirector.tsx` is the thin component
 * that drives `camera-controls` with these numbers.
 */
import { clamp } from './coordinates';
import type { CameraBookmark, CameraMode, CameraPoseData, Projection, UUID, Vec3M } from './types';

export interface CameraModeConfig {
  readonly id: CameraMode;
  readonly label: string;
  readonly projection: Projection;
  /** Whether the user directly drives this mode (false for `cinematic`, which is scripted). */
  readonly userControllable: boolean;
  readonly minDistanceM: number;
  readonly maxDistanceM: number;
  /** Polar angle from the vertical (0 = looking straight down, PI = straight up, PI/2 = level). */
  readonly minPolarRad: number;
  readonly maxPolarRad: number;
  /** `camera-controls`-style exponential damping time constant, in seconds. */
  readonly smoothTime: number;
}

const HORIZON = Math.PI / 2;

export const CAMERA_MODE_CONFIG: Readonly<Record<CameraMode, CameraModeConfig>> = {
  orbit: {
    id: 'orbit',
    label: 'Orbit',
    projection: 'perspective',
    userControllable: true,
    minDistanceM: 0.35,
    maxDistanceM: 14,
    minPolarRad: 0.06,
    maxPolarRad: Math.PI - 0.06,
    smoothTime: 0.2,
  },
  inspect: {
    id: 'inspect',
    label: 'Inspect',
    projection: 'perspective',
    userControllable: true,
    minDistanceM: 0.08,
    maxDistanceM: 1.2,
    minPolarRad: 0.06,
    maxPolarRad: Math.PI - 0.06,
    smoothTime: 0.15,
  },
  'top-down': {
    id: 'top-down',
    label: 'Top-down',
    projection: 'orthographic',
    userControllable: true,
    minDistanceM: 1,
    maxDistanceM: 40,
    minPolarRad: 0.0001,
    maxPolarRad: 0.0001,
    smoothTime: 0.25,
  },
  'first-person': {
    id: 'first-person',
    label: 'First-person',
    projection: 'perspective',
    userControllable: true,
    minDistanceM: 0,
    maxDistanceM: 0,
    minPolarRad: HORIZON - 1.4,
    maxPolarRad: HORIZON + 1.2,
    smoothTime: 0.12,
  },
  cinematic: {
    id: 'cinematic',
    label: 'Cinematic',
    projection: 'perspective',
    userControllable: false,
    minDistanceM: 0.3,
    maxDistanceM: 40,
    minPolarRad: 0.02,
    maxPolarRad: Math.PI - 0.02,
    smoothTime: 0.6,
  },
};

export const FIRST_PERSON_CONFIG = {
  eyeHeightM: 1.62,
  moveSpeedMps: 1.6,
  /** Radians of look rotation per CSS pixel of pointer movement. */
  lookSensitivityRadPerPx: 0.0035,
} as const;

export function clampDistance(mode: CameraMode, distanceM: number): number {
  const cfg = CAMERA_MODE_CONFIG[mode];
  return clamp(distanceM, cfg.minDistanceM, cfg.maxDistanceM);
}

export function clampPolar(mode: CameraMode, polarRad: number): number {
  const cfg = CAMERA_MODE_CONFIG[mode];
  return clamp(polarRad, cfg.minPolarRad, cfg.maxPolarRad);
}

/** Distance a perspective camera must stand from a sphere's centre to frame it within the vertical field of view. */
export function fitDistanceForSphere(radiusM: number, verticalFovRad: number, padding = 1.15): number {
  const r = Math.max(1e-6, radiusM) * padding;
  return r / Math.sin(clamp(verticalFovRad, 1e-3, Math.PI - 1e-3) / 2);
}

/**
 * The three.js-style orthographic `zoom` factor that makes `desiredVisibleHeightM` of world space
 * fill the camera's vertical frustum, given the frustum's height at zoom = 1.
 */
export function orthoZoomForHeight(desiredVisibleHeightM: number, baseFrustumHeightM: number): number {
  return baseFrustumHeightM / Math.max(1e-6, desiredVisibleHeightM);
}

export interface FocusTarget {
  readonly center: Vec3M;
  readonly radiusM: number;
}

/** The smallest sphere (by simple, not Welzl-optimal, construction) that contains every target sphere, for a "fit all" shot. */
export function encompassingSphere(targets: readonly FocusTarget[]): FocusTarget {
  if (targets.length === 0) return { center: [0, 0, 0], radiusM: 1 };
  if (targets.length === 1) return targets[0]!;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const t of targets) {
    cx += t.center[0];
    cy += t.center[1];
    cz += t.center[2];
  }
  const center: Vec3M = [cx / targets.length, cy / targets.length, cz / targets.length];
  let radius = 0;
  for (const t of targets) {
    const d = Math.hypot(t.center[0] - center[0], t.center[1] - center[1], t.center[2] - center[2]) + t.radiusM;
    radius = Math.max(radius, d);
  }
  return { center, radiusM: radius };
}

/** The inverse of {@link orthoZoomForHeight}: the world height currently visible at a given zoom. */
export function visibleHeightForZoom(zoom: number, baseFrustumHeightM: number): number {
  return baseFrustumHeightM / Math.max(1e-6, zoom);
}

/** Whether an animated transition should actually animate, honouring the user's reduced-motion preference. */
export function effectiveAnimate(requested: boolean, reducedMotion: boolean): boolean {
  return requested && !reducedMotion;
}

/**
 * Exponentially damps `current` towards `target`. Compounds exactly under repeated calls
 * (`damp(damp(x, t, L, dt1), t, L, dt2) === damp(x, t, L, dt1+dt2)`), so it gives the same answer
 * whatever the frame rate.
 */
export function dampTowards(current: number, target: number, lambda: number, dtSeconds: number): number {
  if (lambda <= 0) return current;
  return target + (current - target) * Math.exp(-lambda * dtSeconds);
}

export function dampTowardsVec3(current: Vec3M, target: Vec3M, lambda: number, dtSeconds: number): Vec3M {
  return [
    dampTowards(current[0], target[0], lambda, dtSeconds),
    dampTowards(current[1], target[1], lambda, dtSeconds),
    dampTowards(current[2], target[2], lambda, dtSeconds),
  ];
}

// ---------- Bookmarks ----------

export function createBookmark(name: string, mode: CameraMode, pose: CameraPoseData, id: UUID): CameraBookmark {
  return { id, name, mode, ...pose };
}

export function addBookmark(bookmarks: readonly CameraBookmark[], bookmark: CameraBookmark): CameraBookmark[] {
  return [...bookmarks.filter((b) => b.id !== bookmark.id), bookmark];
}

export function removeBookmark(bookmarks: readonly CameraBookmark[], id: UUID): CameraBookmark[] {
  return bookmarks.filter((b) => b.id !== id);
}

export function renameBookmark(bookmarks: readonly CameraBookmark[], id: UUID, name: string): CameraBookmark[] {
  return bookmarks.map((b) => (b.id === id ? { ...b, name } : b));
}

export function findBookmark(bookmarks: readonly CameraBookmark[], id: UUID): CameraBookmark | undefined {
  return bookmarks.find((b) => b.id === id);
}

// ---------- Cinematic path ----------

export interface CinematicWaypoint {
  readonly pose: CameraPoseData;
  /** Seconds to travel from the previous waypoint to this one (ignored for the first waypoint). */
  readonly travelSeconds: number;
}

export interface CinematicSample {
  readonly pose: CameraPoseData;
  readonly finished: boolean;
}

function smoothstep(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpVec3(a: Vec3M, b: Vec3M, t: number): Vec3M {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/**
 * The camera pose at `elapsedSeconds` into a scripted path through `waypoints` (the first waypoint
 * is the starting pose, at t=0). Clamps to the final pose once the path has finished, so a caller
 * can poll this every frame without tracking completion separately.
 */
export function sampleCinematicPath(waypoints: readonly CinematicWaypoint[], elapsedSeconds: number): CinematicSample {
  if (waypoints.length === 0) return { pose: { position: [0, 1.6, 4], target: [0, 1, 0], zoom: 1, projection: 'perspective' }, finished: true };
  if (waypoints.length === 1) return { pose: waypoints[0]!.pose, finished: true };

  let t = Math.max(0, elapsedSeconds);
  for (let i = 1; i < waypoints.length; i++) {
    const segment = Math.max(1e-6, waypoints[i]!.travelSeconds);
    if (t <= segment || i === waypoints.length - 1) {
      const from = waypoints[i - 1]!.pose;
      const to = waypoints[i]!.pose;
      const u = smoothstep(Math.min(1, t / segment));
      const finished = i === waypoints.length - 1 && t >= segment;
      return {
        pose: {
          position: lerpVec3(from.position, to.position, u),
          target: lerpVec3(from.target, to.target, u),
          zoom: lerp(from.zoom, to.zoom, u),
          projection: u < 1 ? from.projection : to.projection,
        },
        finished,
      };
    }
    t -= segment;
  }
  // Unreachable: the loop above always returns by the last waypoint.
  return { pose: waypoints[waypoints.length - 1]!.pose, finished: true };
}

/** Total duration of a cinematic path, in seconds. */
export function cinematicDuration(waypoints: readonly CinematicWaypoint[]): number {
  return waypoints.slice(1).reduce((sum, w) => sum + w.travelSeconds, 0);
}
