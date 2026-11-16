/**
 * A uniform-grid spatial index over apparatus world AABBs (see `footprint.ts`). Used so hovering,
 * clicking, marquee-selecting and snap-candidate lookups touch only the apparatus near the pointer
 * or drag target, not the whole scene — the brief's item 8 ("fast selection for large apparatus
 * counts using spatial indexing"). At the apparatus counts a lab scene actually reaches (hundreds,
 * not the tens of thousands `render/picking.ts` brute-forces for atoms), a uniform grid is simple,
 * allocation-light and easy to prove correct; a tighter voxel-traversal (DDA) ray query would prune
 * further but is not needed at this scale and is left as a documented future upgrade.
 */
import type { UUID } from './contracts';
import type { BoundsBox, Vec3 } from './types';
import { aabbsOverlap } from './footprint';

function cellKey(ix: number, iy: number, iz: number): string {
  return `${ix},${iy},${iz}`;
}

/** Spatial grid over world-space AABBs, keyed by an arbitrary id. One bench-sized cell (metres) per bucket. */
export class SpatialIndex<Id = UUID> {
  private readonly cellsOf = new Map<Id, readonly string[]>();
  private readonly boxOf = new Map<Id, BoundsBox>();
  private readonly buckets = new Map<string, Set<Id>>();

  constructor(private readonly cellSizeM = 0.5) {}

  get size(): number {
    return this.boxOf.size;
  }

  private cellsFor(box: BoundsBox): string[] {
    const s = this.cellSizeM;
    const minX = Math.floor(box.min[0] / s);
    const minY = Math.floor(box.min[1] / s);
    const minZ = Math.floor(box.min[2] / s);
    const maxX = Math.floor(box.max[0] / s);
    const maxY = Math.floor(box.max[1] / s);
    const maxZ = Math.floor(box.max[2] / s);
    const keys: string[] = [];
    for (let ix = minX; ix <= maxX; ix++) {
      for (let iy = minY; iy <= maxY; iy++) {
        for (let iz = minZ; iz <= maxZ; iz++) keys.push(cellKey(ix, iy, iz));
      }
    }
    return keys;
  }

  upsert(id: Id, box: BoundsBox): void {
    this.remove(id);
    const keys = this.cellsFor(box);
    this.cellsOf.set(id, keys);
    this.boxOf.set(id, box);
    for (const key of keys) {
      let bucket = this.buckets.get(key);
      if (!bucket) {
        bucket = new Set();
        this.buckets.set(key, bucket);
      }
      bucket.add(id);
    }
  }

  remove(id: Id): void {
    const keys = this.cellsOf.get(id);
    if (!keys) return;
    for (const key of keys) {
      const bucket = this.buckets.get(key);
      bucket?.delete(id);
      if (bucket && bucket.size === 0) this.buckets.delete(key);
    }
    this.cellsOf.delete(id);
    this.boxOf.delete(id);
  }

  clear(): void {
    this.cellsOf.clear();
    this.boxOf.clear();
    this.buckets.clear();
  }

  boxFor(id: Id): BoundsBox | undefined {
    return this.boxOf.get(id);
  }

  /** Every id whose stored box overlaps `box`, visiting only the buckets `box` itself falls into. */
  queryBox(box: BoundsBox): Id[] {
    const seen = new Set<Id>();
    const out: Id[] = [];
    for (const key of this.cellsFor(box)) {
      const bucket = this.buckets.get(key);
      if (!bucket) continue;
      for (const id of bucket) {
        if (seen.has(id)) continue;
        seen.add(id);
        const candidate = this.boxOf.get(id);
        if (candidate && aabbsOverlap(candidate, box, -1e-9)) out.push(id);
      }
    }
    return out;
  }

  /** Candidates for a ray pick: the ids whose box overlaps the ray segment's own (axis-aligned) bounding box. */
  queryRaySegment(origin: Vec3, end: Vec3, paddingM = 0.05): Id[] {
    const box: BoundsBox = {
      min: [Math.min(origin[0], end[0]) - paddingM, Math.min(origin[1], end[1]) - paddingM, Math.min(origin[2], end[2]) - paddingM],
      max: [Math.max(origin[0], end[0]) + paddingM, Math.max(origin[1], end[1]) + paddingM, Math.max(origin[2], end[2]) + paddingM],
    };
    return this.queryBox(box);
  }

  /** Every id within `radiusM` of `point` (a cheap box query, not an exact sphere test — used for snap-candidate lookups). */
  queryNear(point: Vec3, radiusM: number): Id[] {
    return this.queryBox({
      min: [point[0] - radiusM, point[1] - radiusM, point[2] - radiusM],
      max: [point[0] + radiusM, point[1] + radiusM, point[2] + radiusM],
    });
  }

  ids(): IterableIterator<Id> {
    return this.boxOf.keys();
  }
}
