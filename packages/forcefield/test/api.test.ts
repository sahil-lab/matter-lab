/**
 * The package boundary: the public API is the one that was specified (checked by the compiler and
 * at run time), `src/` uses nothing that a Web Worker does not have, and the one place where the
 * port deliberately computes more than RDKit (torsions beyond RDKit's first 1000 torsion bonds) is
 * pinned down against RDKit's own numbers.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Provenance } from '@matterlab/core';
import * as api from '../src';
import { evaluate } from '../src/energy';
import { systemData } from '../src/system';
import { findMolecule, loadReference, toMolecule } from './helpers/reference';
import { publish } from './helpers/report';

// ------------------------------------------------------------------------------------------------
// The API as specified, verbatim. `tsc --noEmit -p packages/forcefield` fails if the exports of
// src/index.ts are not identical to it (the test directory is part of the project).
// ------------------------------------------------------------------------------------------------
declare namespace Spec {
  interface FfAtom { readonly z: number; readonly formalCharge: number; /** angstrom */ readonly position: readonly [number, number, number]; }
  interface FfBond { readonly a: number; readonly b: number; readonly order: 1 | 1.5 | 2 | 3; } // a, b are atom indices
  interface FfMolecule { readonly atoms: readonly FfAtom[]; readonly bonds: readonly FfBond[]; }

  class UnsupportedForceFieldError extends Error { readonly problems: readonly { atomIndex: number; reason: string }[]; }

  /** kcal/mol */
  interface UffEnergyTerms { readonly bondStretch: number; readonly angleBend: number; readonly torsion: number; readonly inversion: number; readonly vanDerWaals: number; readonly total: number; }

  interface UffSystem { readonly nAtoms: number; readonly atomTypes: readonly string[]; /* UFF labels, e.g. 'C_3', 'O_R' */ readonly termCounts: { readonly bonds: number; readonly angles: number; readonly torsions: number; readonly inversions: number; readonly vdwPairs: number }; }
  function createUffSystem(mol: FfMolecule): UffSystem; // throws UnsupportedForceFieldError
  function uffEnergy(system: UffSystem, positions: Float64Array): UffEnergyTerms; // positions = xyz triples, angstrom
  /** Writes dE/dx (kcal/mol/angstrom) into `gradient` and returns the total energy. */
  function uffEnergyAndGradient(system: UffSystem, positions: Float64Array, gradient: Float64Array): number;

  interface OptimizeStep { readonly step: number; readonly energy: number; readonly rmsGradient: number; readonly maxGradient: number; /** live view; copy it if you keep it */ readonly positions: Float64Array; }
  interface OptimizeOptions {
    readonly maxSteps?: number;             // default 2000
    readonly gradientTolerance?: number;    // RMS gradient, kcal/mol/angstrom
    readonly energyTolerance?: number;      // kcal/mol between steps
    readonly frozenAtoms?: readonly number[];
    readonly recordTrajectoryEvery?: number; // 0/undefined = no trajectory
    readonly onStep?: (step: OptimizeStep) => boolean | void; // return false to cancel
  }
  interface OptimizeResult {
    readonly method: 'UFF';
    readonly converged: boolean;
    readonly cancelled: boolean;
    readonly steps: number;
    readonly initialEnergy: number;
    readonly finalEnergy: number;
    readonly energyTerms: UffEnergyTerms;
    readonly rmsGradient: number;
    readonly maxGradient: number;
    readonly positions: Float64Array;
    readonly rmsDisplacement: number;       // RMS atomic displacement from the starting geometry, angstrom (no alignment)
    readonly trajectory: readonly Float32Array[];
    readonly atomTypes: readonly string[];
    readonly warnings: readonly string[];
    readonly elapsedMs: number;
    readonly provenance: Provenance;        // 'UFF as implemented in RDKit <version>, ported to TypeScript', with literature citations
  }
  function optimizeUff(mol: FfMolecule, options?: OptimizeOptions): OptimizeResult; // throws UnsupportedForceFieldError
}

/** True only if A and B are the same type (modifiers such as `readonly` and `?` included). */
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

