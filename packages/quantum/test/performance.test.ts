import { describe, expect, it } from 'vitest';
import { checkSupport, createGrid, evaluateDensityGrid, evaluateEspAtPoints, evaluateOrbitalGrid, marchingCubes, runRhf } from '../src/index';
import type { GridSpec, QmInput, ScfResult } from '../src/index';
import { findMolecule, toInput } from './helpers/pyscf';
import { validationReporter } from './helpers/report';

/**
 * Wall-clock measurements against the targets of the engine (single thread):
 * water < 50 ms, methane < 100 ms, benzene < 15 s (ideally < 5 s), benzene density on 64^3 points < 2 s.
 *
 * Each quantity is timed several times and the best run is compared with the target, so that a
 * busy machine does not cause spurious failures; the first (cold, not yet JIT-compiled) run is
 * recorded as well because it is what a user sees for the first calculation in a fresh worker.
 * Run with QUANTUM_REPORT=1 to write the numbers to reports/performance.json.
 */

const record = validationReporter('performance');

function time<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

function best<T>(runs: number, fn: () => T): { value: T; firstMs: number; bestMs: number; allMs: number[] } {
  const allMs: number[] = [];
  let value!: T;
  for (let i = 0; i < runs; i++) {
    const run = time(fn);
    value = run.value;
    allMs.push(run.ms);
  }
  return { value, firstMs: allMs[0], bestMs: Math.min(...allMs), allMs };
}

function cubicGrid(input: QmInput, points: number): GridSpec {
  // A cube of points^3 samples around the molecule, like createGrid but with fixed dimensions.
  const base = createGrid(input.atoms, { padding: 3 });
  const extent = Math.max(...base.dims.map((d, axis) => (d - 1) * base.spacing[axis]));
  const spacing = extent / (points - 1);
  const centre = base.origin.map((o, axis) => o + 0.5 * (base.dims[axis] - 1) * base.spacing[axis]);
  return {
    origin: [centre[0] - extent / 2, centre[1] - extent / 2, centre[2] - extent / 2],
    spacing: [spacing, spacing, spacing],
    dims: [points, points, points],
  };
}

describe('performance', () => {
  const water = toInput(findMolecule('H2O'));
  const methane = toInput(findMolecule('CH4'));
  const benzene = toInput(findMolecule('C6H6'));
  let benzeneResult: ScfResult;

  /**
   * `estimatedSeconds` is calibrated for the engine running as native ES modules (tools/bench.ts);
   * under Vitest's module runner the same code is slower, and the machine may be busy, so only the
   * order of magnitude is asserted here. The ratio is recorded for the report.
   */
  const estimateRatio = (input: QmInput, measuredMs: number): number => {
    const ratio = measuredMs / 1000 / checkSupport(input).estimatedSeconds;
    expect(ratio).toBeGreaterThan(0.1);
    expect(ratio).toBeLessThan(10);
    return ratio;
  };

  it('water (7 basis functions) runs in under 50 ms', () => {
    const run = best(20, () => runRhf(water));
    record('water', {
      nBasis: run.value.nBasis,
      coldMs: run.firstMs,
      bestMs: run.bestMs,
      iterations: run.value.iterations.length,
      timings: run.value.timings,
      measuredOverEstimated: estimateRatio(water, run.bestMs),
    });
    expect(run.value.converged).toBe(true);
    expect(run.bestMs).toBeLessThan(50);
  });

  it('methane (9 basis functions) runs in under 100 ms', () => {
    const run = best(20, () => runRhf(methane));
    record('methane', {
      nBasis: run.value.nBasis,
      coldMs: run.firstMs,
      bestMs: run.bestMs,
      iterations: run.value.iterations.length,
      timings: run.value.timings,
      measuredOverEstimated: estimateRatio(methane, run.bestMs),
    });
    expect(run.value.converged).toBe(true);
    expect(run.bestMs).toBeLessThan(100);
  });

  it('benzene (36 basis functions) runs in under 5 s', () => {
    const run = best(3, () => runRhf(benzene));
    benzeneResult = run.value;
    record('benzene', {
      nBasis: run.value.nBasis,
      coldMs: run.firstMs,
      bestMs: run.bestMs,
      allMs: run.allMs,
      iterations: run.value.iterations.length,
      timings: run.value.timings,
      measuredOverEstimated: estimateRatio(benzene, run.bestMs),
    });
    expect(run.value.converged).toBe(true);
    expect(run.bestMs).toBeLessThan(5000);
  });

  it('evaluates the benzene density on 64^3 grid points in under 2 s', () => {
    const grid = cubicGrid(benzene, 64);
    const run = best(3, () => evaluateDensityGrid(benzeneResult, benzene, grid));
    const orbital = best(3, () => evaluateOrbitalGrid(benzeneResult, benzene, benzeneResult.homoIndex, grid));
    const mesh = best(3, () => marchingCubes(run.value, grid, 0.02));
    const vertices = mesh.value.positions;
    const esp = time(() => evaluateEspAtPoints(benzeneResult, benzene, vertices));
    record('benzene-fields', {
      gridPoints: 64 ** 3,
      spacingAngstrom: grid.spacing[0],
      densityGridColdMs: run.firstMs,
      densityGridBestMs: run.bestMs,
      orbitalGridBestMs: orbital.bestMs,
      marchingCubesBestMs: mesh.bestMs,
      meshVertices: vertices.length / 3,
      meshTriangles: mesh.value.indices.length / 3,
      espAtMeshVerticesMs: esp.ms,
      espMicrosecondsPerPoint: (1000 * esp.ms) / (vertices.length / 3),
    });
    expect(run.bestMs).toBeLessThan(2000);
  });
});
