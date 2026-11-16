/**
 * Pure pose math for sockets and attachments. The public `Transform` shape (plain position +
 * quaternion tuples) is what gets serialized and handed to other agents; internally this module
 * uses `three`'s vector/quaternion/matrix classes (already a dependency of `apps/web`) because
 * hand-rolled quaternion composition is easy to get subtly wrong.
 */
import { Euler, Matrix4, Quaternion as ThreeQuaternion, Vector3 } from 'three';
import type { Transform } from './types';
import { IDENTITY_TRANSFORM } from './types';

function toMatrix(t: Transform): Matrix4 {
  const q = new ThreeQuaternion(t.quaternion[0], t.quaternion[1], t.quaternion[2], t.quaternion[3]);
  if (q.lengthSq() === 0) q.set(0, 0, 0, 1);
  q.normalize();
  const p = new Vector3(t.positionM[0], t.positionM[1], t.positionM[2]);
  return new Matrix4().compose(p, q, new Vector3(1, 1, 1));
}

function fromMatrix(m: Matrix4): Transform {
  const p = new Vector3();
  const q = new ThreeQuaternion();
  const s = new Vector3();
  m.decompose(p, q, s);
  return { positionM: [p.x, p.y, p.z], quaternion: [q.x, q.y, q.z, q.w] };
}

/** Builds a `Transform` from a position and an intrinsic XYZ-order Euler rotation in degrees —
 * easier to author by hand than a raw quaternion. */
export function transformFromEuler(
  positionM: readonly [number, number, number],
  eulerDeg: readonly [number, number, number] = [0, 0, 0],
): Transform {
  const rad = (d: number) => (d * Math.PI) / 180;
  const q = new ThreeQuaternion().setFromEuler(new Euler(rad(eulerDeg[0]), rad(eulerDeg[1]), rad(eulerDeg[2]), 'XYZ'));
  return { positionM: [...positionM], quaternion: [q.x, q.y, q.z, q.w] };
}

/**
 * A socket transform at `positionM` whose local +Z axis coincides with the object's own +Y ("up").
 * `SocketDefinition`'s 'axial' travel runs along local +Z, and a 'planar' mate's free offset runs
 * in the local XY plane (so local +Z is the surface normal) — every vertical mating socket across
 * `definitions/**` (bench and stirrer-plate surfaces, stand poles, clamp jaws, vessel bases) uses
 * this same convention, so that mating two such sockets leaves the attached object standing
 * upright with only the documented degree of freedom (slide height, surface offset, yaw) free.
 */
export function uprightSocketTransform(positionM: readonly [number, number, number]): Transform {
  return transformFromEuler(positionM, [-90, 0, 0]);
}

/** `parent * child`: `child` is expressed in `parent`'s frame; the result is in whatever frame `parent` was in. */
export function composeTransforms(parent: Transform, child: Transform): Transform {
  return fromMatrix(toMatrix(parent).multiply(toMatrix(child)));
}

export function invertTransform(t: Transform): Transform {
  return fromMatrix(toMatrix(t).invert());
}

export function applyTransformToPoint(t: Transform, point: readonly [number, number, number]): [number, number, number] {
  const v = new Vector3(point[0], point[1], point[2]).applyMatrix4(toMatrix(t));
  return [v.x, v.y, v.z];
}

/** Translates `t` by `distanceM` along its own local +Z axis (used for axial-socket travel). */
export function offsetAlongLocalZ(t: Transform, distanceM: number): Transform {
  return composeTransforms(t, { positionM: [0, 0, distanceM], quaternion: [0, 0, 0, 1] });
}

/**
 * Solves for the world transform a child apparatus's *origin* must have so that one of its local
 * sockets exactly coincides (position and orientation) with a parent socket already placed in the
 * world. This is the one non-trivial piece of socket math every "mate" ultimately reduces to:
 * `childWorldOrigin * childSocketLocal == parentSocketWorld`, so
 * `childWorldOrigin == parentSocketWorld * inverse(childSocketLocal)`.
 */
export function solveCoincidentOrigin(parentSocketWorld: Transform, childSocketLocal: Transform): Transform {
  return fromMatrix(toMatrix(parentSocketWorld).multiply(toMatrix(childSocketLocal).invert()));
}

export function distanceBetween(a: Transform, b: Transform): number {
  const [ax, ay, az] = a.positionM;
  const [bx, by, bz] = b.positionM;
  return Math.hypot(ax - bx, ay - by, az - bz);
}

/** Angle in radians between the local +Z axes of two transforms, in [0, pi]. */
export function axisAngleBetween(a: Transform, b: Transform): number {
  const az = new Vector3(0, 0, 1).applyQuaternion(new ThreeQuaternion(...a.quaternion));
  const bz = new Vector3(0, 0, 1).applyQuaternion(new ThreeQuaternion(...b.quaternion));
  return az.angleTo(bz);
}

export function approxEqualTransform(a: Transform, b: Transform, posEpsM = 1e-5, angleEpsRad = 1e-3): boolean {
  if (distanceBetween(a, b) > posEpsM) return false;
  const qa = new ThreeQuaternion(...a.quaternion);
  const qb = new ThreeQuaternion(...b.quaternion);
  // Quaternions q and -q represent the same rotation.
  const angle = qa.angleTo(qb);
  return Math.min(angle, Math.abs(Math.PI * 2 - angle)) <= angleEpsRad;
}

export { IDENTITY_TRANSFORM };
