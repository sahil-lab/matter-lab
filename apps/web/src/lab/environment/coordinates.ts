/**
 * World-coordinate and placement primitives. Metres are the canonical unit (see
 * `00_SHARED_INTEGRATION_CONTRACT.md` section 3); Y is up, matching Three.js's default convention.
 *
 * Kept dependency-free (no Three.js) so it can be unit-tested in plain Node and reused by any
 * future non-React consumer (e.g. a worker). Quaternion math is re-derived rather than imported
 * because this module intentionally has no runtime dependency on `three`.
 */
import type { QuatTuple, Vec3M, WorldTransform } from './types';
import { IDENTITY_QUATERNION } from './types';

export const IDENTITY_TRANSFORM: WorldTransform = { positionM: [0, 0, 0], quaternion: IDENTITY_QUATERNION };

/**
 * Calibrated reference heights (metres) for a standard titration assembly. These are a
 * placeholder scale for Agent 02's own camera/lighting validation, not an apparatus definition:
 * Agent 03 owns authoritative apparatus dimensions and may supersede these.
 */
export const REFERENCE_HEIGHTS_M = {
  /** Floor to the top surface of the workbench. */
  benchTop: 0.9,
  benchTopThickness: 0.04,
  /** Stand base plate thickness, resting on the bench top. */
  standBase: 0.012,
  /** Vertical stand rod rising from the bench top. */
  standRod: 0.6,
  /** Default clamp height along the rod, measured from the bench top. */
  clampHeight: 0.42,
  /** Burette (meter-scale glass tube) length. */
  buretteLength: 0.5,
  /** Conical flask body height from its base to the start of its neck. */
  flaskHeight: 0.13,
} as const;

/** Side length, in metres, of one placement grid cell on a workbench. */
export const GRID_CELL_M = 0.05;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Rounds `value` to the nearest multiple of `cellSizeM` (defaults to the standard placement grid). */
export function snapToGrid(value: number, cellSizeM: number = GRID_CELL_M): number {
  if (cellSizeM <= 0) return value;
  return Math.round(value / cellSizeM) * cellSizeM;
}

/** Snaps the X/Z plan-position of a point to the grid while leaving its height untouched. */
export function snapPointToGrid(point: Vec3M, cellSizeM: number = GRID_CELL_M): Vec3M {
  return [snapToGrid(point[0], cellSizeM), point[1], snapToGrid(point[2], cellSizeM)];
}

/** A quaternion for a rotation of `radians` about the vertical (Y) axis; the usual way to "face" a station. */
export function yawQuaternion(radians: number): QuatTuple {
  const half = radians / 2;
  return [0, Math.sin(half), 0, Math.cos(half)];
}

/** The yaw angle (radians) a quaternion produced by {@link yawQuaternion} represents. */
export function yawOf(q: QuatTuple): number {
  return 2 * Math.atan2(q[1], q[3]);
}

/** Rotates a vector by a unit quaternion (standard `v + 2w(q_xyz x v) + 2(q_xyz x (q_xyz x v))` form). */
export function rotateVector(v: Vec3M, q: QuatTuple): Vec3M {
  const [qx, qy, qz, qw] = q;
  const [vx, vy, vz] = v;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  // v' = v + w*t + cross(q.xyz, t)
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ];
}

/** The inverse rotation of a unit quaternion (its conjugate). */
export function conjugate(q: QuatTuple): QuatTuple {
  return [-q[0], -q[1], -q[2], q[3]];
}

/** Multiplies two rotations: applying the result is the same as applying `b` then `a`. */
export function multiplyQuaternions(a: QuatTuple, b: QuatTuple): QuatTuple {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** Composes a transform local to `parent` into world space (parent * local). */
export function composeTransforms(parent: WorldTransform, local: WorldTransform): WorldTransform {
  const rotatedOffset = rotateVector(local.positionM, parent.quaternion);
  return {
    positionM: [
      parent.positionM[0] + rotatedOffset[0],
      parent.positionM[1] + rotatedOffset[1],
      parent.positionM[2] + rotatedOffset[2],
    ],
    quaternion: multiplyQuaternions(parent.quaternion, local.quaternion),
  };
}

/** The inverse of {@link composeTransforms}: expresses `world` in `parent`'s local space. */
export function worldToLocal(parent: WorldTransform, world: WorldTransform): WorldTransform {
  const inv = conjugate(parent.quaternion);
  const offset: Vec3M = [
    world.positionM[0] - parent.positionM[0],
    world.positionM[1] - parent.positionM[1],
    world.positionM[2] - parent.positionM[2],
  ];
  return { positionM: rotateVector(offset, inv), quaternion: multiplyQuaternions(inv, world.quaternion) };
}

/** Converts a point given in a station's local frame to world space. */
export function stationToWorld(stationOrigin: WorldTransform, localPoint: Vec3M): Vec3M {
  const rotated = rotateVector(localPoint, stationOrigin.quaternion);
  return [
    stationOrigin.positionM[0] + rotated[0],
    stationOrigin.positionM[1] + rotated[1],
    stationOrigin.positionM[2] + rotated[2],
  ];
}

/** Converts a world-space point into a station's local frame (the inverse of {@link stationToWorld}). */
export function worldToStation(stationOrigin: WorldTransform, worldPoint: Vec3M): Vec3M {
  const offset: Vec3M = [
    worldPoint[0] - stationOrigin.positionM[0],
    worldPoint[1] - stationOrigin.positionM[1],
    worldPoint[2] - stationOrigin.positionM[2],
  ];
  return rotateVector(offset, conjugate(stationOrigin.quaternion));
}

export function distance(a: Vec3M, b: Vec3M): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