export type ApiConformsToSpecification = [
  Assert<Same<api.FfAtom, Spec.FfAtom>>,
  Assert<Same<api.FfBond, Spec.FfBond>>,
  Assert<Same<api.FfMolecule, Spec.FfMolecule>>,
  Assert<Same<api.UffEnergyTerms, Spec.UffEnergyTerms>>,
  Assert<Same<api.UffSystem, Spec.UffSystem>>,
  Assert<Same<api.OptimizeStep, Spec.OptimizeStep>>,
  Assert<Same<api.OptimizeOptions, Spec.OptimizeOptions>>,
  Assert<Same<api.OptimizeResult, Spec.OptimizeResult>>,
  Assert<Same<api.UnsupportedForceFieldError, Spec.UnsupportedForceFieldError>>,
  Assert<Same<typeof api.createUffSystem, typeof Spec.createUffSystem>>,
  Assert<Same<typeof api.uffEnergy, typeof Spec.uffEnergy>>,
  Assert<Same<typeof api.uffEnergyAndGradient, typeof Spec.uffEnergyAndGradient>>,
  Assert<Same<typeof api.optimizeUff, typeof Spec.optimizeUff>>,
];

/** The comparison above is not vacuous: each of these must be rejected by the compiler. */
export type ConformanceCheckHasTeeth = [
  // @ts-expect-error a dropped `readonly` is a difference
  Assert<Same<{ readonly a: number }, { a: number }>>,
  // @ts-expect-error a dropped `?` is a difference
  Assert<Same<{ a?: number }, { a: number }>>,
  // @ts-expect-error a wider type is a difference
  Assert<Same<{ readonly order: 1 | 1.5 | 2 | 3 }, { readonly order: number }>>,
  // @ts-expect-error an extra member is a difference
  Assert<Same<Spec.UffSystem, Spec.UffSystem & { readonly extra: number }>>,
  // @ts-expect-error a different signature is a difference
  Assert<Same<typeof Spec.optimizeUff, (mol: Spec.FfMolecule) => Spec.OptimizeResult>>,
];

