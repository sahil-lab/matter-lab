import { getElement } from '../elements';
import type { SceneEditor } from '../scene/editor';
import type { AtomId, Vec3 } from '../types';
import { ZERO3, vadd, vangle, vcross, vdot, vlen, vnorm, vperp, vrotate, vscale, vsub } from '../vec3';
import { atomCharge } from './atom';
import { idealBondLength } from './bonds';
import { analyseValences } from './valence';

const TETRAHEDRAL_HALF_ANGLE = Math.acos(-1 / 3) / 2;

const CANONICAL: Readonly<Record<number, readonly Vec3[]>> = {
  1: [[1, 0, 0]],
  2: [
    [1, 0, 0],
    [-1, 0, 0],
  ],
  3: [
    [0, 1, 0],
    [-Math.sqrt(3) / 2, -0.5, 0],
    [Math.sqrt(3) / 2, -0.5, 0],
  ],
  4: [
    [1, 1, 1],
    [1, -1, -1],
    [-1, 1, -1],
    [-1, -1, 1],
  ].map((v) => vnorm(v as unknown as Vec3)),
  5: [
    [0, 1, 0],
    [-Math.sqrt(3) / 2, -0.5, 0],
    [Math.sqrt(3) / 2, -0.5, 0],
    [0, 0, 1],
    [0, 0, -1],
  ],
  6: [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ],
};

/** Spreads `free` extra points over the unit sphere so that all points repel each other, keeping `fixed` in place. */
/** Evenly spread candidate directions (Fibonacci sphere) used to seed the placement below. */
const CANDIDATES: readonly Vec3[] = (() => {
  const n = 256;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const points: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - y * y);
    points.push([Math.cos(golden * i) * r, y, Math.sin(golden * i) * r]);
  }
  return points;
})();

/** Spreads `free` extra points over the unit sphere so that all points repel each other, keeping `fixed` in place. */
function repel(fixed: readonly Vec3[], free: number): Vec3[] {
  // Seed each point as far as possible from everything placed so far. Starting in the right basin
  // matters: plain descent from arbitrary seeds can leave two points stuck on the same side.
  const points: Vec3[] = [];
  for (let i = 0; i < free; i++) {
    let best = CANDIDATES[0]!;
    let bestGap = -Infinity;
    for (const candidate of CANDIDATES) {
      let gap = Infinity;
      for (const other of fixed) gap = Math.min(gap, vangle(candidate, other));
      for (const other of points) gap = Math.min(gap, vangle(candidate, other));
      if (gap > bestGap) {
        bestGap = gap;
        best = candidate;
      }
    }
    points.push(best);
  }
  let step = 0.25;
  for (let iter = 0; iter < 300; iter++) {
    for (let i = 0; i < points.length; i++) {
      let force: Vec3 = ZERO3;
      const others = [...fixed, ...points.filter((_, j) => j !== i)];
      for (const o of others) {
        const d = vsub(points[i]!, o);
        const r = Math.max(vlen(d), 1e-3);
        force = vadd(force, vscale(d, 1 / (r * r * r)));
      }
      const tangential = vsub(force, vscale(points[i]!, vdot(force, points[i]!)));
      points[i] = vnorm(vadd(points[i]!, vscale(tangential, step)));
    }
    step *= 0.985;
  }
  return points;
}

/**
 * Directions (unit vectors) for `count` new substituents on an atom whose electron domains adopt
 * the ideal VSEPR arrangement for `stericNumber` (2 linear, 3 trigonal planar, 4 tetrahedral,
 * 5 trigonal bipyramidal, 6 octahedral), given unit vectors to the neighbours it already has.
 *
 * `reference` is a vector perpendicular to the single existing bond that marks where the
 * neighbour's own substituents point; it is used to stagger tetrahedral centres and to keep trigonal
 * centres coplanar.
 */
