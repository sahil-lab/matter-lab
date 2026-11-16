import { describe, expect, it } from 'vitest';
import { atomsToBohr, buildBasisBohr } from '../src/basis/basis';
import { computeEri } from '../src/integrals/eri';
import { buildShellPairs } from '../src/integrals/shellPairs';
import { symmetricEigen } from '../src/math/linalg';
import { runRhfCore } from '../src/scf/rhf';
import { EXACT_STABILITY_LIMIT, lowestEigenpair, lowestRotationEigenpair, RotationHessian } from '../src/scf/stability';
import type { StabilityProblem, SymmetricOperator } from '../src/scf/stability';
import { runRhf } from '../src/index';
import { readJsonFixture } from './helpers/crawford';
import { findMolecule, pyscfFixture } from './helpers/pyscf';
import { validationReporter } from './helpers/report';

/**
 * The stability analysis decides whether an SCF solution is returned as it is or left as a saddle
 * point, so its eigenvalue search must not overlook a negative eigenvalue. Everything here is
 * checked against full diagonalisations: of synthetic matrices built to be difficult, and of the
 * orbital-rotation Hessian of every reference system, at its final solution and at every saddle
 * point the SCF passes on the way.
 */

const record = validationReporter('stability');
const THRESHOLD = 1e-5;

/** Deterministic pseudo-random numbers in [-0.5, 0.5). */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296 - 0.5;
  };
}

interface Dense {
  readonly n: number;
  readonly matrix: Float64Array;
  /** What the search is given as diagonal estimate (the analogue of the orbital-energy gaps). */
  readonly diagonal: Float64Array;
}

/**
 * diag(d) + sum_k c_k u_k u_k^T with unit vectors u_k that live on the index range [from, to),
 * plus, if `noise` is given, a dense symmetric random matrix of that amplitude inside each range.
 */
function diagonalPlusRankOne(diagonal: number[], terms: { coefficient: number; from: number; to: number; seed: number }[], noise = 0): Dense {
  const n = diagonal.length;
  const matrix = new Float64Array(n * n);
  for (let i = 0; i < n; i++) matrix[i * n + i] = diagonal[i];
  for (const term of terms) {
    const random = generator(term.seed);
    const u = new Float64Array(n);
    let norm = 0;
    for (let i = term.from; i < term.to; i++) {
      u[i] = random();
      norm += u[i] * u[i];
    }
    norm = Math.sqrt(norm);
    for (let i = term.from; i < term.to; i++) {
      for (let j = term.from; j < term.to; j++) matrix[i * n + j] += (term.coefficient * u[i] * u[j]) / (norm * norm);
    }
    if (noise > 0) {
      for (let i = term.from; i < term.to; i++) {
        for (let j = term.from; j < i; j++) {
          const element = noise * random();
          matrix[i * n + j] += element;
          matrix[j * n + i] += element;
        }
      }
    }
  }
  return { n, matrix, diagonal: Float64Array.from(diagonal) };
}

function operatorOf(dense: Dense, counter?: { products: number }): SymmetricOperator {
  const { n, matrix } = dense;
  return {
    dimension: n,
    diagonal: dense.diagonal,
    apply(v, out) {
      if (counter) counter.products++;
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let j = 0; j < n; j++) sum += matrix[i * n + j] * v[j];
        out[i] = sum;
      }
    },
  };
}

const exactSpectrum = (dense: Dense): Float64Array => symmetricEigen(Float64Array.from(dense.matrix), dense.n).values;

function residualNorm(dense: Dense, value: number, vector: Float64Array): number {
  const { n, matrix } = dense;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    let row = -value * vector[i];
    for (let j = 0; j < n; j++) row += matrix[i * n + j] * vector[j];
    sum += row * row;
  }
  return Math.sqrt(sum);
}

