import { neighborsOf, sideOfBond, vadd, vcross, vdot, vlen, vnorm, vscale, vsub } from '@matterlab/core';
import type { AtomId, Scene, Vec3 } from '@matterlab/core';

/**
 * Changing the configuration of a stereocentre or of a double bond in a 3D model, by moving whole
 * groups of atoms as rigid bodies.
 *
 * Every move is a half turn about an axis, never a mirror image: a rotation keeps the handedness
 * of whatever is inside the group that moves, so correcting one centre cannot spoil another one
 * further out. The result is a strained starting geometry with the right configuration; it is
 * meant to be relaxed afterwards.
 */

export type Positions = Map<AtomId, Vec3>;

/** How far (angstrom) an atom at the wide end of a wedge is lifted out of the plane of a drawing. */
export const WEDGE_LIFT = 0.8;

/**
 * Heights out of the plane for the atoms of a flat structure diagram in molfile form, from its
 * wedges: the atom at the wide end of a solid wedge is in front of the plane, the atom at the wide
 * end of a hashed one behind it. This gives a force field a start with the right configuration at
 * most stereocentres.
 */
export function wedgeHeights(molblock: string, atomCount: number): number[] {
  const heights = new Array<number>(atomCount).fill(0);
  const lines = molblock.split(/\r?\n/);
  const counts = lines[3] ?? '';
  // Only the fixed-column format marks wedges this way; without them every configuration is corrected afterwards.
  if (!counts.includes('V2000')) return heights;
  const atoms = Number(counts.slice(0, 3));
  const bonds = Number(counts.slice(3, 6));
  if (atoms !== atomCount || !Number.isInteger(bonds)) return heights;
  for (let i = 0; i < bonds; i++) {
    const line = lines[4 + atoms + i] ?? '';
    const wideEnd = Number(line.slice(3, 6));
    const mark = Number(line.slice(9, 12));
    if (!(wideEnd >= 1 && wideEnd <= atomCount)) continue;
    if (mark === 1) heights[wideEnd - 1] = WEDGE_LIFT;
    else if (mark === 6) heights[wideEnd - 1] = -WEDGE_LIFT;
  }
  return heights;
}

/** Configurations as Cahn-Ingold-Prelog labels, by atom index (the shape RDKit's worker reports them in). */
export interface Configurations {
  readonly centres: ReadonlyArray<{ readonly atom: number; readonly label: string }>;
  readonly doubleBonds: ReadonlyArray<{ readonly a: number; readonly b: number; readonly label: string }>;
}

export interface ConfigurationErrors {
  /** Atom indices of stereocentres that do not have the configuration asked for. */
  readonly centres: number[];
  readonly doubleBonds: Array<readonly [number, number]>;
}

const pair = (a: number, b: number): string => (a < b ? `${a}-${b}` : `${b}-${a}`);

/**
 * Where a model differs from what was asked for. A centre or double bond that was asked for and
 * that the model does not have at all counts as wrong; what was left open cannot be wrong.
 */
export function configurationErrors(asked: Configurations, model: Configurations): ConfigurationErrors {
  const centre = new Map(model.centres.map((entry) => [entry.atom, entry.label]));
  const bond = new Map(model.doubleBonds.map((entry) => [pair(entry.a, entry.b), entry.label]));
  return {
    centres: asked.centres.filter((entry) => centre.get(entry.atom) !== entry.label).map((entry) => entry.atom),
    doubleBonds: asked.doubleBonds.filter((entry) => bond.get(pair(entry.a, entry.b)) !== entry.label).map((entry) => [entry.a, entry.b] as const),
  };
}

/** The point `p` turned by 180 degrees about the line through `origin` along the unit vector `axis`. */
function halfTurn(p: Vec3, origin: Vec3, axis: Vec3): Vec3 {
  const v = vsub(p, origin);
  return vadd(origin, vsub(vscale(axis, 2 * vdot(axis, v)), v));
}

