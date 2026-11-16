import { getElement } from '../elements';
import type { EvidenceLevel } from '../provenance';
import { fragments, getAdjacency, neighborsOf } from '../scene/queries';
import type { Atom, AtomId, BondId, Scene } from '../types';
import { vdist } from '../vec3';
import { atomCharge, atomLabel, describeAtom, formatCharge } from './atom';
import { idealBondLength } from './bonds';
import { composition, formatFormula } from './formula';
import { analyseValences } from './valence';

export type IssueSeverity = 'error' | 'warning' | 'info';

export type IssueCode =
  | 'valence-exceeded'
  | 'valence-open'
  | 'aromatic-unassignable'
  | 'atoms-overlap'
  | 'bond-stretched'
  | 'bond-compressed'
  | 'unbonded-contact'
  | 'atom-note'
  | 'multiple-fragments'
  | 'net-charge';

export interface ValidationIssue {
  readonly severity: IssueSeverity;
  readonly code: IssueCode;
  readonly message: string;
  readonly atomIds: readonly AtomId[];
  readonly bondIds: readonly BondId[];
  readonly evidence: EvidenceLevel;
  /** A one-click remedy the UI can offer. */
  readonly fix?: 'add-hydrogens';
}

export interface ValidationReport {
  readonly issues: readonly ValidationIssue[];
  readonly errors: number;
  readonly warnings: number;
  readonly infos: number;
  /** True when there are no errors. Warnings and notes do not make a structure invalid. */
  readonly ok: boolean;
  readonly atomCount: number;
  readonly fragmentCount: number;
}

/** Atoms closer than this cannot be distinct nuclei of a molecule (the shortest bond, H-H, is 0.74 angstrom). */
const OVERLAP_DISTANCE = 0.5;
const STRETCH_RATIO = 1.35;
const COMPRESS_RATIO = 0.7;
const CONTACT_SLACK = 0.1;

/** Calls `visit` for every pair of atoms closer than `cutoff`, using a uniform grid so cost stays near-linear. */
function forEachClosePair(scene: Scene, cutoff: number, visit: (a: AtomId, b: AtomId, distance: number) => void): void {
  const atoms = [...scene.atoms.values()];
  const n = atoms.length;
  if (n < 2) return;
  // Cell coordinates of every atom, and the box of cells they occupy.
  const cx = new Int32Array(n);
  const cy = new Int32Array(n);
  const cz = new Int32Array(n);
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let representable = true;
  for (let i = 0; i < n; i++) {
    const p = atoms[i]!.position;
    const x = Math.floor(p[0] / cutoff);
    const y = Math.floor(p[1] / cutoff);
    const z = Math.floor(p[2] / cutoff);
    if (!(Math.abs(x) < 1e9 && Math.abs(y) < 1e9 && Math.abs(z) < 1e9)) representable = false;
    cx[i] = x;
    cy[i] = y;
    cz[i] = z;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  // One spare cell on every side, so that the neighbours of an edge cell have keys of their own.
  const sx = maxX - minX + 3;
  const sy = maxY - minY + 3;
  const sz = maxZ - minZ + 3;
  // A cell is named by one number. Atoms scattered over an absurdly large box would need more
  // cells than a number can tell apart; such scenes take the slower route with text keys.
  if (!representable || sx * sy * sz > 2 ** 50) {
    forEachClosePairSparse(atoms, cutoff, visit);
    return;
  }
  const keyOf = (x: number, y: number, z: number): number => x - minX + 1 + sx * (y - minY + 1 + sy * (z - minZ + 1));
  const cells = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const key = keyOf(cx[i]!, cy[i]!, cz[i]!);
    const cell = cells.get(key);
    if (cell) cell.push(i);
    else cells.set(key, [i]);
  }
  // A cheap squared-distance test rejects almost every candidate; the survivors are measured and
  // judged by `vdist`, exactly as before, so the pairs reported and their distances are unchanged.
  const reach = cutoff * cutoff * (1 + 1e-9);
  for (let i = 0; i < n; i++) {
    const atom = atoms[i]!;
    const p = atom.position;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const cell = cells.get(keyOf(cx[i]! + dx, cy[i]! + dy, cz[i]! + dz));
          if (!cell) continue;
          for (let k = 0; k < cell.length; k++) {
            const j = cell[k]!;
            if (j <= i) continue;
            const q = atoms[j]!.position;
            const ux = p[0] - q[0];
            const uy = p[1] - q[1];
            const uz = p[2] - q[2];
            if (ux * ux + uy * uy + uz * uz > reach) continue;
            const d = vdist(p, q);
            if (d < cutoff) visit(atom.id, atoms[j]!.id, d);
          }
        }
      }
    }
  }
}