describe('public API', () => {
  it('exports the specified functions and error class, plus documented extras', () => {
    expect(Object.keys(api).sort()).toEqual(
      [
        // specified
        'UnsupportedForceFieldError',
        'createUffSystem',
        'optimizeUff',
        'uffEnergy',
        'uffEnergyAndGradient',
        // additional
        'DEFAULT_ENERGY_TOLERANCE',
        'DEFAULT_GRADIENT_TOLERANCE',
        'DEFAULT_MAX_STEPS',
        'RDKIT_VERSION',
        'perceiveUffMolecule',
        'uffParameterLookup',
        'uffSystemWarnings',
      ].sort(),
    );
    // The defaults that are exported are the ones the optimiser documents and uses.
    expect([api.DEFAULT_MAX_STEPS, api.DEFAULT_GRADIENT_TOLERANCE, api.DEFAULT_ENERGY_TOLERANCE]).toEqual([2000, 1e-4, 1e-6]);
    for (const name of ['createUffSystem', 'optimizeUff', 'uffEnergy', 'uffEnergyAndGradient'] as const) {
      expect(typeof api[name]).toBe('function');
    }
    expect(api.createUffSystem).toHaveLength(1);
    expect(api.uffEnergy).toHaveLength(2);
    expect(api.uffEnergyAndGradient).toHaveLength(3);
  });

  it('UnsupportedForceFieldError is an Error that lists atom indices and reasons as plain data', () => {
    const helium: api.FfMolecule = { atoms: [{ z: 2, formalCharge: 0, position: [0, 0, 0] }], bonds: [] };
    let caught: unknown;
    try {
      api.createUffSystem(helium);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(api.UnsupportedForceFieldError);
    expect(caught).toBeInstanceOf(Error);
    const err = caught as api.UnsupportedForceFieldError;
    expect(err.name).toBe('UnsupportedForceFieldError');
    expect(err.problems).toEqual([{ atomIndex: 0, reason: expect.stringContaining('He') }]);
    expect(err.message).toContain(err.problems[0].reason);
    expect(structuredClone(err.problems)).toEqual(err.problems);
    // optimizeUff refuses the same molecule the same way, before doing anything
    expect(() => api.optimizeUff(helium)).toThrow(api.UnsupportedForceFieldError);
  });

  it('never returns a guessed result for an unsupported molecule', () => {
    const ref = loadReference();
    for (const u of ref.unsupported) {
      const mol = toMolecule(u, u.coords);
      expect(() => api.createUffSystem(mol), u.name).toThrow(api.UnsupportedForceFieldError);
      expect(() => api.optimizeUff(mol), u.name).toThrow(api.UnsupportedForceFieldError);
      expect(() => api.uffParameterLookup(mol), u.name).toThrow(api.UnsupportedForceFieldError);
    }
  });
});

// ------------------------------------------------------------------------------------------------
// src/ runs in a Web Worker
// ------------------------------------------------------------------------------------------------
const SRC_DIR = new URL('../src/', import.meta.url);
const sourceFiles = (readdirSync(SRC_DIR, { recursive: true }) as string[])
  .map((f) => f.replace(/\\/g, '/'))
  .filter((f) => f.endsWith('.ts'))
  .sort();

/** Source text without comments (good enough for scanning; string contents are left in place). */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

describe('src/ is browser code', () => {
  it('consists of the expected modules', () => {
    expect(sourceFiles.length).toBeGreaterThanOrEqual(14);
    expect(sourceFiles).toContain('index.ts');
    expect(sourceFiles).toContain('generated/uffParams.generated.ts');
    expect(sourceFiles.some((f) => f.endsWith('.test.ts'))).toBe(false);
  });

  it('imports nothing but its own modules and types from @matterlab/core', () => {
    const specifier = /(?:^|\n)\s*(import|export)\s+(type\s+)?[^'"`;]*?\bfrom\s+['"]([^'"]+)['"]/g;
    let imports = 0;
    for (const file of sourceFiles) {
      const text = stripComments(readFileSync(new URL(file, SRC_DIR), 'utf8'));
      expect(text, `${file}: side-effect or dynamic imports`).not.toMatch(/\bimport\s*\(|(?:^|\n)\s*import\s+['"]|\brequire\s*\(/);
      for (const m of text.matchAll(specifier)) {
        imports++;
        const [, , typeOnly, from] = m;
        if (from.startsWith('./') || from.startsWith('../')) {
          // stays inside src/
          const depth = file.split('/').length - 1;
          const ups = from.split('/').filter((s) => s === '..').length;
          expect(ups, `${file} imports ${from}`).toBeLessThanOrEqual(depth);
        } else {
          expect(from, `${file} imports ${from}`).toBe('@matterlab/core');
          expect(typeOnly, `${file} must import ${from} with "import type"`).toBeTruthy();
        }
      }
    }
    expect(imports).toBeGreaterThan(20);
  });

  it('uses no Node-only globals, no DOM, and no dynamic code evaluation', () => {
    const forbidden = [
      /\bprocess\b/,
      /\bBuffer\b/,
      /\b__dirname\b/,
      /\b__filename\b/,
      /\bglobal\b/,
      /\bsetImmediate\b/,
      /\bimport\.meta\b/,
      /['"]node:/,
      /\bwindow\b/,
      /\bdocument\b/,
      /\blocalStorage\b/,
      /\beval\s*\(/,
      /\bnew Function\b/,
    ];
    for (const file of sourceFiles) {
      const text = stripComments(readFileSync(new URL(file, SRC_DIR), 'utf8'));
      for (const pattern of forbidden) expect(pattern.test(text), `${file} matches ${String(pattern)}`).toBe(false);
    }
  });

  it('typing, energies and a full optimisation run with every Node-only global removed', () => {
    const aspirin = findMolecule('aspirin');
    const mol = toMolecule(aspirin, aspirin.coords);
    const selenophene = loadReference().unsupported.find((u) => u.name === 'selenophene');
    expect(selenophene).toBeDefined();
    if (!selenophene) return;
    const refused = toMolecule(selenophene, selenophene.coords);

    const nodeOnly = ['process', 'Buffer', 'global', 'setImmediate', 'clearImmediate'] as const;
    const saved = new Map<string, PropertyDescriptor>();
    for (const name of nodeOnly) {
      const d = Object.getOwnPropertyDescriptor(globalThis, name);
      expect(d?.configurable, `${name} must be removable for this test to mean anything`).toBe(true);
      if (d) saved.set(name, d);
    }
    let outcome: { energy: number; gradientEnergy: number; result: api.OptimizeResult; refusedAs: unknown; stillThere: string[] } | undefined;
    let failure: unknown;
    try {
      for (const name of nodeOnly) Reflect.deleteProperty(globalThis, name);
      const stillThere = nodeOnly.filter((name) => name in globalThis);
      const system = api.createUffSystem(mol);
      const x = Float64Array.from(aspirin.coords);
      const g = new Float64Array(x.length);
      const energy = api.uffEnergy(system, x).total;
      const gradientEnergy = api.uffEnergyAndGradient(system, x, g);
      // all-at-origin start: goes through start repair, pre-relaxation and the saddle-point check
      const result = api.optimizeUff(toMolecule(aspirin, new Array<number>(x.length).fill(0)), { recordTrajectoryEvery: 50, frozenAtoms: [0] });
      let refusedAs: unknown;
      try {
        api.createUffSystem(refused);
      } catch (err) {
        refusedAs = err;
      }
      outcome = { energy, gradientEnergy, result, refusedAs, stillThere };
    } catch (err) {
      failure = err;
    } finally {
      for (const [name, d] of saved) Object.defineProperty(globalThis, name, d);
    }
    expect(failure, String(failure)).toBeUndefined();
    expect(typeof process.version).toBe('string'); // restored
    expect(outcome).toBeDefined();
    if (!outcome) return;
    expect(outcome.stillThere).toEqual([]);
    expect(Math.abs(outcome.energy - aspirin.energy)).toBeLessThan(1e-9 * Math.abs(aspirin.energy));
    expect(outcome.gradientEnergy).toBe(outcome.energy);
    expect(outcome.result.converged).toBe(true);
    expect(outcome.result.elapsedMs).toBeGreaterThan(0);
    expect(outcome.refusedAs).toBeInstanceOf(api.UnsupportedForceFieldError);
  });
});

// ------------------------------------------------------------------------------------------------
// Torsions beyond RDKit's first 1000 torsion bonds
// ------------------------------------------------------------------------------------------------
interface TorsionLimitFixture {
  meta: { rdkitVersion: string };
  construction: {
    ccBond: number;
    cccAngleDeg: number;
    hydrogenOffsets: { inPlane: number; outOfPlane: number; terminalAlongChain: number; terminalInPlane: number };
    displacementPattern: number[][];
  };
  alkanes: { nCarbons: number; nAtoms: number; torsionBonds: number; energy: number; firstAtoms: number[][]; lastAtom: number[] }[];
}
const torsionLimit = JSON.parse(readFileSync(new URL('./fixtures/rdkit_torsion_limit.json', import.meta.url), 'utf8')) as TorsionLimitFixture;

/** The distorted all-trans alkane of tools/check_rdkit_torsion_limit.py, in RDKit's atom order. */
function distortedAlkane(nCarbons: number): { mol: api.FfMolecule; x: Float64Array } {
  const c = torsionLimit.construction;
  const h = c.hydrogenOffsets;
  const half = ((c.cccAngleDeg / 2) * Math.PI) / 180;
  const xyz: number[][] = [];
  const bonds: api.FfBond[] = [];
  for (let i = 0; i < nCarbons; i++) {
    const d = c.displacementPattern[(i % 2) * 3];
    xyz.push([i * c.ccBond * Math.sin(half) + d[0], (i % 2) * c.ccBond * Math.cos(half) + d[1], d[2]]);
    if (i > 0) bonds.push({ a: i - 1, b: i, order: 1 });
  }
  for (let parent = 0; parent < nCarbons; parent++) {
    const terminal = parent === 0 || parent === nCarbons - 1;
    const up = parent % 2 === 1 ? 1 : -1;
    const base = [parent * c.ccBond * Math.sin(half), (parent % 2) * c.ccBond * Math.cos(half), 0];
    for (let k = 0; k < (terminal ? 3 : 2); k++) {
      const offset = k < 2 ? [0, up * h.inPlane, (k === 0 ? 1 : -1) * h.outOfPlane] : [(parent === 0 ? -1 : 1) * h.terminalAlongChain, -up * h.terminalInPlane, 0];
      const d = c.displacementPattern[(parent % 2) * 3 + 1 + Math.min(k, 1)];
      bonds.push({ a: parent, b: xyz.length, order: 1 });
      xyz.push([base[0] + offset[0] + d[0], base[1] + offset[1] + d[1], base[2] + offset[2] + d[2]]);
    }
  }
  const mol: api.FfMolecule = {
    atoms: xyz.map((p, i) => ({ z: i < nCarbons ? 6 : 1, formalCharge: 0, position: [p[0], p[1], p[2]] as const })),
    bonds,
  };
  return { mol, x: Float64Array.from(xyz.flat()) };
}

describe('torsions of very large molecules', () => {
  const RDKIT_MAX_TORSION_BONDS = 1000; // SubstructMatch's default maxMatches
  const energies = new Map<number, { ours: number; rdkit: number; oursTruncatedLikeRdkit: number }>();

  it('the fixture was computed with the RDKit release this package ports', () => {
    expect(torsionLimit.meta.rdkitVersion).toBe(api.RDKIT_VERSION);
    expect(torsionLimit.alkanes.some((a) => a.torsionBonds > RDKIT_MAX_TORSION_BONDS)).toBe(true);
    expect(torsionLimit.alkanes.some((a) => a.torsionBonds === RDKIT_MAX_TORSION_BONDS)).toBe(true);
  });

  for (const alkane of torsionLimit.alkanes) {
    const n = alkane.nCarbons;
    const beyond = alkane.torsionBonds > RDKIT_MAX_TORSION_BONDS;
    it(`C${n}H${2 * n + 2}: ${alkane.torsionBonds} torsion bonds, ${beyond ? 'RDKit drops the torsions after the first 1000; all are kept here' : 'identical to RDKit'}`, () => {
      const { mol, x } = distortedAlkane(n);
      expect(mol.atoms).toHaveLength(alkane.nAtoms);
      // the geometry is the one RDKit evaluated
      for (let i = 0; i < 2; i++) for (let k = 0; k < 3; k++) expect(Math.abs(x[3 * i + k] - alkane.firstAtoms[i][k])).toBeLessThan(1e-12);
      for (let k = 0; k < 3; k++) expect(Math.abs(x[3 * (alkane.nAtoms - 1) + k] - alkane.lastAtom[k])).toBeLessThan(1e-9);

      const system = api.createUffSystem(mol);
      // nine torsions (3 x 3 substituents) about every C-C bond: no cap
      expect(system.termCounts.torsions).toBe(9 * (n - 1));
      const ours = api.uffEnergy(system, x).total;

      // the same force field with RDKit's truncation applied: only the first 1000 torsion bonds
      const kernel = systemData(system).kernel;
      const keptIdx: number[] = [];
      const keptPar: number[] = [];
      for (let t = 0; t < kernel.torsionIdx.length / 5; t++) {
        const j = kernel.torsionIdx[5 * t + 1];
        const k = kernel.torsionIdx[5 * t + 2];
        if (Math.min(j, k) < RDKIT_MAX_TORSION_BONDS) {
          keptIdx.push(...kernel.torsionIdx.subarray(5 * t, 5 * t + 5));
          keptPar.push(...kernel.torsionPar.subarray(2 * t, 2 * t + 2));
        }
      }
      const truncated = evaluate({ ...kernel, torsionIdx: Int32Array.from(keptIdx), torsionPar: Float64Array.from(keptPar) }, x, null, null);
      energies.set(n, { ours, rdkit: alkane.energy, oursTruncatedLikeRdkit: truncated });

      expect(Math.abs(truncated - alkane.energy) / Math.abs(alkane.energy), `truncated ${truncated}, RDKit ${alkane.energy}`).toBeLessThan(1e-9);
      if (beyond) {
        // RDKit is lower by exactly the torsional energy of the bonds it dropped
        const droppedTorsionEnergy = ours - truncated;
        expect(droppedTorsionEnergy).toBeGreaterThan(0.05 * (alkane.torsionBonds - RDKIT_MAX_TORSION_BONDS));
        expect(Math.abs(ours - alkane.energy - droppedTorsionEnergy)).toBeLessThan(1e-9 * Math.abs(alkane.energy));
      } else {
        expect(truncated).toBe(ours);
        expect(Math.abs(ours - alkane.energy) / Math.abs(alkane.energy)).toBeLessThan(1e-9);
      }
    });
  }

  it('the energy grows by the same amount per carbon below and above the limit; RDKit\'s does not', () => {
    const e = (n: number): { ours: number; rdkit: number; oursTruncatedLikeRdkit: number } => {
      const found = energies.get(n);
      if (!found) throw new Error(`C${n} is not in the fixture`);
      return found;
    };
    // the structure is periodic, so every added carbon pair must add the same energy
    const below = (e(1000).rdkit - e(800).rdkit) / 200;
    const oursBelow = (e(1000).ours - e(800).ours) / 200;
    const oursAbove = (e(1400).ours - e(1200).ours) / 200;
    const rdkitAbove = (e(1400).rdkit - e(1200).rdkit) / 200;
    expect(Math.abs(oursBelow - below)).toBeLessThan(1e-9);
    expect(Math.abs(oursAbove - below)).toBeLessThan(1e-8);
    expect(below - rdkitAbove).toBeGreaterThan(0.1);
    publish('torsion-limit', {
      rdkitVersion: torsionLimit.meta.rdkitVersion,
      energyPerCarbon: { rdkitBelowLimit: below, oursBelowLimit: oursBelow, oursAboveLimit: oursAbove, rdkitAboveLimit: rdkitAbove },
      torsionEnergyRdkitDropsPerBond: below - rdkitAbove,
      energies: Array.from(energies, ([nCarbons, v]) => ({ nCarbons, ...v, oursMinusRdkit: v.ours - v.rdkit })),
    });
  });
});
