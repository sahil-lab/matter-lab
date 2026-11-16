/**
 * World-space geometry for apparatus instances, derived from Agent 03's per-definition
 * `ApparatusFootprint` (local half-extents + center) and the instance's own `Transform`. Used for
 * picking, collision/overlap warnings and placement-preview bounds — never for rendering geometry
 * (that is Agent 03/05's job; this is intentionally a coarse oriented box, adequate for the
 * procedural placeholder assets this branch stubs).
 */
import type { Transform } from './contracts';
import type { ApparatusFootprint, BoundsBox, Vec3 } from './types';

/** Rotates a local-space vector by a unit quaternion `[x, y, z, w]`. */
export function rotateVec3(v: Vec3, q: readonly [number, number, number, number]): Vec3 {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  // t = 2 * cross(q.xyz, v)
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  // v' = v + w * t + cross(q.xyz, t)
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ];
}

export function addVec3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function worldPointFor(local: Vec3, transform: Transform): Vec3 {
  return addVec3(transform.positionM, rotateVec3(local, transform.quaternion));
}

/** An oriented box in world space: the eight corners of the local footprint, each carried through the transform. */
export interface OrientedBox {
  readonly corners: readonly [Vec3, Vec3, Vec3, Vec3, Vec3, Vec3, Vec3, Vec3];
}

export function orientedBoxFor(footprint: ApparatusFootprint, transform: Transform): OrientedBox {
  const [hx, hy, hz] = footprint.halfExtents;
  const [cx, cy, cz] = footprint.center;
  const signs: readonly [number, number, number][] = [
    [-1, -1, -1],
    [1, -1, -1],
    [-1, 1, -1],
    [1, 1, -1],
    [-1, -1, 1],
    [1, -1, 1],
    [-1, 1, 1],
    [1, 1, 1],
  ];
  const corners = signs.map(([sx, sy, sz]) => worldPointFor([cx + sx * hx, cy + sy * hy, cz + sz * hz], transform)) as unknown as OrientedBox['corners'];
  return { corners };
}

/** The axis-aligned bounding box of an oriented box, in world space — conservative but cheap to overlap-test. */
export function aabbOf(box: OrientedBox): BoundsBox {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const [x, y, z] of box.corners) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

export function worldAabbFor(footprint: ApparatusFootprint, transform: Transform): BoundsBox {
  return aabbOf(orientedBoxFor(footprint, transform));
}

/** True when two AABBs overlap by more than `epsilon` metres along every axis (touching exactly is not an overlap). */
export function aabbsOverlap(a: BoundsBox, b: BoundsBox, epsilon = 0): boolean {
  return (
    a.min[0] + epsilon < b.max[0] &&
    b.min[0] + epsilon < a.max[0] &&
    a.min[1] + epsilon < b.max[1] &&
    b.min[1] + epsilon < a.max[1] &&
    a.min[2] + epsilon < b.max[2] &&
    b.min[2] + epsilon < a.max[2]
  );
}

export function aabbContainsPoint(box: BoundsBox, point: Vec3): boolean {
  return (
    point[0] >= box.min[0] && point[0] <= box.max[0] &&
    point[1] >= box.min[1] && point[1] <= box.max[1] &&
    point[2] >= box.min[2] && point[2] <= box.max[2]
  );
}

export function aabbCenter(box: BoundsBox): Vec3 {
  return [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];
}

export function unionAabb(a: BoundsBox, b: BoundsBox): BoundsBox {
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

export interface Ray {
  readonly origin: Vec3;
  /** Unit direction. */
  readonly direction: Vec3;
}

/** Slab-method ray/AABB intersection; returns the entry distance along the ray, or `null` if it misses. */
export function rayIntersectsAabb(ray: Ray, box: BoundsBox): number | null {
  let tMin = -Infinity;
  let tMax = Infinity;
  for (let axis = 0; axis < 3; axis++) {
    const origin = ray.origin[axis]!;
    const dir = ray.direction[axis]!;
    const min = box.min[axis]!;
    const max = box.max[axis]!;
    if (Math.abs(dir) < 1e-12) {
      if (origin < min || origin > max) return null;
      continue;
    }
    let t1 = (min - origin) / dir;
    let t2 = (max - origin) / dir;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return null;
  }
  if (tMax < 0) return null;
  // tMin < 0 here means the entry point is behind the origin, i.e. the origin itself is inside the
  // box (tMax >= 0 was just checked): report that as touching at distance 0, not at the far exit.
  return Math.max(tMin, 0);
}
