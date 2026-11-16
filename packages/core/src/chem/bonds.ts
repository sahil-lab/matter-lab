import { getElement } from '../elements';
import type { AtomId, BondOrder, Vec3 } from '../types';
import { vdist } from '../vec3';

/** Shortening applied to the single-bond length for higher bond orders. */
const ORDER_SCALE: Readonly<Record<number, number>> = { 1: 1, 1.5: 0.92, 2: 0.87, 3: 0.78 };

/**
 * Typical bond length in angstrom between elements `zA` and `zB`: the sum of their single-bond
 * covalent radii (Cordero et al. 2008), shortened for multiple bonds. A rule-based estimate that is
 * typically within a few hundredths of an angstrom for organic bonds; use it for placement, not as data.
 */
export function idealBondLength(zA: number, zB: number, order: BondOrder = 1): number {
  return (getElement(zA).covalentRadius + getElement(zB).covalentRadius) * (ORDER_SCALE[order] ?? 1);
}

export interface PositionedAtom {
  readonly id: AtomId;
  readonly protons: number;
  readonly position: Vec3;
}

export interface PerceiveBondsOptions {
  /** Slack added to the sum of covalent radii, in angstrom. */
  readonly tolerance?: number;
  /** Pairs closer than this are treated as overlapping atoms, not bonds. */
  readonly minDistance?: number;
}

/**
 * Largest number of neighbours an atom of these elements can have, used only to discard spurious
 * long contacts. The limits are coordination numbers, not neutral valences, because formats that
 * need bond perception carry no charges: nitrogen may be an ammonium (4) and oxygen an oxonium (3).
 * Elements not listed are not pruned.
 */
const MAX_COORDINATION: Readonly<Record<number, number>> = { 1: 1, 2: 0, 5: 4, 6: 4, 7: 4, 8: 3, 9: 1, 10: 0, 18: 0 };

/**
 * Infers which atoms are bonded from geometry alone, for formats that carry no connectivity (XYZ).
 * Two atoms are bonded when their distance is at most the sum of their covalent radii plus a
 * tolerance; atoms that end up over-coordinated then drop their longest bonds.
 *
 * Bond ORDERS cannot be recovered this way, so every perceived bond is a single bond.
 */
export function perceiveBonds(atoms: readonly PositionedAtom[], options: PerceiveBondsOptions = {}): Array<{ a: AtomId; b: AtomId }> {
  const tolerance = options.tolerance ?? 0.45;
  const minDistance = options.minDistance ?? 0.4;
  if (atoms.length < 2) return [];

  const radii = atoms.map((a) => getElement(a.protons).covalentRadius);
  const cell = 2 * Math.max(...radii) + tolerance;
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const grid = new Map<string, number[]>();
  const cellOf = (p: Vec3) => [Math.floor(p[0] / cell), Math.floor(p[1] / cell), Math.floor(p[2] / cell)] as const;
  atoms.forEach((atom, i) => {
    const [cx, cy, cz] = cellOf(atom.position);
    const k = key(cx, cy, cz);
    const bucket = grid.get(k);
    if (bucket) bucket.push(i);
    else grid.set(k, [i]);
  });

  const candidates: Array<{ i: number; j: number; d: number }> = [];
  atoms.forEach((atom, i) => {
    const [cx, cy, cz] = cellOf(atom.position);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (const j of grid.get(key(cx + dx, cy + dy, cz + dz)) ?? []) {
            if (j <= i) continue;
            const d = vdist(atom.position, atoms[j]!.position);
            if (d >= minDistance && d <= radii[i]! + radii[j]! + tolerance) candidates.push({ i, j, d });
          }
        }
      }
    }
  });

  const maxValence = atoms.map((a) => MAX_COORDINATION[a.protons] ?? Infinity);
  const degree = new Array<number>(atoms.length).fill(0);
  for (const c of candidates) {
    degree[c.i]!++;
    degree[c.j]!++;
  }
  // Drop the longest bonds of over-coordinated atoms first.
  const kept = new Set(candidates);
  for (const c of [...candidates].sort((x, y) => y.d - x.d)) {
    if (degree[c.i]! > maxValence[c.i]! || degree[c.j]! > maxValence[c.j]!) {
      kept.delete(c);
      degree[c.i]!--;
      degree[c.j]!--;
    }
  }

  return candidates.filter((c) => kept.has(c)).map((c) => ({ a: atoms[c.i]!.id, b: atoms[c.j]!.id }));
}