/** Some unit vector perpendicular to `v`. */
function perpendicular(v: Vec3): Vec3 {
  const other: Vec3 = Math.abs(v[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return vnorm(vcross(v, other));
}

/**
 * Which way round three neighbours of an atom are arranged, seen from the atom: the sign of the
 * volume they span with it. It changes sign exactly when the configuration is inverted.
 */
export function handedness(positions: ReadonlyMap<AtomId, Vec3>, centre: AtomId, neighbours: readonly [AtomId, AtomId, AtomId]): number {
  const c = positions.get(centre)!;
  const [a, b, d] = neighbours.map((id) => vsub(positions.get(id)!, c)) as [Vec3, Vec3, Vec3];
  return Math.sign(vdot(a, vcross(b, d)));
}

/**
 * Inverts the configuration at `centre` in place. Returns `false`, leaving the positions as they
 * were, when it cannot be done by moving groups rigidly: an atom all of whose four bonds are in
 * rings (a spiro or bridgehead atom without a free substituent).
 */
export function invertCentre(scene: Scene, positions: Positions, centre: AtomId): boolean {
  const c = positions.get(centre);
  if (!c) return false;
  const at = (id: AtomId): Vec3 => positions.get(id)!;
  const neighbours = neighborsOf(scene, centre).map((n) => n.atomId);
  // A substituent is free when cutting its bond to the centre detaches it; otherwise it is tied to the centre through a ring.
  const free: Array<{ id: AtomId; side: Set<AtomId> }> = [];
  const tied: AtomId[] = [];
  for (const id of neighbours) {
    const side = sideOfBond(scene, centre, id);
    if (side) free.push({ id, side });
    else tied.push(id);
  }

  // The plane of three neighbours, the foot of the centre on it, and a direction in it.
  const throughPlane = (three: readonly AtomId[]): { foot: Vec3; inPlane: Vec3 } | null => {
    const [r1, r2, r3] = three.map(at) as [Vec3, Vec3, Vec3];
    const normal = vcross(vsub(r2, r1), vsub(r3, r1));
    if (vlen(normal) < 1e-6) return null;
    const n = vnorm(normal);
    const foot = vsub(c, vscale(n, vdot(vsub(c, r1), n)));
    const towards = vlen(vsub(r1, foot)) > 1e-6 ? vsub(r1, foot) : vsub(r2, foot);
    return vlen(towards) < 1e-6 ? null : { foot, inPlane: vnorm(towards) };
  };

  // Three neighbours and a lone pair: the centre goes through the plane of its neighbours.
  if (neighbours.length === 3) {
    const plane = throughPlane(neighbours);
    if (!plane) return false;
    positions.set(centre, halfTurn(c, plane.foot, plane.inPlane));
    return true;
  }
  if (neighbours.length !== 4) return false;

  // Two free substituents change places: a half turn of both about the line that bisects them.
  // The two smallest groups are moved, and of equally small ones the lightest atoms (hydrogen first).
  if (free.length >= 2) {
    const weight = (id: AtomId): number => scene.atoms.get(id)?.protons ?? 0;
    free.sort((x, y) => x.side.size - y.side.size || weight(x.id) - weight(y.id));
    const [first, second] = free as [(typeof free)[number], (typeof free)[number]];
    const a = vnorm(vsub(at(first.id), c));
    const b = vnorm(vsub(at(second.id), c));
    const bisector = vadd(a, b);
    const axis = vlen(bisector) < 1e-6 ? perpendicular(a) : vnorm(bisector);
    for (const id of [...first.side, ...second.side]) positions.set(id, halfTurn(at(id), c, axis));
    return true;
  }

  // One free substituent on an atom where three rings meet: the centre and that substituent go
  // through the plane of the three ring neighbours, like an umbrella turning inside out.
  if (free.length === 1 && tied.length === 3) {
    const plane = throughPlane(tied);
    if (!plane) return false;
    for (const id of [centre, ...free[0]!.side]) positions.set(id, halfTurn(at(id), plane.foot, plane.inPlane));
    return true;
  }
  return false;
}

/**
 * Turns one end of the double bond between `a` and `b` by 180 degrees about the bond, in place,
 * which changes E into Z and Z into E. Returns `false`, leaving the positions as they were, when
 * the bond is part of a ring.
 */
export function flipDoubleBond(scene: Scene, positions: Positions, a: AtomId, b: AtomId): boolean {
  const sideOfB = sideOfBond(scene, a, b);
  const sideOfA = sideOfBond(scene, b, a);
  const pa = positions.get(a);
  const pb = positions.get(b);
  if (!sideOfA || !sideOfB || !pa || !pb || vlen(vsub(pb, pa)) < 1e-6) return false;
  const axis = vnorm(vsub(pb, pa));
  // The smaller end moves.
  const [pivot, side] = sideOfB.size <= sideOfA.size ? [pb, sideOfB] : [pa, sideOfA];
  for (const id of side) positions.set(id, halfTurn(positions.get(id)!, pivot, axis));
  return true;
}