describe('lowest eigenvalue of a symmetric operator', () => {
  it('diagonalises small matrices in full', () => {
    const random = generator(11);
    const dense = diagonalPlusRankOne(
      Array.from({ length: EXACT_STABILITY_LIMIT }, () => 1 + random()),
      [
        { coefficient: -1.4, from: 0, to: 20, seed: 3 },
        { coefficient: 0.7, from: 10, to: EXACT_STABILITY_LIMIT, seed: 4 },
      ],
    );
    const counter = { products: 0 };
    const result = lowestEigenpair(operatorOf(dense, counter));
    expect(result.method).toBe('exact');
    expect(result.converged).toBe(true);
    expect(result.products).toBe(EXACT_STABILITY_LIMIT);
    expect(counter.products).toBe(EXACT_STABILITY_LIMIT);
    expect(Math.abs(result.lowestEigenvalue - exactSpectrum(dense)[0])).toBeLessThan(1e-12);
    expect(residualNorm(dense, result.lowestEigenvalue, result.vector)).toBeLessThan(1e-10);
    expect(lowestEigenpair({ dimension: 0, diagonal: new Float64Array(0), apply: () => undefined })).toMatchObject({ lowestEigenvalue: Infinity, converged: true, products: 0 });
  });

  it('finds a negative eigenvalue that is decoupled from the smallest diagonal elements', () => {
    // Two blocks that do not couple, like two symmetry species. The block with the small diagonal
    // elements (the "small orbital-energy gaps") is positive definite; the negative eigenvalue
    // sits in the other block. A search seeded with the smallest-gap unit vectors converges inside
    // the first block and reports its lowest eigenvalue: the fault this routine used to have.
    const random = generator(5);
    const diagonal = [...Array.from({ length: 30 }, () => 0.3 + 0.2 * (random() + 0.5)), ...Array.from({ length: 30 }, () => 1.0 + 0.6 * (random() + 0.5))];
    const dense = diagonalPlusRankOne(diagonal, [
      { coefficient: -0.15, from: 0, to: 30, seed: 21 },
      { coefficient: -1.9, from: 30, to: 60, seed: 22 },
    ]);
    const spectrum = exactSpectrum(dense);
    const firstBlock = symmetricEigen(
      Float64Array.from({ length: 900 }, (_, k) => dense.matrix[Math.floor(k / 30) * 60 + (k % 30)]),
      30,
    ).values[0];
    expect(firstBlock).toBeGreaterThan(0.1);
    expect(spectrum[0]).toBeLessThan(-0.2);

    const result = lowestEigenpair(operatorOf(dense));
    expect(result.method).toBe('iterative');
    expect(result.converged).toBe(true);
    expect(Math.abs(result.lowestEigenvalue - spectrum[0])).toBeLessThan(1e-6);
    expect(residualNorm(dense, result.lowestEigenvalue, result.vector)).toBeLessThan(1e-4);
    expect(result.products).toBeLessThan(40);
  });

  it('certifies positive definite matrices and reports an upper bound to the lowest eigenvalue', () => {
    const random = generator(77);
    const dense = diagonalPlusRankOne(
      Array.from({ length: 120 }, () => 0.4 + 2.5 * (random() + 0.5)),
      [
        { coefficient: -0.25, from: 0, to: 120, seed: 31 },
        { coefficient: 0.8, from: 20, to: 90, seed: 32 },
        { coefficient: -0.2, from: 60, to: 120, seed: 33 },
      ],
    );
    const lowest = exactSpectrum(dense)[0];
    expect(lowest).toBeGreaterThan(0.05);
    const result = lowestEigenpair(operatorOf(dense));
    expect(result).toMatchObject({ method: 'iterative', converged: true, cancelled: false, softModes: 0 });
    expect(result.lowestEigenvalue).toBeGreaterThan(lowest - 1e-10);
    expect(result.products).toBeLessThan(40);
  });

  it('sets aside zero modes instead of mistaking them for instabilities or stalling on them', () => {
    // B positive definite, then projected: M = (1 - z1 z1^T - z2 z2^T) B (1 - ...) has two exact
    // zero eigenvalues, as the Hessian of a solution that breaks a continuous symmetry has.
    const n = 70;
    const random = generator(123);
    const base = diagonalPlusRankOne(
      Array.from({ length: n }, () => 0.5 + 1.5 * (random() + 0.5)),
      [{ coefficient: 0.6, from: 0, to: n, seed: 41 }],
    );
    const z: Float64Array[] = [];
    for (let k = 0; k < 2; k++) {
      const v = Float64Array.from({ length: n }, () => random());
      for (const other of z) {
        let overlap = 0;
        for (let i = 0; i < n; i++) overlap += v[i] * other[i];
        for (let i = 0; i < n; i++) v[i] -= overlap * other[i];
      }
      const norm = Math.hypot(...v);
      z.push(v.map((x) => x / norm));
    }
    const projector = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) projector[i * n + j] = (i === j ? 1 : 0) - z[0][i] * z[0][j] - z[1][i] * z[1][j];
    }
    const product = (a: Float64Array, b: Float64Array): Float64Array => {
      const out = new Float64Array(n * n);
      for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) out[i * n + j] += a[i * n + k] * b[k * n + j];
      return out;
    };
    const dense: Dense = { n, matrix: product(projector, product(base.matrix, projector)), diagonal: base.diagonal };
    const spectrum = exactSpectrum(dense);
    expect(Math.abs(spectrum[0])).toBeLessThan(1e-12);
    expect(Math.abs(spectrum[1])).toBeLessThan(1e-12);
    expect(spectrum[2]).toBeGreaterThan(0.1);

    const result = lowestEigenpair(operatorOf(dense));
    expect(result.converged).toBe(true);
    expect(Math.abs(result.lowestEigenvalue)).toBeLessThan(THRESHOLD);
    expect(result.softModes).toBeGreaterThanOrEqual(1);

    // The same matrix with one of the zero modes pushed below the threshold is unstable.
    const shifted = Float64Array.from(dense.matrix);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) shifted[i * n + j] -= 1e-3 * z[1][i] * z[1][j];
    const unstable = lowestEigenpair(operatorOf({ n, matrix: shifted, diagonal: base.diagonal }));
    expect(unstable.converged).toBe(true);
    expect(Math.abs(unstable.lowestEigenvalue + 1e-3)).toBeLessThan(1e-6);
  });

  it('reaches the verdict of a full diagonalisation for 300 random matrices', () => {
    const random = generator(2024);
    const tally = { unstable: 0, stable: 0, zeroModes: 0, maxProducts: 0, totalProducts: 0, belowExact: 0, wrong: 0, unconverged: 0 };
    for (let sample = 0; sample < 300; sample++) {
      const n = 33 + Math.floor((random() + 0.5) * 60);
      const scale = 0.2 + 3 * (random() + 0.5);
      const diagonal = Array.from({ length: n }, () => 0.15 + scale * (random() + 0.5));
      // A few blocks that do not couple, each with a rank-one coupling of either sign and dense
      // random couplings inside the block; strong negative ones create instabilities, in blocks
      // that need not contain the small diagonal elements.
      const blocks = 1 + Math.floor((random() + 0.5) * 4);
      const terms = [];
      for (let b = 0; b < blocks; b++) {
        const from = Math.floor((b * n) / blocks);
        const to = Math.floor(((b + 1) * n) / blocks);
        const strength = (random() + 0.5) * 1.2 * (0.15 + scale);
        terms.push({ coefficient: random() < 0.1 ? strength : -strength, from, to, seed: 1000 + 7 * sample + b });
      }
      const dense = diagonalPlusRankOne(diagonal, terms, 0.06 * scale * (random() + 0.5));
      const lowest = exactSpectrum(dense)[0];
      const result = lowestEigenpair(operatorOf(dense));
      const trulyUnstable = lowest < -THRESHOLD;
      if (trulyUnstable) tally.unstable++;
      else tally.stable++;
      if (Math.abs(lowest) <= THRESHOLD) tally.zeroModes++;
      if (!result.converged) tally.unconverged++;
      if (result.lowestEigenvalue < -THRESHOLD !== trulyUnstable) tally.wrong++;
      if (result.lowestEigenvalue < lowest - 1e-8) tally.belowExact++;
      if (trulyUnstable && result.converged) expect(Math.abs(result.lowestEigenvalue - lowest), `sample ${sample}`).toBeLessThan(1e-5);
      tally.maxProducts = Math.max(tally.maxProducts, result.products);
      tally.totalProducts += result.products;
    }
    record('random-matrices', { samples: 300, ...tally, meanProducts: tally.totalProducts / 300 });
    expect(tally.unstable).toBeGreaterThan(50);
    expect(tally.stable).toBeGreaterThan(50);
    expect(tally.wrong).toBe(0);
    expect(tally.belowExact).toBe(0);
    expect(tally.unconverged).toBe(0);
  });

  it('reports an unfinished search as not converged and stops when cancelled', () => {
    const random = generator(9);
    const dense = diagonalPlusRankOne(
      Array.from({ length: 80 }, () => 0.4 + 2 * (random() + 0.5)),
      Array.from({ length: 12 }, (_, k) => ({ coefficient: k % 2 === 0 ? -0.05 : 0.3, from: 0, to: 80, seed: 51 + k })),
    );
    expect(lowestEigenpair(operatorOf(dense))).toMatchObject({ converged: true, method: 'iterative' });
    const short = lowestEigenpair(operatorOf(dense), { maxProducts: 3 });
    expect(short).toMatchObject({ converged: false, cancelled: false, products: 3 });
    expect(short.lowestEigenvalue).toBeGreaterThan(exactSpectrum(dense)[0] - 1e-10);

    let polls = 0;
    const cancelled = lowestEigenpair(operatorOf(dense), { isCancelled: () => ++polls > 2 });
    expect(cancelled).toMatchObject({ converged: false, cancelled: true, products: 3 });

    const small = diagonalPlusRankOne([1, 2, 3, 4], []);
    expect(lowestEigenpair(operatorOf(small), { isCancelled: () => true })).toMatchObject({ converged: false, cancelled: true, products: 0 });
  });
});

