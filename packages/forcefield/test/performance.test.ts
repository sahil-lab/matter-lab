/**
 * The two performance targets, measured single-threaded in the Node process that runs the tests:
 *   - energy + gradient of a 100-atom molecule in under 1 ms once the system is built;
 *   - a full optimisation of a typical 50-atom organic molecule in under 1 s.
 *
 * The measured numbers are published (run vitest with --silent=false, or set UFF_WRITE_REPORT) and
 * quoted in the README. Each assertion uses the median of repeated measurements so that a busy
 * machine does not decide the outcome; the first (cold, not yet JIT-compiled) run is asserted too.
 */
import { cpus } from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';
import { createUffSystem, optimizeUff, uffEnergy, uffEnergyAndGradient } from '../src';
import type { FfBond, FfMolecule } from '../src';
import type { RefMolecule } from './helpers/reference';
import { findMolecule, loadReference, toMolecule } from './helpers/reference';
import { publish } from './helpers/report';

const ref = loadReference();
const byClass = (cls: string): RefMolecule => {
  const found = ref.molecules.find((m) => m.classes.includes(cls));
  if (!found) throw new Error(`no reference molecule of class ${cls}`);
  return found;
};

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const round = (v: number, digits = 3): number => Number(v.toPrecision(digits));

/** CPU time (user + system, ms) this process has used. Unlike wall-clock time it does not grow while other jobs hold the CPU. */
function cpuMs(): number {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
}

const report: Record<string, unknown> = {
  node: process.version,
  cpu: cpus()[0]?.model.trim() ?? 'unknown',
  note:
    'One thread of the vitest worker. "Ms"/"Microseconds" are wall-clock times (medians of repeated measurements unless stated otherwise), ' +
    'which include whatever else the machine is doing; "cpu..." values are process CPU time for the same work.',
};

