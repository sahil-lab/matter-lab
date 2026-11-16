import type { AtomId, BondId } from '@matterlab/core';

/** Flat arrays describing what is on screen, in the shape the picker iterates fastest. */
export interface PickData {
  readonly atomCount: number;
  /** xyz triples. */
  readonly atomPositions: Float32Array;
  readonly atomRadii: Float32Array;
  readonly atomIds: Int32Array;
  readonly bondCount: number;
  /** xyz triples of the two ends of each bond's visible part, i.e. where it emerges from its atoms. */
  readonly bondStart: Float32Array;
  readonly bondEnd: Float32Array;
  readonly bondRadii: Float32Array;
  readonly bondIds: Int32Array;
}

export interface PickRay {
  readonly ox: number;
  readonly oy: number;
  readonly oz: number;
  /** Unit direction. */
  readonly dx: number;
  readonly dy: number;
  readonly dz: number;
}

export type PickHit =
  | { readonly kind: 'atom'; readonly id: AtomId; readonly index: number; readonly distance: number }
  | { readonly kind: 'bond'; readonly id: BondId; readonly index: number; readonly distance: number };

export interface PickOptions {
  /**
   * Smallest pick radius, as a function of distance along the ray, so thin wireframe atoms and
   * bonds stay easy to hit. Typically a few pixels converted to world units at that depth.
   */
  readonly minRadiusAt?: (distance: number) => number;
  readonly includeBonds?: boolean;
}

/**
 * Finds the nearest atom or bond under a ray by exact ray-sphere and ray-capsule tests over typed
 * arrays. With no allocation per test this handles tens of thousands of atoms in well under a
 * millisecond, so no acceleration structure is needed at interactive scene sizes.
 */
export function pick(data: PickData, ray: PickRay, options: PickOptions = {}): PickHit | null {
  const { ox, oy, oz, dx, dy, dz } = ray;
  const minRadiusAt = options.minRadiusAt;
  let atomT = Infinity;
  let atomIndex = -1;
  let atomRadius = 0;

  const p = data.atomPositions;
  for (let i = 0; i < data.atomCount; i++) {
    if (data.atomRadii[i]! <= 0) continue;
    const cx = p[3 * i]! - ox;
    const cy = p[3 * i + 1]! - oy;
    const cz = p[3 * i + 2]! - oz;
    const along = cx * dx + cy * dy + cz * dz;
    if (along < 0) continue;
    let r = data.atomRadii[i]!;
    if (minRadiusAt) r = Math.max(r, minRadiusAt(along));
    const off2 = cx * cx + cy * cy + cz * cz - along * along;
    if (off2 > r * r) continue;
    const t = along - Math.sqrt(r * r - off2);
    if (t < atomT) {
      atomT = t;
      atomIndex = i;
      atomRadius = r;
    }
  }

  let bondT = Infinity;
  let bondIndex = -1;
  if (options.includeBonds !== false) {
    const a = data.bondStart;
    const b = data.bondEnd;
    for (let i = 0; i < data.bondCount; i++) {
      if (data.bondRadii[i]! <= 0) continue;
      const ax = a[3 * i]!;
      const ay = a[3 * i + 1]!;
      const az = a[3 * i + 2]!;
      const ux = b[3 * i]! - ax;
      const uy = b[3 * i + 1]! - ay;
      const uz = b[3 * i + 2]! - az;
      const wx = ox - ax;
      const wy = oy - ay;
      const wz = oz - az;
      // Closest approach between the ray (o + t d) and the line through the segment (a + s u).
      const uu = ux * ux + uy * uy + uz * uz;
      if (uu < 1e-12) continue;
      const ud = ux * dx + uy * dy + uz * dz;
      const uw = ux * wx + uy * wy + uz * wz;
      const dw = dx * wx + dy * wy + dz * wz;
      const denom = uu - ud * ud;
      if (denom < 1e-9) continue;
      const s = (uw - ud * dw) / denom;
      // The segment is the part of the bond visible between its atoms; it has no rounded ends, so
      // a click on an atom is never claimed by the bond that disappears into it.
      if (s < 0 || s > 1) continue;
      const t = s * ud - dw;
      if (t < 0) continue;
      const ex = wx + t * dx - s * ux;
      const ey = wy + t * dy - s * uy;
      const ez = wz + t * dz - s * uz;
      let r = data.bondRadii[i]!;
      if (minRadiusAt) r = Math.max(r, minRadiusAt(t));
      const gap2 = ex * ex + ey * ey + ez * ez;
      if (gap2 > r * r) continue;
      const hit = t - Math.sqrt(r * r - gap2);
      if (hit < bondT) {
        bondT = hit;
        bondIndex = i;
      }
    }
  }

  if (atomIndex < 0 && bondIndex < 0) return null;
  // An atom wins unless a bond passes clearly in front of it.
  if (atomIndex >= 0 && (bondIndex < 0 || bondT > atomT - atomRadius)) {
    return { kind: 'atom', id: data.atomIds[atomIndex]!, index: atomIndex, distance: atomT };
  }
  return { kind: 'bond', id: data.bondIds[bondIndex]!, index: bondIndex, distance: bondT };
}

/** Where a ray meets the plane through `point` with unit normal `normal`; `null` if they are parallel or it lies behind the ray. */
export function intersectPlane(
  ray: PickRay,
  point: readonly [number, number, number],
  normal: readonly [number, number, number],
): [number, number, number] | null {
  const denom = ray.dx * normal[0] + ray.dy * normal[1] + ray.dz * normal[2];
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((point[0] - ray.ox) * normal[0] + (point[1] - ray.oy) * normal[1] + (point[2] - ray.oz) * normal[2]) / denom;
  if (t < 0) return null;
  return [ray.ox + ray.dx * t, ray.oy + ray.dy * t, ray.oz + ray.dz * t];
}
