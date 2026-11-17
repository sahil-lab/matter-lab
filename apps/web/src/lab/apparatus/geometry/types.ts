/** Shared shape for every procedural geometry builder in `geometry/**`. */
import type { BufferGeometry, Material } from 'three';
import type { Transform } from '../types';

export interface GeometryGroup {
  /** Must match one of the owning definition's `asset.materialSlots`. Still required even when
   * `material` is set, so a slot-based override (or a test) can address the group by name. */
  readonly materialSlot: string;
  readonly geometry: BufferGeometry;
  /** Local offset applied before the group is parented under the apparatus origin. Identity if omitted. */
  readonly transform?: Transform;
  /** A pre-built material to render this group with, taking precedence over slot-based resolution
   * (`components/primitives/materials.ts`). Set by `gltfLoader.ts` to preserve a glTF asset's own
   * authored materials; procedural builders leave this unset so the provisional palette applies. */
  readonly material?: Material;
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