/** The same search with text keys for the cells: slower, but indifferent to how far apart the atoms lie. */
function forEachClosePairSparse(atoms: readonly Atom[], cutoff: number, visit: (a: AtomId, b: AtomId, distance: number) => void): void {
  const cells = new Map<string, number[]>();
  const index = (v: number) => Math.floor(v / cutoff);
  atoms.forEach((atom, i) => {
    const key = `${index(atom.position[0])},${index(atom.position[1])},${index(atom.position[2])}`;
    const cell = cells.get(key);
    if (cell) cell.push(i);
    else cells.set(key, [i]);
  });
  atoms.forEach((atom, i) => {
    const cx = index(atom.position[0]);
    const cy = index(atom.position[1]);
    const cz = index(atom.position[2]);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (const j of cells.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
            if (j <= i) continue;
            const d = vdist(atom.position, atoms[j]!.position);
            if (d < cutoff) visit(atom.id, atoms[j]!.id, d);
          }
        }
      }
    }
  });
}

const reportCache = new WeakMap<Scene, ValidationReport>();

/**
 * Rule-based structural checks: valence bookkeeping, aromatic bond assignment, overlapping atoms,
 * implausible bond lengths and per-atom caveats. These are fast screening rules, not a simulation;
 * RDKit sanitisation and geometry optimisation give independent, stronger checks.
 */
