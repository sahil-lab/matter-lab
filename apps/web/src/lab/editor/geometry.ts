import { Matrix3, Matrix4, Quaternion, Ray, Vector3 } from 'three';
import { OBB } from 'three/addons/math/OBB.js';
import type { ApparatusDefinition, BoundsM, Transform, Vec3M } from '@matterlab/contracts/lab';
import type { LabBoundsM, WorldRayM } from '../environment/types';
import { transformBounds } from '../environment/coordinates';

export const IDENTITY_TRANSFORM: Transform = { positionM: [0, 0, 0], quaternion: [0, 0, 0, 1] };
const EPSILON_M = 1e-6;

export function sameTransform(a: Transform, b: Transform): boolean {
  return a.positionM.every((value, axis) => Math.abs(value - b.positionM[axis]) < 1e-9) &&
    a.quaternion.every((value, axis) => Math.abs(value - b.quaternion[axis]) < 1e-9);
}
export function matrixOf(transform: Transform): Matrix4 {
  if (!transform.positionM.every(Number.isFinite) || !transform.quaternion.every(Number.isFinite) ||
      Math.abs(Math.hypot(...transform.quaternion) - 1) > 1e-6) {
    throw new RangeError('Transforms require finite meter coordinates and a normalized quaternion.');
  }
  return new Matrix4().compose(new Vector3(...transform.positionM), new Quaternion(...transform.quaternion), new Vector3(1, 1, 1));
}
export function transformOf(matrix: Matrix4): Transform {
  const position = new Vector3();
  const quaternion = new Quaternion();
  matrix.decompose(position, quaternion, new Vector3());
  return { positionM: position.toArray(), quaternion: quaternion.normalize().toArray() };
}
export function worldBounds(definition: ApparatusDefinition, transform: Transform): LabBoundsM {
  return transformBounds({ minM: definition.boundsM.min, maxM: definition.boundsM.max }, transform);
}
export function boundsCorners(bounds: BoundsM, transform: Transform): readonly Vec3M[] {
  const matrix = matrixOf(transform);
  const corners: Vec3M[] = [];
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) {
        corners.push(new Vector3(x, y, z).applyMatrix4(matrix).toArray());
      }
    }
  }
  return corners;
}
export function orientedBounds(definition: ApparatusDefinition, transform: Transform): OBB {
  const { min, max } = definition.boundsM;
  const center = new Vector3(...min).add(new Vector3(...max)).multiplyScalar(0.5);
  const halfSize = new Vector3(...max).sub(new Vector3(...min)).multiplyScalar(0.5);
  halfSize.set(Math.max(0, halfSize.x - EPSILON_M), Math.max(0, halfSize.y - EPSILON_M), Math.max(0, halfSize.z - EPSILON_M));
  const matrix = matrixOf(transform);
  center.applyMatrix4(matrix);
  return new OBB(center, halfSize, new Matrix3().setFromMatrix4(matrix));
}
export function overlaps(a: LabBoundsM, b: LabBoundsM): boolean {
  return a.minM.every((minimum, axis) => minimum < b.maxM[axis] - EPSILON_M && a.maxM[axis] > b.minM[axis] + EPSILON_M);
}
export function rayBoundsDistance(ray: WorldRayM, bounds: LabBoundsM): number | null {
  let near = 0;
  let far = Infinity;
  for (let axis = 0; axis < 3; axis++) {
    const direction = ray.direction[axis];
    const origin = ray.originM[axis];
    if (Math.abs(direction) < 1e-12) {
      if (origin < bounds.minM[axis] || origin > bounds.maxM[axis]) return null;
    } else {
      const first = (bounds.minM[axis] - origin) / direction;
      const second = (bounds.maxM[axis] - origin) / direction;
      near = Math.max(near, Math.min(first, second));
      far = Math.min(far, Math.max(first, second));
      if (far < near) return null;
    }
  }
  return near;
}
export function rayApparatusDistance(ray: WorldRayM, definition: ApparatusDefinition, transform: Transform): number | null {
  const hit = orientedBounds(definition, transform).intersectRay(
    new Ray(new Vector3(...ray.originM), new Vector3(...ray.direction).normalize()), new Vector3(),
  );
  return hit ? hit.distanceTo(new Vector3(...ray.originM)) : null;
}

interface IndexEntry { readonly bounds: LabBoundsM; readonly cells: readonly string[] }

