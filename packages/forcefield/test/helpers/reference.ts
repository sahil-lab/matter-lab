/**
 * Loader and small geometry helpers for the RDKit reference fixture
 * (`fixtures/uff_reference.json`, written by `tools/gen_uff_reference.py`).
 */
import { readFileSync } from 'node:fs';
import type { FfBond, FfMolecule } from '../../src';

export interface RefPerception {
  hybridization: string[];
  totalValence: number[];
  radicalElectrons: number[];
  aromaticAtoms: number[];
  conjugatedBonds: number[];
  inRing3: number[];
  inRing4: number[];
  fragments: number[];
}

export interface RefBase {
  name: string;
  smiles: string;
  classes: string[];
  formula: string;
  nAtoms: number;
  z: number[];
  formalCharge: number[];
  bonds: [number, number, number][];
  embedMethod: string;
  coords: number[];
  perception: RefPerception;
  typerLog: string[];
  source?: string;
}

export interface RefHessian {
  finite: boolean;
  step?: number;
  /** kcal/mol/angstrom^2; clearly negative means a saddle point */
  lowestEigenvalue?: number;
  highestEigenvalue?: number;
  numBelowMinus0p01?: number;
}

export interface RefOptimized {
  converged: boolean;
  calls: number;
  energy: number;
  coords: number[];
  rmsGradient: number;
  maxGradient: number;
  hessian: RefHessian;
}

export interface RefPolished {
  method: string;
  iterations: number;
  stopped: string;
  energy: number;
  coords: number[];
  rmsGradient: number;
  maxGradient: number;
  hessian: RefHessian;
}

export interface RefMolecule extends RefBase {
  numRotatableBonds: number;
  rigid: boolean;
  energy: number;
  gradient: number[];
  perturbed: { coords: number[]; energy: number; gradient: number[] };
  params: {
    bondStretch: [number, number, number, number][];
    angleBend: [number, number, number, number, number][];
    torsion: [number, number, number, number, number | null][];
    inversion: [number, number, number, number, number | null][];
    vdw: [number, number, number, number][];
    vdwSampled: boolean;
  };
  /** Per atom: the UFF atom types consistent with every parameter RDKit reports (normally exactly one). */
  uffLabelCandidates: string[][];
  /** [atom index, label] pairs that RDKit's own unit test asserts for this SMILES. */
  rdkitTestLabels?: [number, string][];
  optimized: RefOptimized;
  polished: RefPolished;
  contractRoundTrip: { ok: boolean; reason?: string; energyDifference?: number };
}

export interface RefUnsupported extends RefBase {
  unrecognized: { atomIndex: number; label: string }[];
}

export interface RefDistorted {
  name: string;
  molecule: string;
  description: string;
  coords: number[];
  energy: number;
  gradient: number[] | null;
  rdkitGradientNonFiniteAtoms?: number[];
}

export interface Reference {
  meta: {
    generator: string;
    rdkitVersion: string;
    numpyVersion: string;
    pythonVersion: string;
    platform: string;
    generated: string;
    embedding: { method: string; randomSeed: number };
    uffSettings: { vdwThresh: number; ignoreInterfragInteractions: boolean };
    perturbation: { amplitudeAngstrom: number; distribution: string };
    units: Record<string, string>;
    counts: { supported: number; unsupported: number; distorted: number };
    notes: string[];
  };
  molecules: RefMolecule[];
  distorted: RefDistorted[];
  unsupported: RefUnsupported[];
}

let cached: Reference | undefined;

export function loadReference(): Reference {
  cached ??= JSON.parse(readFileSync(new URL('../fixtures/uff_reference.json', import.meta.url), 'utf8')) as Reference;
  return cached;
}

export function findMolecule(name: string): RefMolecule {
  const found = loadReference().molecules.find((m) => m.name === name);
  if (!found) throw new Error(`Reference molecule "${name}" is not in the fixture.`);
  return found;
}

/** The molecule exactly as the package's input contract describes it, at the given coordinates. */
export function toMolecule(rec: Pick<RefBase, 'z' | 'formalCharge' | 'bonds'>, coords: ArrayLike<number>): FfMolecule {
  return {
    atoms: rec.z.map((z, i) => ({
      z,
      formalCharge: rec.formalCharge[i],
      position: [coords[3 * i], coords[3 * i + 1], coords[3 * i + 2]] as const,
    })),
    bonds: rec.bonds.map(([a, b, order]) => ({ a, b, order: order as FfBond['order'] })),
  };
}

export function distance(x: ArrayLike<number>, i: number, j: number): number {
  return Math.hypot(x[3 * i] - x[3 * j], x[3 * i + 1] - x[3 * j + 1], x[3 * i + 2] - x[3 * j + 2]);
}

/** Angle i-j-k in degrees. */
export function angleDeg(x: ArrayLike<number>, i: number, j: number, k: number): number {
  const ax = x[3 * i] - x[3 * j];
  const ay = x[3 * i + 1] - x[3 * j + 1];
  const az = x[3 * i + 2] - x[3 * j + 2];
  const bx = x[3 * k] - x[3 * j];
  const by = x[3 * k + 1] - x[3 * j + 1];
  const bz = x[3 * k + 2] - x[3 * j + 2];
  const cos = (ax * bx + ay * by + az * bz) / (Math.hypot(ax, ay, az) * Math.hypot(bx, by, bz));
  return (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
}

/** Signed dihedral i-j-k-l in degrees, in (-180, 180]. */
export function dihedralDeg(x: ArrayLike<number>, i: number, j: number, k: number, l: number): number {
  const b1 = [x[3 * j] - x[3 * i], x[3 * j + 1] - x[3 * i + 1], x[3 * j + 2] - x[3 * i + 2]];
  const b2 = [x[3 * k] - x[3 * j], x[3 * k + 1] - x[3 * j + 1], x[3 * k + 2] - x[3 * j + 2]];
  const b3 = [x[3 * l] - x[3 * k], x[3 * l + 1] - x[3 * k + 1], x[3 * l + 2] - x[3 * k + 2]];
  const cross = (u: number[], v: number[]): number[] => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const dot = (u: number[], v: number[]): number => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const n1 = cross(b1, b2);
  const n2 = cross(b2, b3);
  const m = cross(n1, b2);
  const b2len = Math.hypot(b2[0], b2[1], b2[2]);
  return (Math.atan2(dot(m, n2) / b2len, dot(n1, n2)) * 180) / Math.PI;
}

/** All bond angles i-j-k of a molecule (each once), from its bond list. */
export function angleTriples(rec: Pick<RefBase, 'nAtoms' | 'bonds'>): [number, number, number][] {
  const nbrs: number[][] = Array.from({ length: rec.nAtoms }, () => []);
  for (const [a, b] of rec.bonds) {
    nbrs[a].push(b);
    nbrs[b].push(a);
  }
  const out: [number, number, number][] = [];
  for (let j = 0; j < rec.nAtoms; j++) {
    for (let p = 0; p < nbrs[j].length; p++) {
      for (let q = p + 1; q < nbrs[j].length; q++) out.push([nbrs[j][p], j, nbrs[j][q]]);
    }
  }
  return out;
}

/** Largest absolute value in an array (0 for an empty array). */
export function maxAbs(values: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < values.length; i++) m = Math.max(m, Math.abs(values[i]));
  return m;
}

export function rms(values: ArrayLike<number>): number {
  if (values.length === 0) return 0;
  let s = 0;
  for (let i = 0; i < values.length; i++) s += values[i] * values[i];
  return Math.sqrt(s / values.length);
}
