// Stand-alone benchmark and cost-model calibration for @matterlab/quantum.
//
//   node --import ./packages/quantum/tools/ts-loader.mjs packages/quantum/tools/bench.ts [--quick] [--write]
//
// Runs the engine as native ES modules in plain Node (see ts-loader.mjs), single-threaded, and
// prints: timings for a set of molecules (first call and best of several), the cost of the
// individual building blocks the cost model of `checkSupport` is made of, and how well
// `estimatedSeconds` predicts the measured run times. With --write the numbers are stored in
// packages/quantum/reports/bench.json (latest run) and, because timings scatter from run to run on
// a busy machine, also kept under packages/quantum/reports/bench-runs/ (one file per run);
// update-readme.mjs reports the fastest complete run in detail and the spread over all of them.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBasis } from '../src/basis/basis.ts';
import { checkSupport, createGrid, evaluateDensityGrid, evaluateEspAtPoints, evaluateOrbitalGrid, marchingCubes, runRhf } from '../src/index.ts';
import type { GridSpec, QmAtom, QmInput } from '../src/index.ts';
import { eriShellQuartet } from '../src/integrals/eri.ts';
import { buildShellPairs } from '../src/integrals/shellPairs.ts';
import type { ShellPair } from '../src/integrals/shellPairs.ts';
import { symmetricEigen } from '../src/math/linalg.ts';
import { buildTwoElectronFock } from '../src/scf/fock.ts';
import { COST_MODEL } from '../src/support.ts';

const here = dirname(fileURLToPath(import.meta.url));
const quick = process.argv.includes('--quick');
const write = process.argv.includes('--write');

interface FixtureMolecule {
  name: string;
  orientation: string;
  charge: number;
  atoms: { z: number; position: [number, number, number] }[];
}

const fixture = JSON.parse(readFileSync(join(here, '..', 'test', 'fixtures', 'pyscf_reference.json'), 'utf8')) as { molecules: FixtureMolecule[] };

function fromFixture(name: string): QmInput {
  const molecule = fixture.molecules.find((m) => m.name === name && m.orientation === 'general');
  if (!molecule) throw new Error(`No fixture molecule ${name}`);
  return { atoms: molecule.atoms, charge: molecule.charge };
}

/**
 * All-trans n-alkane C_nH_(2n+2) with an idealised geometry (C-C 1.53 A, C-H 1.09 A, tetrahedral
 * angles): a planar zigzag carbon chain along x, two hydrogens above and below the plane on every
 * carbon and one more in the plane at each end, where the next carbon would be.
 */
function alkane(n: number): QmInput {
  const cc = 1.53;
  const ch = 1.09;
  const half = (109.4712 * Math.PI) / 360;
  const sin = Math.sin(half);
  const cos = Math.cos(half);
  const carbon = (i: number): [number, number, number] => [i * cc * sin, Math.abs(i % 2) === 1 ? cc * cos : 0, 0];
  const atoms: QmAtom[] = [];
  for (let i = 0; i < n; i++) atoms.push({ z: 6, position: carbon(i) });
  for (let i = 0; i < n; i++) {
    const c = carbon(i);
    const away = i % 2 === 1 ? 1 : -1; // direction pointing away from both neighbouring carbons
    atoms.push({ z: 1, position: [c[0], c[1] + away * ch * cos, ch * sin] });
    atoms.push({ z: 1, position: [c[0], c[1] + away * ch * cos, -ch * sin] });
    for (const neighbour of [i - 1, i + 1]) {
      if (neighbour >= 0 && neighbour < n) continue;
      const m = carbon(neighbour);
      atoms.push({ z: 1, position: [c[0] + ((m[0] - c[0]) * ch) / cc, c[1] + ((m[1] - c[1]) * ch) / cc, 0] });
    }
  }
  return { atoms, charge: 0 };
}

function time<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

/** Runs `fn` several times; returns the time of the first run and the value and time of the fastest. */
function bestOf<T>(runs: number, fn: () => T): { value: T; firstMs: number; bestMs: number } {
  let bestMs = Infinity;
  let firstMs = 0;
  let value!: T;
  for (let i = 0; i < runs; i++) {
    const run = time(fn);
    if (i === 0) firstMs = run.ms;
    if (run.ms < bestMs) {
      bestMs = run.ms;
      value = run.value;
    }
  }
  return { value, firstMs, bestMs };
}

/**
 * Processor time of the whole machine (all logical processors, all processes) since boot, in ms.
 * The difference between the start and the end of the benchmark tells how busy the machine was
 * with other work while the single-threaded benchmark ran.
 */
function machineCpuTimes(): { busy: number; idle: number } {
  let busy = 0;
  let idle = 0;
  for (const cpu of cpus()) {
    busy += cpu.times.user + cpu.times.nice + cpu.times.sys;
    idle += cpu.times.idle;
  }
  return { busy, idle };
}