export function substituentDirections(
  stericNumber: number,
  existing: readonly Vec3[],
  count: number,
  reference: Vec3 | null = null,
): Vec3[] {
  if (count <= 0) return [];
  const sn = Math.min(6, Math.max(1, Math.max(stericNumber, existing.length + count)));

  if (existing.length === 0) return CANONICAL[sn]!.slice(0, count);

  const v1 = existing[0]!;
  if (existing.length === 1) {
    if (sn <= 2) return [vscale(v1, -1)];
    if (sn === 3) {
      const p = reference && vlen(reference) > 1e-6 ? vnorm(reference) : vperp(v1);
      const dirs = [vadd(vscale(v1, -0.5), vscale(p, Math.sqrt(3) / 2)), vadd(vscale(v1, -0.5), vscale(p, -Math.sqrt(3) / 2))];
      return dirs.slice(0, count);
    }
    if (sn === 4) {
      const p = reference && vlen(reference) > 1e-6 ? vscale(vnorm(reference), -1) : vperp(v1);
      const dirs: Vec3[] = [];
      for (let k = 0; k < 3; k++) {
        const radial = vrotate(p, v1, (k * 2 * Math.PI) / 3);
        dirs.push(vnorm(vadd(vscale(v1, -1 / 3), vscale(radial, (2 * Math.SQRT2) / 3))));
      }
      return dirs.slice(0, count);
    }
  } else if (existing.length === 2) {
    const v2 = existing[1]!;
    const sum = vadd(v1, v2);
    const normal = vcross(v1, v2);
    if (vlen(sum) > 1e-3 && vlen(normal) > 1e-3) {
      const bisector = vscale(vnorm(sum), -1);
      if (sn === 3) return [bisector];
      if (sn === 4) {
        const n = vnorm(normal);
        const c = Math.cos(TETRAHEDRAL_HALF_ANGLE);
        const s = Math.sin(TETRAHEDRAL_HALF_ANGLE);
        return [vadd(vscale(bisector, c), vscale(n, s)), vadd(vscale(bisector, c), vscale(n, -s))].slice(0, count);
      }
    }
  } else if (existing.length === 3 && sn === 4) {
    const sum = vadd(vadd(v1, existing[1]!), existing[2]!);
    if (vlen(sum) > 0.05) return [vscale(vnorm(sum), -1)];
    return [vnorm(vcross(vsub(existing[1]!, v1), vsub(existing[2]!, v1)))];
  }

  return repel(existing, Math.max(count, sn - existing.length)).slice(0, count);
}

export interface HydrogenPlan {
  readonly atomId: AtomId;
  readonly positions: readonly Vec3[];
}

/**
 * Adds explicit hydrogens to every listed atom (all atoms when `atomIds` is omitted) that has an
 * open valence, placing them at ideal VSEPR positions and typical X-H bond lengths. Atoms whose
 * valence is unconstrained (most metals) are left alone. Returns the ids of the new hydrogens.
 *
 * The placement is a rule-based starting geometry, not an optimised structure.
 */
