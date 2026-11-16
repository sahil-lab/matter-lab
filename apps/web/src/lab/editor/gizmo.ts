/**
 * Pure transform math for the move/rotate gizmo (brief item 2) and its keyboard-typed-value
 * alternative (brief item 6: "accessible keyboard alternatives"), independent of any particular
 * gizmo widget — `components/TransformGizmo.tsx` wraps drei's `TransformControls` for the actual
 * on-screen handles and calls into here to turn "the proxy moved from A to B" into "every selected
 * instance's new transform", including the multi-select case (a rigid transform about one pivot),
 * which a single `TransformControls` proxy does not know how to do by itself.
 */
import type { Transform, UUID } from './contracts';
import { addVec3, conjugateQuat, multiplyQuat, rotateVec3, subVec3 } from './footprint';
import type { Axis, Quat, Vec3 } from './types';

const AXIS_VECTOR: Readonly<Record<Axis, Vec3>> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/** A unit quaternion rotating by `angleRad` about one world axis. */
export function axisAngleQuat(axis: Axis, angleRad: number): Quat {
  const [x, y, z] = AXIS_VECTOR[axis];
  const s = Math.sin(angleRad / 2);
  return [x * s, y * s, z * s, Math.cos(angleRad / 2)];
}

/** Rotates `transform` by `quat` about an arbitrary world-space `pivot` (not necessarily the transform's own origin). */
export function rotateTransformAroundPivot(transform: Transform, pivot: Vec3, quat: Quat): Transform {
  const relative = subVec3(transform.positionM, pivot);
  const positionM = addVec3(pivot, rotateVec3(relative, quat));
  return { positionM, quaternion: multiplyQuat(quat, transform.quaternion) };
}

/**
 * The rigid transform that carried a gizmo's proxy from `pivotBefore` to `pivotAfter`, applied to
 * every selected instance about that same pivot — so rotating a multi-selection keeps every
 * instance's position relative to the others, instead of each one spinning in place.
 */
export function applyRigidDelta(pivotBefore: Transform, pivotAfter: Transform, instances: ReadonlyMap<UUID, Transform>): Map<UUID, Transform> {
  const deltaQuat = multiplyQuat(pivotAfter.quaternion, conjugateQuat(pivotBefore.quaternion));
  const result = new Map<UUID, Transform>();
  for (const [id, transform] of instances) {
    const relative = subVec3(transform.positionM, pivotBefore.positionM);
    const positionM = addVec3(pivotAfter.positionM, rotateVec3(relative, deltaQuat));
    result.set(id, { positionM, quaternion: multiplyQuat(deltaQuat, transform.quaternion) });
  }
  return result;
}

/** Translates every instance by the same world-space vector (a keyboard nudge, or a typed "move by" value). */
export function translateInstances(instances: ReadonlyMap<UUID, Transform>, delta: Vec3): Map<UUID, Transform> {
  const result = new Map<UUID, Transform>();
  for (const [id, transform] of instances) result.set(id, { positionM: addVec3(transform.positionM, delta), quaternion: transform.quaternion });
  return result;
}

/** Rotates every instance by `angleRad` about one world `axis` through `pivot` (a typed "rotate by" value, or a keyboard shortcut such as "rotate 90° about Y"). */
export function rotateInstances(instances: ReadonlyMap<UUID, Transform>, pivot: Vec3, axis: Axis, angleRad: number): Map<UUID, Transform> {
  const quat = axisAngleQuat(axis, angleRad);
  const result = new Map<UUID, Transform>();
  for (const [id, transform] of instances) result.set(id, rotateTransformAroundPivot(transform, pivot, quat));
  return result;
}

/** The centroid of a set of world-space positions — the default pivot for a multi-selection rotate. */
export function centroid(points: readonly Vec3[]): Vec3 {
  if (points.length === 0) return [0, 0, 0];
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of points) {
    x += p[0];
    y += p[1];
    z += p[2];
  }
  return [x / points.length, y / points.length, z / points.length];
}

/** Rounds a coordinate to the nearest multiple of `gridM` (optional grid snapping while free-placing). */
export function snapToGrid(value: number, gridM: number): number {
  return gridM > 0 ? Math.round(value / gridM) * gridM : value;
}

export function snapPositionToGrid(position: Vec3, gridM: number): Vec3 {
  return [snapToGrid(position[0], gridM), snapToGrid(position[1], gridM), snapToGrid(position[2], gridM)];
}