describe('performance targets', () => {
  afterAll(() => publish('performance', report));

  // First in the file on purpose: nothing of the optimiser has been compiled by the JIT yet.
  it('optimises a typical 50-atom organic molecule in under 1 s (cold and warm)', () => {
    const m = byClass('benchmark-50');
    expect(m.nAtoms).toBeGreaterThanOrEqual(45);
    expect(m.nAtoms).toBeLessThanOrEqual(55);
    const mol = toMolecule(m, m.coords);

    const t0 = performance.now();
    const cold = optimizeUff(mol);
    const coldMs = performance.now() - t0;
    expect(cold.converged).toBe(true);
    expect(cold.finalEnergy).toBeLessThanOrEqual(m.optimized.energy + 1e-4);

    const warm: number[] = [];
    const cpu0 = cpuMs();
    for (let run = 0; run < 9; run++) {
      const t = performance.now();
      const r = optimizeUff(mol);
      warm.push(performance.now() - t);
      expect(r.steps).toBe(cold.steps);
      expect(r.finalEnergy).toBe(cold.finalEnergy);
    }
    const warmCpuMs = (cpuMs() - cpu0) / 9;
    const warmMs = median(warm);
    report.optimisation50 = {
      molecule: m.name,
      atoms: m.nAtoms,
      steps: cold.steps,
      coldMs: round(coldMs),
      warmMedianMs: round(warmMs),
      warmMinMs: round(Math.min(...warm)),
      warmMaxMs: round(Math.max(...warm)),
      cpuMsPerWarmRun: round(warmCpuMs),
      targetMs: 1000,
    };
    expect(coldMs, 'first run, including JIT compilation').toBeLessThan(1000);
    expect(warmMs, 'median of 9 further runs').toBeLessThan(1000);
    // the time the result reports is the time that was measured from outside
    expect(cold.elapsedMs).toBeLessThanOrEqual(coldMs);
    expect(cold.elapsedMs).toBeGreaterThan(0.5 * coldMs);
  });

  it('evaluates energy and gradient of a 100-atom molecule in under 1 ms', () => {
    const m = byClass('benchmark-100');
    expect(m.nAtoms).toBeGreaterThanOrEqual(100);
    const mol = toMolecule(m, m.coords);

    const buildTimes: number[] = [];
    let system = createUffSystem(mol);
    for (let run = 0; run < 7; run++) {
      const t = performance.now();
      system = createUffSystem(mol);
      buildTimes.push(performance.now() - t);
    }

    const x = Float64Array.from(m.coords);
    const g = new Float64Array(x.length);
    let checksum = 0;
    for (let i = 0; i < 500; i++) checksum += uffEnergyAndGradient(system, x, g); // warm-up
    const BATCH = 200;
    const BATCHES = 15;
    const perCallMs: number[] = [];
    const cpu0 = cpuMs();
    for (let batch = 0; batch < BATCHES; batch++) {
      const t = performance.now();
      for (let i = 0; i < BATCH; i++) checksum += uffEnergyAndGradient(system, x, g);
      perCallMs.push((performance.now() - t) / BATCH);
    }
    const cpuPerCallMs = (cpuMs() - cpu0) / (BATCH * BATCHES);
    const energyOnlyMs: number[] = [];
    for (let batch = 0; batch < 10; batch++) {
      const t = performance.now();
      for (let i = 0; i < BATCH; i++) checksum += uffEnergy(system, x).total;
      energyOnlyMs.push((performance.now() - t) / BATCH);
    }
    expect(Number.isFinite(checksum)).toBe(true);
    expect(Math.abs(uffEnergyAndGradient(system, x, g) - m.energy)).toBeLessThan(1e-9 * Math.abs(m.energy));

    const med = median(perCallMs);
    report.energyAndGradient100 = {
      molecule: m.name,
      atoms: m.nAtoms,
      terms: system.termCounts,
      microsecondsPerCall: { median: round(1000 * med), min: round(1000 * Math.min(...perCallMs)), max: round(1000 * Math.max(...perCallMs)) },
      cpuMicrosecondsPerCall: round(1000 * cpuPerCallMs),
      energyOnlyMicrosecondsPerCall: round(1000 * median(energyOnlyMs)),
      buildSystemMs: round(median(buildTimes)),
      targetMicroseconds: 1000,
    };
    expect(med, `median over ${BATCHES} batches of ${BATCH} evaluations, in ms`).toBeLessThan(1);
  });

  it('measures the rest of the reference set (reported only: these are not targets)', () => {
    const rows: Record<string, unknown>[] = [];
    for (const name of ['aspirin', 'caffeine', 'ibuprofen', 'penicillin G', 'testosterone', 'cholesterol', 'atorvastatin', 'paclitaxel', 'C140 alkane']) {
      const m = findMolecule(name);
      const mol = toMolecule(m, m.coords);
      const system = createUffSystem(mol);
      const x = Float64Array.from(m.coords);
      const g = new Float64Array(x.length);
      for (let i = 0; i < 50; i++) uffEnergyAndGradient(system, x, g);
      const calls = m.nAtoms > 200 ? 50 : 200;
      const perCall: number[] = [];
      for (let batch = 0; batch < 5; batch++) {
        const t = performance.now();
        for (let i = 0; i < calls; i++) uffEnergyAndGradient(system, x, g);
        perCall.push((performance.now() - t) / calls);
      }
      const times: number[] = [];
      let steps = 0;
      const runs = m.nAtoms > 200 ? 1 : 3;
      const cpu0 = cpuMs();
      for (let run = 0; run < runs; run++) {
        const t = performance.now();
        const r = optimizeUff(mol);
        times.push(performance.now() - t);
        expect(r.converged, name).toBe(true);
        steps = r.steps;
      }
      rows.push({
        molecule: name,
        atoms: m.nAtoms,
        energyAndGradientMicroseconds: round(1000 * median(perCall)),
        optimisationSteps: steps,
        optimisationMs: round(median(times)),
        optimisationCpuMs: round((cpuMs() - cpu0) / runs),
      });
    }
    report.referenceSet = rows;

    // One molecule in the upper range of the dense BFGS update (up to 400 atoms), where that
    // update, quadratic in the number of coordinates, costs more than the energy evaluations:
    // an all-trans C66H134 (200 atoms), every coordinate displaced by up to 0.05 angstrom.
    {
      const nCarbons = 66;
      const half = ((111 / 2) * Math.PI) / 180;
      const xyz: number[][] = [];
      const bonds: FfBond[] = [];
      for (let i = 0; i < nCarbons; i++) {
        xyz.push([i * 1.53 * Math.sin(half), (i % 2) * 1.53 * Math.cos(half), 0]);
        if (i > 0) bonds.push({ a: i - 1, b: i, order: 1 });
      }
      for (let parent = 0; parent < nCarbons; parent++) {
        const up = parent % 2 === 1 ? 1 : -1;
        const c = xyz[parent];
        const hydrogens = [
          [c[0], c[1] + up * 0.63, 0.89],
          [c[0], c[1] + up * 0.63, -0.89],
        ];
        if (parent === 0 || parent === nCarbons - 1) hydrogens.push([c[0] + (parent === 0 ? -1 : 1) * 1.03, c[1] - up * 0.36, 0]);
        for (const h of hydrogens) {
          bonds.push({ a: parent, b: xyz.length, order: 1 });
          xyz.push(h);
        }
      }
      const jitter = (k: number): number => 0.05 * Math.sin(12.9898 * k + 78.233);
      const alkane: FfMolecule = {
        atoms: xyz.map((p, i) => ({
          z: i < nCarbons ? 6 : 1,
          formalCharge: 0,
          position: [p[0] + jitter(3 * i), p[1] + jitter(3 * i + 1), p[2] + jitter(3 * i + 2)] as const,
        })),
        bonds,
      };
      const cpu0 = cpuMs();
      const t = performance.now();
      const r = optimizeUff(alkane);
      const ms = performance.now() - t;
      expect(r.converged, r.warnings.join(' | ')).toBe(true);
      report.denseUpdate200 = { molecule: 'C66H134, all-trans, perturbed', atoms: alkane.atoms.length, optimisationSteps: r.steps, optimisationMs: round(ms), optimisationCpuMs: round(cpuMs() - cpu0) };
    }

    // the worst kind of input: every atom at the origin
    const m = byClass('benchmark-50');
    const times: number[] = [];
    let steps = 0;
    for (let run = 0; run < 3; run++) {
      const t = performance.now();
      const r = optimizeUff(toMolecule(m, new Array<number>(3 * m.nAtoms).fill(0)));
      times.push(performance.now() - t);
      expect(r.converged).toBe(true);
      steps = r.steps;
    }
    report.optimisation50FromOrigin = { molecule: m.name, atoms: m.nAtoms, steps, ms: round(median(times)) };
  });
});