export function addHydrogens(editor: SceneEditor, atomIds?: Iterable<AtomId>): AtomId[] {
  const analysis = analyseValences(editor.snapshot());
  const targets = atomIds ? [...atomIds] : [...analysis.atoms.keys()];
  const added: AtomId[] = [];

  for (const atomId of targets.sort((a, b) => a - b)) {
    const info = analysis.atoms.get(atomId);
    if (!info || info.status !== 'open' || info.open <= 0) continue;
    const atom = editor.getAtom(atomId);
    const element = getElement(atom.protons);

    const neighbours = editor.neighborsOf(atomId);
    const existing = neighbours
      .map((id) => vsub(editor.getAtom(id).position, atom.position))
      .filter((d) => vlen(d) > 1e-6)
      .map(vnorm);

    const targetValence = info.valence + info.open;
    const lonePairs = Math.max(0, Math.floor((element.outerElectrons - atomCharge(atom) - targetValence) / 2));
    const stericNumber = neighbours.length + info.open + lonePairs;

    let reference: Vec3 | null = null;
    if (existing.length === 1 && neighbours.length === 1) {
      const neighbourId = neighbours[0]!;
      const neighbour = editor.getAtom(neighbourId);
      const axis = existing[0]!;
      for (const otherId of editor.neighborsOf(neighbourId).sort((a, b) => a - b)) {
        if (otherId === atomId) continue;
        const r = vsub(editor.getAtom(otherId).position, neighbour.position);
        const perpendicular = vsub(r, vscale(axis, vdot(r, axis)));
        if (vlen(perpendicular) > 1e-3) {
          reference = perpendicular;
          break;
        }
      }
    }

    const length = idealBondLength(atom.protons, 1, 1);
    for (const direction of substituentDirections(stericNumber, existing, info.open, reference)) {
      const hydrogen = editor.addAtom({ protons: 1, position: vadd(atom.position, vscale(direction, length)) });
      editor.addBond(atomId, hydrogen, 1);
      added.push(hydrogen);
    }
  }
  return added;
}

/**
 * Brings the hydrogens on the given heavy atoms in line with their valence after an edit, without
 * disturbing hydrogens that can stay: over-bonded atoms give up just enough terminal hydrogens
 * (those nearest the newest substituent first), and open valences are then refilled at ideal
 * positions. This is what keeps a molecule chemically complete while it is being built.
 */
export function adjustHydrogens(editor: SceneEditor, atomIds: Iterable<AtomId>): void {
  const targets = [...new Set(atomIds)].filter((id) => editor.hasAtom(id) && editor.getAtom(id).protons !== 1);
  if (targets.length === 0) return;
  const analysis = analyseValences(editor.snapshot());
  const isTerminalHydrogen = (id: AtomId) => editor.getAtom(id).protons === 1 && editor.neighborsOf(id).length === 1;

  for (const atomId of targets) {
    const info = analysis.atoms.get(atomId);
    if (!info || info.status !== 'exceeded' || !info.allowed || info.allowed.length === 0) continue;
    let excess = info.valence - Math.max(...info.allowed);
    const neighbours = editor.neighborsOf(atomId);
    const hydrogens = neighbours.filter(isTerminalHydrogen);
    if (hydrogens.length === 0) continue;

    const others = neighbours.filter((id) => !isTerminalHydrogen(id));
    const newest = others.length > 0 ? editor.getAtom(Math.max(...others)).position : null;
    const center = editor.getAtom(atomId).position;
    const byProximity = hydrogens
      .map((id) => {
        const direction = vsub(editor.getAtom(id).position, center);
        const angle = newest ? vangle(direction, vsub(newest, center)) : 0;
        return { id, angle };
      })
      .sort((a, b) => a.angle - b.angle || b.id - a.id);
    for (const h of byProximity) {
      if (excess <= 0) break;
      editor.removeAtom(h.id);
      excess--;
    }
  }
  addHydrogens(editor, targets);
}

/**
 * Removes terminal hydrogens (hydrogen atoms with exactly one bond). When `atomIds` is given, only
 * hydrogens attached to those atoms, or listed themselves, are removed. Returns how many were removed.
 */
export function removeHydrogens(editor: SceneEditor, atomIds?: Iterable<AtomId>): number {
  const scope = atomIds ? new Set(atomIds) : null;
  const doomed: AtomId[] = [];
  for (const atom of editor.allAtoms()) {
    if (atom.protons !== 1) continue;
    const neighbours = editor.neighborsOf(atom.id);
    if (neighbours.length !== 1) continue;
    if (scope && !scope.has(atom.id) && !scope.has(neighbours[0]!)) continue;
    // Keep H2 intact: a hydrogen whose only neighbour is another hydrogen is not a substituent.
    if (editor.getAtom(neighbours[0]!).protons === 1) continue;
    doomed.push(atom.id);
  }
  for (const id of doomed) editor.removeAtom(id);
  return doomed.length;
}
