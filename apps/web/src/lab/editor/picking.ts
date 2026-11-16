/**
 * Ray-vs-apparatus picking for the editor's own pointer controller. Pruned by `SpatialIndex`
 * first, then resolved exactly against each candidate's world AABB (`footprint.ts`) — the same
 * two-stage shape as `render/picking.ts`'s analytic atom/bond picking, adapted for apparatus counts
 * instead of atom counts, and for oriented boxes instead of spheres/capsules (see the stand-in note
 * in `lab/apparatus/catalog.ts`: placeholder geometry is boxes/cylinders, so a box test is the
 * right level of precision until Agent 03's real meshes land).
 */
import type { ApparatusInstance, UUID } from './contracts';
import type { ApparatusFootprint, BoundsBox, Vec3 } from './types';
import type { Ray } from './footprint';
import { rayIntersectsAabb, worldAabbFor } from './footprint';
import type { SpatialIndex } from './spatialIndex';

export interface PickCandidateSource {
  getApparatus(id: UUID): ApparatusInstance | undefined;
  getFootprint(instance: ApparatusInstance): ApparatusFootprint | undefined;
}

export interface ApparatusPickHit {
  readonly instanceId: UUID;
  readonly distanceM: number;
  readonly box: BoundsBox;
}

/** Recomputes and stores every apparatus's world AABB; call once after a bulk load, then maintain incrementally. */
export function rebuildPickIndex(index: SpatialIndex<UUID>, apparatus: Iterable<ApparatusInstance>, source: PickCandidateSource): void {
  index.clear();
  for (const instance of apparatus) {
    const footprint = source.getFootprint(instance);
    if (!footprint) continue;
    index.upsert(instance.id, worldAabbFor(footprint, instance.transform));
  }
}

/** Updates (or inserts) one instance's entry; used after a single placement/move instead of a full rebuild. */
export function updatePickIndex(index: SpatialIndex<UUID>, instance: ApparatusInstance, source: PickCandidateSource): void {
  const footprint = source.getFootprint(instance);
  if (!footprint) {
    index.remove(instance.id);
    return;
  }
  index.upsert(instance.id, worldAabbFor(footprint, instance.transform));
}

const FAR_M = 25;

/** The nearest apparatus hit by `ray`, or `null`. `maxDistanceM` bounds the broad-phase query segment. */
export function pickApparatus(index: SpatialIndex<UUID>, ray: Ray, maxDistanceM = FAR_M): ApparatusPickHit | null {
  const end: Vec3 = [ray.origin[0] + ray.direction[0] * maxDistanceM, ray.origin[1] + ray.direction[1] * maxDistanceM, ray.origin[2] + ray.direction[2] * maxDistanceM];
  let best: ApparatusPickHit | null = null;
  for (const id of index.queryRaySegment(ray.origin, end)) {
    const box = index.boxFor(id);
    if (!box) continue;
    const t = rayIntersectsAabb(ray, box);
    if (t === null || t > maxDistanceM) continue;
    if (!best || t < best.distanceM) best = { instanceId: id, distanceM: t, box };
  }
  return best;
}

/** Every apparatus whose box intersects `box` (for marquee / box selection), read straight from the index. */
export function pickApparatusInBox(index: SpatialIndex<UUID>, box: BoundsBox): UUID[] {
  return index.queryBox(box);
}
