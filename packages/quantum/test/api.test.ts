import type { Provenance } from '@matterlab/core';
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as api from '../src/index';

/**
 * The public API exactly as specified for this package, restated here under local names. The
 * type-level assertions below fail the type check (tsc) if an export is missing or its type drifts
 * from the specification; the run-time checks verify that every function is really exported.
 */
interface QmAtom { readonly z: number; /** angstrom */ readonly position: readonly [number, number, number]; }
interface QmInput { readonly atoms: readonly QmAtom[]; /** net charge in units of e */ readonly charge: number; }

interface SupportOptions { readonly maxBasisFunctions?: number; }
interface SupportReport {
  readonly supported: boolean;
  readonly reasons: readonly string[];
  readonly nBasis: number;
  readonly nElectrons: number;
  readonly estimatedSeconds: number;
}

interface ScfIteration { readonly iteration: number; readonly energy: number; readonly deltaEnergy: number; readonly rmsDensityChange: number; readonly diisError: number; }
interface ScfOptions {
  readonly maxIterations?: number;
  readonly energyTolerance?: number;
  readonly densityTolerance?: number;
  readonly maxBasisFunctions?: number;
  readonly onPhase?: (phase: 'integrals' | 'scf' | 'properties', fraction: number) => void;
  readonly onIteration?: (it: ScfIteration) => void;
  readonly isCancelled?: () => boolean;
}
interface BasisFunctionInfo { readonly index: number; readonly atomIndex: number; readonly shell: string; readonly label: string; }
interface ScfResult {
  readonly method: 'RHF';
  readonly basisSet: 'STO-3G';
  readonly converged: boolean;
  readonly cancelled: boolean;
  readonly iterations: readonly ScfIteration[];
  readonly nBasis: number;
  readonly nElectrons: number;
  readonly nOccupied: number;
  readonly energy: { readonly total: number; readonly electronic: number; readonly nuclearRepulsion: number; readonly kinetic: number; readonly nuclearAttraction: number; readonly twoElectron: number; };
  readonly orbitalEnergies: Float64Array;
  readonly orbitalCoefficients: Float64Array;
  readonly densityMatrix: Float64Array;
  readonly overlapMatrix: Float64Array;
  readonly basisFunctions: readonly BasisFunctionInfo[];
  readonly homoIndex: number;
  readonly lumoIndex: number | null;
  readonly mullikenCharges: readonly number[];
  readonly dipole: { readonly au: readonly [number, number, number]; readonly debye: readonly [number, number, number]; readonly magnitudeDebye: number; readonly originDependent: boolean; };
  readonly timings: { readonly integralsMs: number; readonly scfMs: number; readonly totalMs: number; };
  readonly warnings: readonly string[];
  readonly provenance: Provenance;
}

interface GridSpec { readonly origin: readonly [number, number, number]; readonly spacing: readonly [number, number, number]; readonly dims: readonly [number, number, number]; }
interface IsoMesh { readonly positions: Float32Array; readonly normals: Float32Array; readonly indices: Uint32Array; }