interface System {
  readonly name: string;
  readonly orientation?: string;
  readonly charge: number;
  readonly atoms: { readonly z: number; readonly position: [number, number, number] }[];
}

describe('orbital-rotation Hessians of the reference systems', () => {
  const challenging = readJsonFixture<{ systems: System[] }>('pyscf_challenging.json').systems;
  const systems: System[] = [...challenging, ...pyscfFixture().molecules];
  const rows: Record<string, unknown>[] = [];

  function prepare(system: System) {
    const atoms = atomsToBohr(system.atoms);
    const basis = buildBasisBohr(atoms);
    const nuclei = atoms.map((atom) => ({ charge: atom.z, x: atom.x, y: atom.y, z: atom.zCoord }));
    const nElectrons = system.atoms.reduce((sum, atom) => sum + atom.z, 0) - system.charge;
    return { basis, nuclei, nElectrons };
  }

  /** Every eigenvalue of the Hessian, from the explicitly built matrix. */
  function fullSpectrum(problem: StabilityProblem): Float64Array {
    const hessian = new RotationHessian(problem);
    const d = hessian.dimension;
    const matrix = new Float64Array(d * d);
    const unit = new Float64Array(d);
    const column = new Float64Array(d);
    for (let k = 0; k < d; k++) {
      unit[k] = 1;
      hessian.apply(unit, column);
      unit[k] = 0;
      for (let row = 0; row < d; row++) matrix[row * d + k] = column[row];
    }
    let asymmetry = 0;
    for (let i = 0; i < d; i++) {
      for (let j = 0; j < i; j++) {
        asymmetry = Math.max(asymmetry, Math.abs(matrix[i * d + j] - matrix[j * d + i]));
        matrix[j * d + i] = matrix[i * d + j];
      }
    }
    // The product is symmetric to rounding; its elements are checked against the formula in scf.test.ts.
    expect(asymmetry).toBeLessThan(1e-10);
    return symmetricEigen(matrix, d).values;
  }

  it('gives the verdict of a full diagonalisation at every final solution and every saddle point', () => {
    for (const system of systems) {
      const { basis, nuclei, nElectrons } = prepare(system);
      const n = basis.nBasis;
      const final = runRhfCore(basis, nuclei, nElectrons);
      const nOcc = final.nOccupied;
      const dimension = nOcc * (n - nOcc);
      const label = system.orientation ? `${system.name} (${system.orientation})` : system.name;
      if (dimension === 0) {
        expect(final.stability, label).toMatchObject({ verified: true, lowestEigenvalue: null, hessianProducts: 0 });
        continue;
      }
      const eri = computeEri(basis, buildShellPairs(basis)).values;
      // The final solution, and the solutions the SCF returns when it may leave fewer saddle points.
      const solutions = [{ tag: 'final', result: final }];
      for (let follows = 0; follows < final.stability.saddlePointsLeft; follows++) {
        solutions.push({ tag: `saddle point ${follows + 1}`, result: runRhfCore(basis, nuclei, nElectrons, {}, { maxInstabilityFollows: follows }) });
      }
      for (const { tag, result } of solutions) {
        const what = `${label}, ${tag}`;
        const problem: StabilityProblem = { n, nOcc, coefficients: result.orbitalCoefficients, orbitalEnergies: result.orbitalEnergies, eri };
        const exact = fullSpectrum(problem);
        const unstable = exact[0] < -THRESHOLD;
        expect(unstable, what).toBe(tag !== 'final');

        // The search the engine uses for this size ...
        const standard = lowestRotationEigenpair(problem, { instabilityThreshold: THRESHOLD });
        expect(standard.method, what).toBe(dimension <= EXACT_STABILITY_LIMIT ? 'exact' : 'iterative');
        // ... and the iterative one forced on every size.
        const iterative = lowestRotationEigenpair(problem, { instabilityThreshold: THRESHOLD, exactLimit: 0 });
        for (const search of [standard, iterative]) {
          expect(search.converged, what).toBe(true);
          expect(search.lowestEigenvalue < -THRESHOLD, what).toBe(unstable);
          // Never below the true lowest eigenvalue; equal to it when exact or when an unstable mode was converged.
          expect(search.lowestEigenvalue, what).toBeGreaterThan(exact[0] - 1e-8);
          if (search.method === 'exact' || unstable) expect(Math.abs(search.lowestEigenvalue - exact[0]), what).toBeLessThan(1e-6);
        }

        // What the SCF driver itself concluded about this solution. It analyses the orbitals of
        // its last iteration, this test the returned ones (eigenvectors of the final Fock matrix);
        // the two differ by the SCF convergence threshold, and so do the eigenvalues: 2e-8 hartree
        // was observed for the zero mode of stretched N2. Hence 1e-6 here instead of 1e-8.
        expect(result.stability.lowestEigenvalueIsExact, what).toBe(dimension <= EXACT_STABILITY_LIMIT);
        expect(result.stability.lowestEigenvalue! < -THRESHOLD, what).toBe(unstable);
        expect(result.stability.lowestEigenvalue!, what).toBeGreaterThan(exact[0] - 1e-6);
        if (result.stability.lowestEigenvalueIsExact) expect(Math.abs(result.stability.lowestEigenvalue! - exact[0]), what).toBeLessThan(1e-6);
        if (tag === 'final') {
          expect(result.stability.verified, what).toBe(true);
          expect(result.warnings, what).toEqual([]);
        } else {
          expect(result.converged, what).toBe(true);
          expect(result.warnings.join(' '), what).toMatch(/saddle point of the energy/);
          expect(result.energy.total, what).toBeGreaterThan(final.energy.total + 1e-6);
        }
        rows.push({
          system: label,
          solution: tag,
          dimension,
          exactLowest: exact[0],
          exactSecond: exact.length > 1 ? exact[1] : null,
          engineValue: result.stability.lowestEigenvalue,
          engineExact: result.stability.lowestEigenvalueIsExact,
          standardProducts: standard.products,
          iterativeValue: iterative.lowestEigenvalue,
          iterativeProducts: iterative.products,
          softModes: iterative.softModes,
          energy: result.energy.total,
        });
      }
    }
    record('hessians', rows);
    expect(rows.length).toBeGreaterThan(70);
    expect(rows.filter((row) => row.solution !== 'final').length).toBeGreaterThanOrEqual(12);
  });

  it('sees the modes the previous eigenvalue search overlooked', () => {
    // Stretched N2 (2.5 A): the lowest eigenvalue is a zero mode (the solution occupies one of two
    // degenerate pi directions); the earlier Davidson search reported 0.0451, the third eigenvalue.
    const n2 = rows.find((row) => row.system === 'N2 stretched (2.5 A)' && row.solution === 'final')!;
    expect(Math.abs(n2.exactLowest as number)).toBeLessThan(THRESHOLD);
    expect(n2.exactSecond as number).toBeLessThan(0.01);
    expect(Math.abs(n2.engineValue as number)).toBeLessThan(THRESHOLD);
    // Ethane: the lowest eigenvalue is doubly degenerate; the earlier search reported 0.7651.
    const ethane = rows.find((row) => row.system === 'C2H6 (general)')!;
    expect(ethane.dimension).toBe(63);
    expect(Math.abs((ethane.exactLowest as number) - (ethane.exactSecond as number))).toBeLessThan(1e-6);
    expect(ethane.exactLowest as number).toBeLessThan(0.76);
    expect(ethane.engineExact).toBe(false);
  });

  it('finds zero modes exactly where a solution breaks the axial symmetry of a linear molecule', () => {
    // A closed-shell solution that occupies one of two degenerate pi directions of a linear
    // molecule can be rotated about the axis at no cost in energy, so its Hessian has a zero
    // eigenvalue. Whether a solution does that shows in its density matrix: on every atom the
    // 2 x 2 block of the two p functions perpendicular to the axis (z here) has two equal
    // eigenvalues if and only if the density is axially symmetric there.
    //
    // "Equal" has to be read against how far the SCF was converged. The default thresholds stop
    // once the energy changes by less than 1e-9 hartree and the density by less than 1e-7 (RMS)
    // per iteration; a soft mode can then still carry a density error of a few 1e-6 (P2, whose
    // iterations pass a symmetry-broken saddle point on the way, keeps 4.7e-6). That residual is
    // five orders of magnitude below the splitting of a symmetry-broken solution (0.08 to 2.0
    // here), and it vanishes when the thresholds are tightened, which is what distinguishes it
    // from symmetry breaking. Both facts are asserted.
    const linear = challenging.filter((system) => system.atoms.length >= 2 && system.atoms.every((atom) => atom.position[0] === 0 && atom.position[1] === 0));
    expect(linear.length).toBeGreaterThanOrEqual(8);
    const splittingOf = (result: ReturnType<typeof runRhf>): number => {
      const n = result.nBasis;
      const p = result.densityMatrix;
      let splitting = 0;
      for (const fx of result.basisFunctions.filter((f) => f.shell.endsWith('px'))) {
        const fy = result.basisFunctions.find((f) => f.atomIndex === fx.atomIndex && f.shell === fx.shell.replace('px', 'py'))!;
        const [xx, yy, xy] = [p[fx.index * n + fx.index], p[fy.index * n + fy.index], p[fx.index * n + fy.index]];
        splitting = Math.max(splitting, Math.sqrt((xx - yy) ** 2 + 4 * xy * xy));
      }
      return splitting;
    };
    const observed: Record<string, unknown>[] = [];
    for (const system of linear) {
      const input = { atoms: system.atoms, charge: system.charge };
      const splitting = splittingOf(runRhf(input));
      const row = rows.find((candidate) => candidate.system === system.name && candidate.solution === 'final')!;
      const zeroMode = Math.abs(row.exactLowest as number) < THRESHOLD;
      expect(splitting > 1e-3, system.name).toBe(zeroMode);
      let tightSplitting: number | null = null;
      if (!zeroMode) {
        expect(splitting, system.name).toBeLessThan(1e-4);
        const tight = runRhf(input, { energyTolerance: 1e-11, densityTolerance: 1e-9, maxIterations: 400 });
        expect(tight.converged, system.name).toBe(true);
        tightSplitting = splittingOf(tight);
        expect(tightSplitting, system.name).toBeLessThan(1e-9);
      }
      observed.push({ system: system.name, lowestEigenvalue: row.exactLowest, splitting, splittingTightlyConverged: tightSplitting, zeroMode });
    }
    record('axial-symmetry', observed);
    expect(observed.filter((entry) => entry.zeroMode).map((entry) => entry.system)).toEqual(['N2 stretched (1.6 A)', 'N2 stretched (2.5 A)', 'O2 closed-shell singlet', 'C2']);
    // The smallest splitting of a symmetry-broken solution stays far above every convergence residual.
    const broken = observed.filter((entry) => entry.zeroMode).map((entry) => entry.splitting as number);
    expect(Math.min(...broken)).toBeGreaterThan(0.05);
  });

  it('returns a saddle point with a warning when it may not leave it', () => {
    const reference = findMolecule('N2', 'canonical');
    const { basis, nuclei, nElectrons } = prepare(reference);
    const saddle = runRhfCore(basis, nuclei, nElectrons, {}, { maxInstabilityFollows: 0 });
    expect(saddle.converged).toBe(true);
    expect(saddle.stability).toMatchObject({ verified: false, saddlePointsLeft: 0 });
    expect(saddle.stability.lowestEigenvalue!).toBeLessThan(-0.3);
    expect(saddle.warnings).toHaveLength(1);
    expect(saddle.warnings[0]).toMatch(/saddle point of the energy.*could not be reached/);
    // It is the solution PySCF converges to from the same starting guess.
    expect(Math.abs(saddle.energy.total - reference.coreGuess.totalEnergy)).toBeLessThan(1e-6);
  });

  it('warns when the iterative search runs out of products', () => {
    const reference = findMolecule('C6H6');
    const { basis, nuclei, nElectrons } = prepare(reference);
    const result = runRhfCore(basis, nuclei, nElectrons, {}, { stability: { maxProducts: 3 } });
    expect(result.converged).toBe(true);
    expect(result.stability).toMatchObject({ verified: false, lowestEigenvalueIsExact: false, hessianProducts: 3 });
    expect(result.warnings.join(' ')).toMatch(/stability analysis of the SCF solution did not converge/);
    expect(Math.abs(result.energy.total - reference.energy.total)).toBeLessThan(1e-6);
  });
});
