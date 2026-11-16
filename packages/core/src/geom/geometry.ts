import { fragmentOf, sideOfBond } from '../scene/queries';
import type { SceneEditor } from '../scene/editor';
import type { AtomId, Vec3 } from '../types';
import { vadd, vangle, vcross, vdist, vdot, vlen, vnorm, vperp, vrotateAbout, vscale, vsub } from '../vec3';

const DEG = 180 / Math.PI;

/** Angle a-b-c at the middle point, in degrees (0-180). */
export function angleDegrees(a: Vec3, b: Vec3, c: Vec3): number {
  return vangle(vsub(a, b), vsub(c, b)) * DEG;
}

/**
 * Dihedral (torsion) angle a-b-c-d in degrees, in (-180, 180]. IUPAC sign convention: looking along
 * b -> c, a clockwise turn from a to d is positive.
 */
export function dihedralDegrees(a: Vec3, b: Vec3, c: Vec3, d: Vec3): number {
  const b1 = vsub(b, a);
  const b2 = vsub(c, b);
  const b3 = vsub(d, c);
  const n1 = vcross(b1, b2);
  const n2 = vcross(b2, b3);
  const y = vlen(b2) * vdot(b1, n2);
  const x = vdot(n1, n2);
  return Math.atan2(y, x) * DEG;
}

export type MeasurementKind = 'distance' | 'angle' | 'dihedral';

export interface Measurement {
  readonly kind: MeasurementKind;
  readonly value: number;
  readonly unit: 'Å' | '°';
}

/** Measures between 2 (distance), 3 (angle) or 4 (dihedral) points; `null` for any other count. */
export function measurePoints(points: readonly Vec3[]): Measurement | null {
  if (points.length === 2) return { kind: 'distance', value: vdist(points[0]!, points[1]!), unit: 'Å' };
  if (points.length === 3) return { kind: 'angle', value: angleDegrees(points[0]!, points[1]!, points[2]!), unit: '°' };
  if (points.length === 4) {
    return { kind: 'dihedral', value: dihedralDegrees(points[0]!, points[1]!, points[2]!, points[3]!), unit: '°' };
  }
  return null;
}

export type GeometryEditResult = { readonly ok: true; readonly moved: number } | { readonly ok: false; readonly reason: string };

export function translateAtoms(editor: SceneEditor, ids: Iterable<AtomId>, delta: Vec3): void {
  for (const id of ids) editor.moveAtom(id, vadd(editor.getAtom(id).position, delta));
}

/** Rotates atoms about the line through `origin` along `axis` (need not be normalised) by `angle` radians. */
export function rotateAtoms(editor: SceneEditor, ids: Iterable<AtomId>, origin: Vec3, axis: Vec3, angle: number): void {
  const unit = vnorm(axis);
  for (const id of ids) editor.moveAtom(id, vrotateAbout(editor.getAtom(id).position, origin, unit, angle));
}

/**
 * Sets the distance between atoms `a` and `b` by sliding `b` along the line a -> b. Everything
 * attached to `b` moves with it when that part of the molecule can be separated (the bond is not in
 * a ring, or the atoms belong to different molecules); otherwise only `b` moves.
 */
export function setDistance(editor: SceneEditor, a: AtomId, b: AtomId, target: number): GeometryEditResult {
  if (!(target > 0) || !Number.isFinite(target)) return { ok: false, reason: 'The distance must be a positive number.' };
  if (a === b) return { ok: false, reason: 'Pick two different atoms.' };
  const pa = editor.getAtom(a).position;
  const pb = editor.getAtom(b).position;
  const current = vdist(pa, pb);
  const direction = current > 1e-9 ? vscale(vsub(pb, pa), 1 / current) : ([1, 0, 0] as Vec3);
  const scene = editor.snapshot();

  let moving: Set<AtomId>;
  if (editor.findBond(a, b)) moving = sideOfBond(scene, a, b) ?? new Set([b]);
  else {
    const fragment = fragmentOf(scene, b);
    moving = fragment.has(a) ? new Set([b]) : fragment;
  }
  translateAtoms(editor, moving, vscale(direction, target - current));
  return { ok: true, moved: moving.size };
}

/**
 * Sets the angle a-b-c by rotating `c` (and whatever is attached beyond it, when separable) about
 * the axis through `b` perpendicular to the plane of the three atoms.
 */
export function setAngle(editor: SceneEditor, a: AtomId, b: AtomId, c: AtomId, targetDegrees: number): GeometryEditResult {
  if (!(targetDegrees >= 0 && targetDegrees <= 180)) return { ok: false, reason: 'The angle must be between 0° and 180°.' };
  if (new Set([a, b, c]).size !== 3) return { ok: false, reason: 'Pick three different atoms.' };
  const pa = editor.getAtom(a).position;
  const pb = editor.getAtom(b).position;
  const pc = editor.getAtom(c).position;
  const u = vsub(pa, pb);
  const v = vsub(pc, pb);
  if (vlen(u) < 1e-9 || vlen(v) < 1e-9) return { ok: false, reason: 'Two of the atoms are at the same position.' };

  let axis = vcross(u, v);
  if (vlen(axis) < 1e-9 * vlen(u) * vlen(v)) axis = vperp(u);
  const current = vangle(u, v) * DEG;

  const scene = editor.snapshot();
  let moving = new Set<AtomId>([c]);
  if (editor.findBond(b, c)) {
    const side = sideOfBond(scene, b, c);
    if (side && !side.has(a)) moving = side;
  }
  rotateAtoms(editor, moving, pb, axis, (targetDegrees - current) / DEG);
  return { ok: true, moved: moving.size };
}

/**
 * Sets the dihedral angle a-b-c-d by rotating everything on the `c` side of the b-c bond about the
 * b -> c axis, which changes the conformation without distorting bond lengths or angles. When b-c is
 * part of a ring only the `d` branch is rotated.
 */
export function setDihedral(
  editor: SceneEditor,
  a: AtomId,
  b: AtomId,
  c: AtomId,
  d: AtomId,
  targetDegrees: number,
): GeometryEditResult {
  if (!Number.isFinite(targetDegrees)) return { ok: false, reason: 'The dihedral angle must be a number.' };
  if (new Set([a, b, c, d]).size !== 4) return { ok: false, reason: 'Pick four different atoms.' };
  const pa = editor.getAtom(a).position;
  const pb = editor.getAtom(b).position;
  const pc = editor.getAtom(c).position;
  const pd = editor.getAtom(d).position;
  const axis = vsub(pc, pb);
  if (vlen(axis) < 1e-9) return { ok: false, reason: 'The two central atoms are at the same position.' };
  if (vlen(vcross(vsub(pb, pa), axis)) < 1e-9 || vlen(vcross(axis, vsub(pd, pc))) < 1e-9) {
    return { ok: false, reason: 'The dihedral angle is undefined because three of the atoms lie on a straight line.' };
  }

  const scene = editor.snapshot();
  let moving: Set<AtomId> | null = null;
  if (editor.findBond(b, c)) {
    const side = sideOfBond(scene, b, c);
    if (side && !side.has(a)) moving = side;
  }
  if (!moving) {
    const branch = editor.findBond(c, d) ? sideOfBond(scene, c, d) : null;
    moving = branch && !branch.has(a) && !branch.has(b) ? branch : new Set([d]);
  }

  let delta = targetDegrees - dihedralDegrees(pa, pb, pc, pd);
  delta = ((((delta + 180) % 360) + 360) % 360) - 180;
  rotateAtoms(editor, moving, pb, axis, delta / DEG);
  return { ok: true, moved: moving.size };
}