describe('public API', () => {
  it('exports the specified types unchanged', () => {
    expectTypeOf<api.QmAtom>().toEqualTypeOf<QmAtom>();
    expectTypeOf<api.QmInput>().toEqualTypeOf<QmInput>();
    expectTypeOf<api.SupportOptions>().toEqualTypeOf<SupportOptions>();
    expectTypeOf<api.SupportReport>().toEqualTypeOf<SupportReport>();
    expectTypeOf<api.ScfIteration>().toEqualTypeOf<ScfIteration>();
    expectTypeOf<api.ScfOptions>().toEqualTypeOf<ScfOptions>();
    expectTypeOf<api.BasisFunctionInfo>().toEqualTypeOf<BasisFunctionInfo>();
    expectTypeOf<api.ScfResult>().toEqualTypeOf<ScfResult>();
    expectTypeOf<api.GridSpec>().toEqualTypeOf<GridSpec>();
    expectTypeOf<api.IsoMesh>().toEqualTypeOf<IsoMesh>();
  });

  it('exports the specified functions with the specified signatures', () => {
    // Assignments to variables typed with the specified signatures: checked by tsc.
    const checkSupport: (input: QmInput, options?: SupportOptions) => SupportReport = api.checkSupport;
    const runRhf: (input: QmInput, options?: ScfOptions) => ScfResult = api.runRhf;
    const createGrid: (atoms: readonly QmAtom[], options?: { spacing?: number; padding?: number; maxPoints?: number }) => GridSpec = api.createGrid;
    const evaluateDensityGrid: (result: ScfResult, input: QmInput, grid: GridSpec, onProgress?: (fraction: number) => void) => Float32Array = api.evaluateDensityGrid;
    const evaluateOrbitalGrid: (result: ScfResult, input: QmInput, orbitalIndex: number, grid: GridSpec, onProgress?: (fraction: number) => void) => Float32Array =
      api.evaluateOrbitalGrid;
    const evaluateDensityAtPoints: (result: ScfResult, input: QmInput, points: Float32Array) => Float32Array = api.evaluateDensityAtPoints;
    const evaluateEspAtPoints: (result: ScfResult, input: QmInput, points: Float32Array, onProgress?: (fraction: number) => void) => Float32Array = api.evaluateEspAtPoints;
    const marchingCubes: (values: Float32Array, grid: GridSpec, isoValue: number) => IsoMesh = api.marchingCubes;
    const functions = { checkSupport, runRhf, createGrid, evaluateDensityGrid, evaluateOrbitalGrid, evaluateDensityAtPoints, evaluateEspAtPoints, marchingCubes };
    for (const [name, fn] of Object.entries(functions)) expect(typeof fn, name).toBe('function');

    expectTypeOf(api.checkSupport).parameters.toEqualTypeOf<[input: QmInput, options?: SupportOptions]>();
    expectTypeOf(api.runRhf).parameters.toEqualTypeOf<[input: QmInput, options?: ScfOptions]>();
    expectTypeOf(api.marchingCubes).parameters.toEqualTypeOf<[values: Float32Array, grid: GridSpec, isoValue: number]>();
    expectTypeOf(api.evaluateDensityAtPoints).parameters.toEqualTypeOf<[result: ScfResult, input: QmInput, points: Float32Array]>();
  });

  it('exports UnsupportedSystemError as an Error subclass carrying the reasons', () => {
    const error = new api.UnsupportedSystemError(['first reason.', 'second reason.']);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(api.UnsupportedSystemError);
    expect(error.reasons).toEqual(['first reason.', 'second reason.']);
    expect(error.message).toContain('first reason.');
    expectTypeOf(error.reasons).toEqualTypeOf<readonly string[]>();
  });

  it('returns results made of typed arrays and plain data only (structured-cloneable)', () => {
    const input: QmInput = { atoms: [{ z: 1, position: [0, 0, 0] }, { z: 1, position: [0, 0, 0.74] }], charge: 0 };
    const result = api.runRhf(input);
    const isPlain = (value: unknown, path: string): void => {
      if (value === null || ['number', 'string', 'boolean'].includes(typeof value)) return;
      if (value instanceof Float64Array || value instanceof Float32Array || value instanceof Uint32Array) return;
      if (Array.isArray(value)) return value.forEach((item, index) => isPlain(item, `${path}[${index}]`));
      expect(Object.getPrototypeOf(value), path).toBe(Object.prototype);
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) isPlain(item, `${path}.${key}`);
    };
    isPlain(result, 'result');
    const clone = structuredClone(result);
    expect(clone).toEqual(result);
    // The clone works wherever the original does, e.g. after crossing a worker boundary.
    const grid = api.createGrid(input.atoms, { spacing: 0.4 });
    expect(Array.from(api.evaluateDensityGrid(clone, input, grid))).toEqual(Array.from(api.evaluateDensityGrid(result, input, grid)));
    isPlain(api.checkSupport(input), 'report');
    isPlain(grid, 'grid');
    isPlain(api.marchingCubes(api.evaluateDensityGrid(result, input, grid), grid, 0.05), 'mesh');
  });

  it('runs the example of the README', () => {
    const water = {
      atoms: [
        { z: 8, position: [0, 0, 0.1173] },
        { z: 1, position: [0, 0.7572, -0.4692] },
        { z: 1, position: [0, -0.7572, -0.4692] },
      ],
      charge: 0,
    } as const;
    const support = api.checkSupport(water);
    expect(support.supported).toBe(true);
    const phases = new Set<string>();
    const result = api.runRhf(water, { onPhase: (phase) => phases.add(phase), onIteration: () => undefined, isCancelled: () => false });
    expect(result.converged).toBe(true);
    expect([...phases]).toEqual(['integrals', 'scf', 'properties']);
    const grid = api.createGrid(water.atoms);
    const density = api.evaluateDensityGrid(result, water, grid);
    const surface = api.marchingCubes(density, grid, 0.002);
    const potential = api.evaluateEspAtPoints(result, water, surface.positions);
    expect(api.meshStatistics(surface).closed).toBe(true);
    expect(potential.length).toBe(surface.positions.length / 3);
    const homo = api.evaluateOrbitalGrid(result, water, result.homoIndex, grid);
    const lobes = [api.marchingCubes(homo, grid, 0.05), api.marchingCubes(homo, grid, -0.05)];
    for (const lobe of lobes) expect(api.meshStatistics(lobe).closed).toBe(true);
    // The water HOMO is the oxygen lone pair: two lobes of equal size on either side of the molecular plane.
    expect(Math.abs(api.meshStatistics(lobes[0]).volume / api.meshStatistics(lobes[1]).volume - 1)).toBeLessThan(0.02);
  });

  it('uses no Node-only API in the engine sources', async () => {
    // The engine runs in a Web Worker: its sources must not import Node built-ins or use Node globals.
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = fileURLToPath(new URL('../src', import.meta.url));
    const files: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(join(directory, entry.name));
        else if (entry.name.endsWith('.ts')) files.push(join(directory, entry.name));
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/from\s+['"]node:/);
      expect(source, file).not.toMatch(/\brequire\s*\(/);
      expect(source, file).not.toMatch(/\bprocess\.|\bBuffer\b|__dirname|__filename/);
      const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
      for (const specifier of imports) expect(specifier.startsWith('.') || specifier === '@matterlab/core', `${file} imports ${specifier}`).toBe(true);
    }
  });
});