export function validateScene(scene: Scene): ValidationReport {
  const cached = reportCache.get(scene);
  if (cached) return cached;

  const issues: ValidationIssue[] = [];
  const name = (id: AtomId) => `${atomLabel(scene.atoms.get(id)!)} (atom ${id})`;
  const valences = analyseValences(scene);

  if (!valences.kekule.ok) {
    issues.push({
      severity: 'error',
      code: 'aromatic-unassignable',
      message: valences.kekule.reason,
      atomIds: valences.kekule.atoms,
      bondIds: [...scene.bonds.values()].filter((b) => b.order === 1.5).map((b) => b.id),
      evidence: 'rule-based',
    });
  }

  for (const info of valences.atoms.values()) {
    const atom = scene.atoms.get(info.atomId)!;
    const element = getElement(atom.protons);
    const charge = atomCharge(atom);
    const species = charge === 0 ? element.name : `${element.name} with charge ${formatCharge(charge)}`;
    if (info.status === 'exceeded') {
      const limit = info.allowed && info.allowed.length > 0 ? Math.max(...info.allowed) : 0;
      issues.push({
        severity: 'error',
        code: 'valence-exceeded',
        message:
          limit === 0
            ? `${name(info.atomId)} has ${info.valence} bond${info.valence === 1 ? '' : 's'}' worth of valence, but ${species} normally forms none.`
            : `${name(info.atomId)} has a total bond order of ${info.valence}; ${species} supports at most ${limit}.`,
        atomIds: [info.atomId],
        bondIds: neighborsOf(scene, info.atomId).map((n) => n.bondId),
        evidence: 'rule-based',
      });
    } else if (info.status === 'open') {
      issues.push({
        severity: 'warning',
        code: 'valence-open',
        message: `${name(info.atomId)} has a total bond order of ${info.valence}, ${info.open} short of the usual ${info.valence + info.open} for ${species}. As drawn it carries ${info.open} unpaired electron${info.open === 1 ? '' : 's'} (a radical) unless hydrogens are added.`,
        atomIds: [info.atomId],
        bondIds: [],
        evidence: 'rule-based',
        fix: 'add-hydrogens',
      });
    }

    for (const note of describeAtom(atom, { bonded: info.degree > 0 }).notes) {
      if (note.severity !== 'warning') continue;
      issues.push({
        severity: 'warning',
        code: 'atom-note',
        message: `${name(info.atomId)}: ${note.message}`,
        atomIds: [info.atomId],
        bondIds: [],
        evidence: note.evidence,
      });
    }
  }

  for (const bond of scene.bonds.values()) {
    const a = scene.atoms.get(bond.a)!;
    const b = scene.atoms.get(bond.b)!;
    const length = vdist(a.position, b.position);
    if (length < OVERLAP_DISTANCE) continue;
    const typical = idealBondLength(a.protons, b.protons, bond.order);
    const ratio = length / typical;
    if (ratio > STRETCH_RATIO || ratio < COMPRESS_RATIO) {
      issues.push({
        severity: 'warning',
        code: ratio > STRETCH_RATIO ? 'bond-stretched' : 'bond-compressed',
        message: `The bond between ${name(bond.a)} and ${name(bond.b)} is ${length.toFixed(2)} Å long; a typical value is about ${typical.toFixed(2)} Å.`,
        atomIds: [bond.a, bond.b],
        bondIds: [bond.id],
        evidence: 'rule-based',
      });
    }
  }

  let maxRadius = 0;
  for (const atom of scene.atoms.values()) maxRadius = Math.max(maxRadius, getElement(atom.protons).covalentRadius);
  const contacts: Array<[AtomId, AtomId]> = [];
  if (scene.atoms.size > 1) {
    const adjacency = getAdjacency(scene);
    const bonded = (a: AtomId, b: AtomId): boolean => {
      const neighbors = adjacency.get(a);
      if (!neighbors) return false;
      for (let k = 0; k < neighbors.length; k++) if (neighbors[k]!.atomId === b) return true;
      return false;
    };
    forEachClosePair(scene, Math.max(OVERLAP_DISTANCE, 2 * maxRadius + CONTACT_SLACK), (a, b, d) => {
      if (d < OVERLAP_DISTANCE) {
        issues.push({
          severity: 'error',
          code: 'atoms-overlap',
          message: `${name(a)} and ${name(b)} are only ${d.toFixed(2)} Å apart, closer than any two nuclei in a molecule can be.`,
          atomIds: [a, b],
          bondIds: [],
          evidence: 'rule-based',
        });
        return;
      }
      if (bonded(a, b)) return;
      const ra = getElement(scene.atoms.get(a)!.protons).covalentRadius;
      const rb = getElement(scene.atoms.get(b)!.protons).covalentRadius;
      if (d < ra + rb + CONTACT_SLACK) contacts.push([a, b]);
    });
  }
  if (contacts.length > 0) {
    const [a, b] = contacts[0]!;
    issues.push({
      severity: 'info',
      code: 'unbonded-contact',
      message:
        contacts.length === 1
          ? `${name(a)} and ${name(b)} are within typical bonding distance but are not bonded.`
          : `${contacts.length} pairs of atoms are within typical bonding distance but are not bonded (for example ${name(a)} and ${name(b)}).`,
      atomIds: [...new Set(contacts.flat())],
      bondIds: [],
      evidence: 'rule-based',
    });
  }

  const parts = fragments(scene);
  if (parts.length > 1) {
    issues.push({
      severity: 'info',
      code: 'multiple-fragments',
      message: `The workspace holds ${parts.length} separate molecules or lone atoms.`,
      atomIds: [],
      bondIds: [],
      evidence: 'rule-based',
    });
  }
  const total = composition(scene);
  if (total.charge !== 0) {
    issues.push({
      severity: 'info',
      code: 'net-charge',
      message: `The structure ${formatFormula(total)} carries a net charge of ${formatCharge(total.charge)}.`,
      atomIds: [...scene.atoms.values()].filter((a) => atomCharge(a) !== 0).map((a) => a.id),
      bondIds: [],
      evidence: 'rule-based',
    });
  }

  const order: Record<IssueSeverity, number> = { error: 0, warning: 1, info: 2 };
  issues.sort((x, y) => order[x.severity] - order[y.severity]);
  const count = (s: IssueSeverity) => issues.filter((i) => i.severity === s).length;
  const report: ValidationReport = {
    issues,
    errors: count('error'),
    warnings: count('warning'),
    infos: count('info'),
    ok: count('error') === 0,
    atomCount: scene.atoms.size,
    fragmentCount: parts.length,
  };
  reportCache.set(scene, report);
  return report;
}
