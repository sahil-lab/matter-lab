/** Shared shape for every procedural geometry builder in `geometry/**`. */
import type { BufferGeometry } from 'three';
import type { Transform } from '../types';

export interface GeometryGroup {
  /** Must match one of the owning definition's `asset.materialSlots`. */
  readonly materialSlot: string;
  readonly geometry: BufferGeometry;
  /** Local offset applied before the group is parented under the apparatus origin. Identity if omitted. */
  readonly transform?: Transform;
}

export interface GeometryBuildResult {
  readonly groups: readonly GeometryGroup[];
  readonly polyCount: number;
}

export function combineBuildResults(groups: readonly GeometryGroup[]): GeometryBuildResult {
  let polyCount = 0;
  for (const g of groups) {
    const index = g.geometry.index;
    polyCount += index ? index.count / 3 : (g.geometry.getAttribute('position')?.count ?? 0) / 3;
  }
  return { groups, polyCount };
}