/** Sparse meter-space broad phase. Oversized objects never allocate unbounded grid cells. */
export class ApparatusSpatialIndex {
  private readonly entries = new Map<string, IndexEntry>();
  private readonly cells = new Map<string, Set<string>>();
  private readonly oversized = new Set<string>();
  constructor(readonly cellSizeM = 0.25) {
    if (!Number.isFinite(cellSizeM) || cellSizeM <= 0) throw new RangeError('Spatial cell size must be positive meters.');
  }
  get size(): number { return this.entries.size; }
  clear(): void { this.entries.clear(); this.cells.clear(); this.oversized.clear(); }
  private keys(bounds: LabBoundsM): string[] | null {
    const min = bounds.minM.map((value) => Math.floor(value / this.cellSizeM));
    const max = bounds.maxM.map((value) => Math.floor(value / this.cellSizeM));
    if (min.some((value, axis) => !Number.isFinite(value) || !Number.isFinite(max[axis]) || value > max[axis])) return null;
    if (max.reduce((count, value, axis) => count * (value - min[axis] + 1), 1) > 4096) return null;
    const result: string[] = [];
    for (let x = min[0]; x <= max[0]; x++) {
      for (let y = min[1]; y <= max[1]; y++) {
        for (let z = min[2]; z <= max[2]; z++) result.push(`${x},${y},${z}`);
      }
    }
    return result;
  }
  remove(id: string): void {
    const previous = this.entries.get(id);
    for (const key of previous?.cells ?? []) {
      const bucket = this.cells.get(key);
      bucket?.delete(id);
      if (bucket?.size === 0) this.cells.delete(key);
    }
    this.entries.delete(id);
    this.oversized.delete(id);
  }
  upsert(id: string, bounds: LabBoundsM): void {
    this.remove(id);
    const keys = this.keys(bounds);
    this.entries.set(id, { bounds, cells: keys ?? [] });
    if (keys === null) this.oversized.add(id);
    else for (const key of keys) {
      const bucket = this.cells.get(key) ?? new Set<string>();
      bucket.add(id);
      this.cells.set(key, bucket);
    }
  }
  query(bounds: LabBoundsM): string[] {
    const keys = this.keys(bounds);
    const candidates = keys === null ? new Set(this.entries.keys()) : new Set(this.oversized);
    for (const key of keys ?? []) for (const id of this.cells.get(key) ?? []) candidates.add(id);
    return [...candidates].filter((id) => overlaps(bounds, this.entries.get(id)!.bounds));
  }
  raycast(ray: WorldRayM, maximumDistanceM = 100): readonly { id: string; distanceM: number }[] {
    if (!ray.originM.every(Number.isFinite) || !ray.direction.every(Number.isFinite) ||
        !Number.isFinite(maximumDistanceM) || maximumDistanceM <= 0) return [];
    const direction = new Vector3(...ray.direction);
    if (direction.lengthSq() < 1e-12) return [];
    direction.normalize();
    const unitRay: WorldRayM = { originM: ray.originM, direction: direction.toArray() };
    const cell = ray.originM.map((value) => Math.floor(value / this.cellSizeM));
    const step = unitRay.direction.map((value) => value >= 0 ? 1 : -1);
    const delta = unitRay.direction.map((value) => value === 0 ? Infinity : this.cellSizeM / Math.abs(value));
    const next = unitRay.direction.map((value, axis) => value === 0 ? Infinity :
      ((cell[axis] + (step[axis] > 0 ? 1 : 0)) * this.cellSizeM - ray.originM[axis]) / value);
    const candidates = new Set(this.oversized);
    let distance = 0;
    for (let count = 0; count < 4096 && distance <= maximumDistanceM; count++) {
      for (const id of this.cells.get(cell.join(',')) ?? []) candidates.add(id);
      const axis = next[0] <= next[1] && next[0] <= next[2] ? 0 : next[1] <= next[2] ? 1 : 2;
      distance = next[axis];
      cell[axis] += step[axis];
      next[axis] += delta[axis];
    }
    return [...candidates].flatMap((id) => {
      const distanceM = rayBoundsDistance(unitRay, this.entries.get(id)!.bounds);
      return distanceM !== null && distanceM <= maximumDistanceM ? [{ id, distanceM }] : [];
    }).sort((a, b) => a.distanceM - b.distanceM);
  }
}