const generated = new Date().toISOString();
const cpuTimesAtStart = machineCpuTimes();
const report: Record<string, unknown> = {
  generated,
  quick,
  node: process.version,
  cpu: cpus()[0]?.model ?? 'unknown',
  logicalProcessors: cpus().length,
  threads: 'single (main thread)',
  costModel: COST_MODEL,
};

// ---------------------------------------------------------------------------------------------
// 1. Whole calculations
// ---------------------------------------------------------------------------------------------
const systems: { name: string; input: QmInput; runs: number }[] = [
  { name: 'H2O', input: fromFixture('H2O'), runs: 50 },
  { name: 'CH4', input: fromFixture('CH4'), runs: 50 },
  { name: 'C2H4', input: fromFixture('C2H4'), runs: 20 },
  { name: 'SO2', input: fromFixture('SO2'), runs: 20 },
  { name: 'C6H6', input: fromFixture('C6H6'), runs: 8 },
  ...(quick ? [4] : [4, 6, 8, 10, 13]).map((n) => ({ name: `C${n}H${2 * n + 2}`, input: alkane(n), runs: n <= 6 ? 6 : n <= 10 ? 4 : 3 })),
];

const rows: Record<string, unknown>[] = [];
console.log('system        nbf  first(ms)  best(ms)  integrals  scf  iters  estimate(ms)  measured/estimate');
for (const system of systems) {
  const support = checkSupport(system.input);
  if (!support.supported) throw new Error(`${system.name}: ${support.reasons.join(' ')}`);
  const run = bestOf(system.runs, () => runRhf(system.input));
  const result = run.value;
  if (!result.converged) throw new Error(`${system.name} did not converge`);
  const row = {
    system: system.name,
    nBasis: result.nBasis,
    runs: system.runs,
    firstMs: run.firstMs,
    bestMs: run.bestMs,
    // Phase timings of the fastest run.
    integralsMs: result.timings.integralsMs,
    scfMs: result.timings.scfMs,
    iterations: result.iterations.length,
    energy: result.energy.total,
    estimatedMs: support.estimatedSeconds * 1000,
    ratio: run.bestMs / (support.estimatedSeconds * 1000),
  };
  rows.push(row);
  console.log(
    `${row.system.padEnd(12)} ${String(row.nBasis).padStart(4)} ${row.firstMs.toFixed(1).padStart(10)} ${row.bestMs.toFixed(1).padStart(9)} ${row.integralsMs.toFixed(1).padStart(10)} ${row.scfMs
      .toFixed(1)
      .padStart(4)} ${String(row.iterations).padStart(6)} ${row.estimatedMs.toFixed(1).padStart(13)} ${row.ratio.toFixed(2).padStart(18)}`,
  );
}
report.calculations = rows;

// ---------------------------------------------------------------------------------------------
// 2. Building blocks of the cost model
// ---------------------------------------------------------------------------------------------
{
  // Two-electron integrals per primitive quartet, by class, measured on benzene's shell pairs
  // with primitive screening switched off so that every quartet does its 81 primitive quartets.
  const basis = buildBasis(fromFixture('C6H6').atoms);
  const pairs = buildShellPairs(basis, 0);
  const byClass: ShellPair[][] = [[], [], []];
  for (const pair of pairs) if (pair.nPrim === 9) byClass[pair.order].push(pair);
  const block = new Float64Array(256);
  const classes: [string, number, number][] = [
    ['(ss|ss)', 0, 0],
    ['(s-sp|ss)', 1, 0],
    ['(s-sp|s-sp)', 1, 1],
    ['(sp-sp|ss)', 2, 0],
    ['(sp-sp|s-sp)', 2, 1],
    ['(sp-sp|sp-sp)', 2, 2],
  ];
  const perPrimitive: Record<string, number> = {};
  console.log('\nclass            ns per primitive quartet (cost model value)');
  classes.forEach(([label, braOrder, ketOrder], index) => {
    const bras = byClass[braOrder].slice(0, 20);
    const kets = byClass[ketOrder].slice(0, 20);
    let bestNs = Infinity;
    for (let repeat = 0; repeat < (quick ? 5 : 20); repeat++) {
      let primitives = 0;
      const start = performance.now();
      for (const bra of bras) for (const ket of kets) primitives += eriShellQuartet(bra, ket, block, 0);
      bestNs = Math.min(bestNs, ((performance.now() - start) * 1e6) / primitives);
    }
    perPrimitive[label] = bestNs;
    console.log(`${label.padEnd(16)} ${bestNs.toFixed(1).padStart(8)}   (${COST_MODEL.primitiveQuartetNs[index]})`);
  });
  report.primitiveQuartetNs = perPrimitive;

  // Fock build per stored integral and Jacobi diagonalisation per n^3.
  const fockNs: Record<string, number> = {};
  const eigenNs: Record<string, number> = {};
  for (const n of quick ? [36] : [36, 72, 96]) {
    const pairsCount = (n * (n + 1)) / 2;
    const unique = (pairsCount * (pairsCount + 1)) / 2;
    const eri = new Float64Array(unique);
    for (let i = 0; i < unique; i++) eri[i] = Math.sin(i * 0.37) * 1e-3 + 1e-4;
    const density = new Float64Array(n * n);
    const symmetric = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j <= i; j++) {
        density[i * n + j] = density[j * n + i] = Math.cos(i * 1.3 + j * 0.7);
        symmetric[i * n + j] = symmetric[j * n + i] = Math.sin(i * 0.9 + j * 2.1) + (i === j ? i : 0);
      }
    }
    const out = new Float64Array(n * n);
    const scratch = new Float64Array(n * n);
    const fock = bestOf(5, () => buildTwoElectronFock(eri, density, n, out, scratch));
    const eigen = bestOf(5, () => symmetricEigen(symmetric, n));
    fockNs[n] = (fock.bestMs * 1e6) / unique;
    eigenNs[n] = (eigen.bestMs * 1e6) / n ** 3;
  }
  console.log('\nFock build, ns per stored integral:', JSON.stringify(fockNs), `(cost model ${COST_MODEL.fockNsPerIntegral})`);
  console.log('Jacobi eigensolver, ns per n^3:', JSON.stringify(eigenNs));
  report.fockNsPerIntegral = fockNs;
  report.jacobiNsPerCube = eigenNs;
}

// ---------------------------------------------------------------------------------------------
// 3. Fields for benzene
// ---------------------------------------------------------------------------------------------
{
  const benzene = fromFixture('C6H6');
  const result = runRhf(benzene);
  const base = createGrid(benzene.atoms);
  const extent = Math.max(...base.dims.map((d, axis) => (d - 1) * base.spacing[axis]));
  const centre = base.origin.map((o, axis) => o + 0.5 * (base.dims[axis] - 1) * base.spacing[axis]);
  const points = 64;
  const spacing = extent / (points - 1);
  const grid: GridSpec = { origin: [centre[0] - extent / 2, centre[1] - extent / 2, centre[2] - extent / 2], spacing: [spacing, spacing, spacing], dims: [points, points, points] };
  const density = bestOf(5, () => evaluateDensityGrid(result, benzene, grid));
  const orbital = bestOf(5, () => evaluateOrbitalGrid(result, benzene, result.homoIndex, grid));
  const mesh = bestOf(5, () => marchingCubes(density.value, grid, 0.02));
  const vertices = mesh.value.positions;
  const esp = bestOf(3, () => evaluateEspAtPoints(result, benzene, vertices));
  const defaultGrid = bestOf(3, () => evaluateDensityGrid(result, benzene, base));
  const fields = {
    grid64: { spacingAngstrom: spacing, densityFirstMs: density.firstMs, densityBestMs: density.bestMs, orbitalBestMs: orbital.bestMs, marchingCubesBestMs: mesh.bestMs },
    isosurface: { isoValue: 0.02, vertices: vertices.length / 3, triangles: mesh.value.indices.length / 3 },
    esp: { points: vertices.length / 3, ms: esp.bestMs, microsecondsPerPoint: (1000 * esp.bestMs) / (vertices.length / 3) },
    defaultGrid: { dims: base.dims, points: base.dims[0] * base.dims[1] * base.dims[2], spacingAngstrom: base.spacing[0], densityMs: defaultGrid.bestMs },
  };
  console.log('\nbenzene fields:', JSON.stringify(fields, null, 1));
  report.benzeneFields = fields;
}

{
  const end = machineCpuTimes();
  const busy = end.busy - cpuTimesAtStart.busy;
  const idle = end.idle - cpuTimesAtStart.idle;
  const utilisation = busy / (busy + idle);
  report.machineCpuUtilisation = utilisation;
  report.durationSeconds = (Date.now() - Date.parse(generated)) / 1000;
  console.log(
    `\nwhole-machine CPU utilisation during the benchmark: ${(100 * utilisation).toFixed(0)} % of ${cpus().length} logical processors ` +
      `(this single-threaded process alone would be ${(100 / cpus().length).toFixed(1)} %)`,
  );
}

if (write) {
  const directory = join(here, '..', 'reports');
  const archive = join(directory, 'bench-runs');
  mkdirSync(archive, { recursive: true });
  const text = `${JSON.stringify(report, null, 2)}\n`;
  const kept = join(archive, `${generated.replace(/[:.]/g, '-')}.json`);
  writeFileSync(join(directory, 'bench.json'), text);
  writeFileSync(kept, text);
  console.log(`\nWrote ${join(directory, 'bench.json')} and ${kept}`);
}
