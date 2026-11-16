import { describe, expect, it } from 'vitest';
import { buildBasis } from '../src/basis/basis';
import type { Basis } from '../src/basis/basis';
import { computeEri, computeSchwarzBounds, eriIndex, eriShellQuartet } from '../src/integrals/eri';
import { HERMITE_COUNT, HERMITE_SUM, HERMITE_T, HERMITE_U, HERMITE_V, hermiteCoulomb, hermiteIndex } from '../src/integrals/hermite';
import { computeNuclearAttraction, computeOverlapKineticDipole } from '../src/integrals/oneElectron';
import { buildShellPairs } from '../src/integrals/shellPairs';
import { boys } from '../src/math/boys';
import { symmetricEigen } from '../src/math/linalg';
import { atomsToBohr } from '../src/basis/basis';
import { findMolecule, pyscfFixture, toInput } from './helpers/pyscf';
import { validationReporter } from './helpers/report';

const record = validationReporter('integrals');

function nucleiOf(atoms: readonly { z: number; position: readonly [number, number, number] }[]) {
  return atomsToBohr(atoms).map((atom) => ({ charge: atom.z, x: atom.x, y: atom.y, z: atom.zCoord }));
}

describe('Hermite Coulomb integrals', () => {
  it('orders (t, u, v) by total order and indexes sums of pair indices consistently', () => {
    expect(HERMITE_COUNT).toEqual([1, 4, 10, 20, 35]);
    let index = 0;
    for (let order = 0; order <= 4; order++) {
      for (let k = 0; k < HERMITE_COUNT[order] - (order > 0 ? HERMITE_COUNT[order - 1] : 0); k++, index++) {
        expect(HERMITE_T[index] + HERMITE_U[index] + HERMITE_V[index]).toBe(order);
        expect(hermiteIndex(HERMITE_T[index], HERMITE_U[index], HERMITE_V[index])).toBe(index);
      }
    }
    for (let a = 0; a < 10; a++) {
      for (let b = 0; b < 10; b++) {
        const sum = HERMITE_SUM[a * 10 + b];
        expect(HERMITE_T[sum]).toBe(HERMITE_T[a] + HERMITE_T[b]);
        expect(HERMITE_U[sum]).toBe(HERMITE_U[a] + HERMITE_U[b]);
        expect(HERMITE_V[sum]).toBe(HERMITE_V[a] + HERMITE_V[b]);
      }
    }
    expect(() => hermiteIndex(5, 0, 0)).toThrow(RangeError);
  });

  it('evaluates the closed forms to the values of the McMurchie-Davidson recursion', () => {
    // R^n_{000} = (-2 alpha)^n F_n(alpha R^2); R^n_{t+1,u,v} = t R^{n+1}_{t-1,u,v} + x R^{n+1}_{t,u,v}, etc.
    const f = new Float64Array(5);
    const recursion = (t: number, u: number, v: number, n: number, alpha: number, x: number, y: number, z: number): number => {
      if (t < 0 || u < 0 || v < 0) return 0;
      if (t === 0 && u === 0 && v === 0) return (-2 * alpha) ** n * f[n];
      if (t > 0) return (t - 1) * recursion(t - 2, u, v, n + 1, alpha, x, y, z) + x * recursion(t - 1, u, v, n + 1, alpha, x, y, z);
      if (u > 0) return (u - 1) * recursion(t, u - 2, v, n + 1, alpha, x, y, z) + y * recursion(t, u - 1, v, n + 1, alpha, x, y, z);
      return (v - 1) * recursion(t, u, v - 2, n + 1, alpha, x, y, z) + z * recursion(t, u, v - 1, n + 1, alpha, x, y, z);
    };
    const cases = [
      { alpha: 0.37, x: 0.9, y: -1.3, z: 0.4 },
      { alpha: 4.1, x: -0.2, y: 0.05, z: 0.7 },
      { alpha: 55, x: 1.1, y: 0.6, z: -0.8 },
      { alpha: 0.9, x: 0, y: 0, z: 0 },
      { alpha: 1.7, x: 0, y: 2.2, z: 0 },
    ];
    const a = new Float64Array(5);
    const r = new Float64Array(35);
    let worst = 0;
    for (const { alpha, x, y, z } of cases) {
      boys(4, alpha * (x * x + y * y + z * z), f);
      for (let n = 0; n <= 4; n++) a[n] = (-2 * alpha) ** n * f[n];
      for (let order = 0; order <= 4; order++) {
        r.fill(Number.NaN);
        hermiteCoulomb(order, x, y, z, a, r);
        for (let index = 0; index < 35; index++) {
          if (index >= HERMITE_COUNT[order]) {
            expect(r[index]).toBeNaN(); // nothing is written beyond the requested order
            continue;
          }
          const expected = recursion(HERMITE_T[index], HERMITE_U[index], HERMITE_V[index], 0, alpha, x, y, z);
          worst = Math.max(worst, Math.abs(r[index] - expected) / Math.max(1, Math.abs(expected)));
        }
      }
    }
    expect(worst).toBeLessThan(1e-13);
  });
});

describe('integrals against PySCF, element by element', () => {
  const fixture = pyscfFixture();

  it.each(fixture.integrals.map((set) => [set.name, set] as const))('%s: S, T, V, position and two-electron integrals agree to 1e-8', (name, reference) => {
    const molecule = findMolecule(name);
    const basis = buildBasis(molecule.atoms);
    const n = basis.nBasis;
    expect(reference.aoLabels.length).toBe(n);
    // PySCF lists all s shells of an atom before its p shells; map its functions onto ours by label.
    const ours = new Map(basis.functions.map((fn) => [`${fn.atomIndex}:${fn.shell}`, fn.index]));
    const map = reference.aoLabels.map((label) => {
      const index = ours.get(label);
      if (index === undefined) throw new Error(`No basis function ${label}`);
      return index;
    });
    expect(new Set(map).size).toBe(n);

    const pairs = buildShellPairs(basis);
    const oneElectron = computeOverlapKineticDipole(basis, [0, 0, 0]);
    const nuclear = computeNuclearAttraction(basis, pairs, nucleiOf(molecule.atoms));
    const eri = computeEri(basis, pairs);

    const matrixDeviation = (mine: Float64Array, theirs: number[][]): number => {
      let worst = 0;
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) worst = Math.max(worst, Math.abs(mine[map[i] * n + map[j]] - theirs[i][j]));
      return worst;
    };
    const deviation = {
      overlap: matrixDeviation(oneElectron.overlap, reference.overlap),
      kinetic: matrixDeviation(oneElectron.kinetic, reference.kinetic),
      nuclearAttraction: matrixDeviation(nuclear, reference.nuclearAttraction),
      position: Math.max(...[0, 1, 2].map((axis) => matrixDeviation(oneElectron.dipole[axis], reference.position[axis]))),
      eri: 0,
      eriCount: reference.eri.length,
      largestEri: 0,
    };
    let k = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j <= i; j++) {
        const ij = (i * (i + 1)) / 2 + j;
        for (let p = 0; p < n; p++) {
          for (let q = 0; q <= p; q++) {
            if ((p * (p + 1)) / 2 + q > ij) continue;
            const value = eri.values[eriIndex(map[i], map[j], map[p], map[q])];
            deviation.eri = Math.max(deviation.eri, Math.abs(value - reference.eri[k]));
            deviation.largestEri = Math.max(deviation.largestEri, Math.abs(reference.eri[k]));
            k++;
          }
        }
      }
    }
    expect(k).toBe(reference.eri.length);
    record(`pyscf/${name}`, { pyscf: fixture.versions.pyscf, nBasis: n, ...deviation });
    expect(deviation.overlap).toBeLessThan(1e-8);
    expect(deviation.kinetic).toBeLessThan(1e-8);
    expect(deviation.nuclearAttraction).toBeLessThan(1e-8);
    expect(deviation.position).toBeLessThan(1e-8);
    expect(deviation.eri).toBeLessThan(1e-8);
  });
});

describe('structure of the integrals', () => {
  const molecule = findMolecule('H2S');
  const basis = buildBasis(molecule.atoms);
  const n = basis.nBasis;
  const pairs = buildShellPairs(basis);
  const eri = computeEri(basis, pairs);

  it('reproduces the overlap matrix from the Hermite expansion coefficients of the shell pairs', () => {
    // S = E_000 (pi/p)^(3/2): an independent route to S through the data the Coulomb integrals use.
    const { overlap } = computeOverlapKineticDipole(basis);
    let worst = 0;
    for (const pair of pairs) {
      const block = new Float64Array(pair.nf);
      for (let i = 0; i < pair.nPrim; i++) {
        for (let k = 0; k < pair.nnz; k++) {
          if (pair.nzHerm[k] === 0) block[pair.nzFn[k]] += pair.e[i * pair.nnz + k] * Math.pow(Math.PI / pair.p[i], 1.5);
        }
      }
      for (let ia = 0; ia < pair.nfa; ia++) {
        for (let ib = 0; ib < pair.nfb; ib++) {
          worst = Math.max(worst, Math.abs(block[ia * pair.nfb + ib] - overlap[(pair.firstA + ia) * n + pair.firstB + ib]));
        }
      }
    }
    expect(worst).toBeLessThan(1e-13);
  });

  it('gives symmetric one-electron matrices and a positive-definite overlap', () => {
    const { overlap, kinetic, dipole } = computeOverlapKineticDipole(basis, [0.3, -0.4, 0.5]);
    const nuclear = computeNuclearAttraction(basis, pairs, nucleiOf(molecule.atoms));
    for (const matrix of [overlap, kinetic, nuclear, ...dipole]) {
      for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) expect(matrix[i * n + j]).toBe(matrix[j * n + i]);
    }
    expect(symmetricEigen(overlap, n).values[0]).toBeGreaterThan(0);
    expect(symmetricEigen(kinetic, n).values[0]).toBeGreaterThan(0);
    expect(symmetricEigen(nuclear, n).values[n - 1]).toBeLessThan(0);
  });

  it('shifts the position integrals by -origin times the overlap when the origin moves', () => {
    const a = computeOverlapKineticDipole(basis, [0, 0, 0]);
    const origin: [number, number, number] = [1.3, -0.7, 2.1];
    const b = computeOverlapKineticDipole(basis, origin);
    let worst = 0;
    for (let axis = 0; axis < 3; axis++) {
      for (let k = 0; k < n * n; k++) worst = Math.max(worst, Math.abs(b.dipole[axis][k] - (a.dipole[axis][k] - origin[axis] * a.overlap[k])));
    }
    expect(worst).toBeLessThan(1e-13);
  });

  it('computes (ab|cd) and (cd|ab) to the same values', () => {
    const blockA = new Float64Array(256);
    const blockB = new Float64Array(256);
    let worst = 0;
    for (let i = 0; i < pairs.length; i += 3) {
      for (let j = 0; j < pairs.length; j += 5) {
        const bra = pairs[i];
        const ket = pairs[j];
        eriShellQuartet(bra, ket, blockA, 0);
        eriShellQuartet(ket, bra, blockB, 0);
        for (let f = 0; f < bra.nf; f++) for (let g = 0; g < ket.nf; g++) worst = Math.max(worst, Math.abs(blockA[f * ket.nf + g] - blockB[g * bra.nf + f]));
      }
    }
    expect(worst).toBeLessThan(1e-13);
  });

  it('maps all eight index permutations onto one packed entry', () => {
    expect(eri.values.length).toBe((((n * (n + 1)) / 2) * ((n * (n + 1)) / 2 + 1)) / 2);
    const [i, j, k, l] = [7, 2, 9, 4];
    const index = eriIndex(i, j, k, l);
    for (const permutation of [[j, i, k, l], [i, j, l, k], [j, i, l, k], [k, l, i, j], [l, k, i, j], [k, l, j, i], [l, k, j, i]]) {
      expect(eriIndex(permutation[0], permutation[1], permutation[2], permutation[3])).toBe(index);
    }
    const seen = new Set<number>();
    for (let a = 0; a < n; a++) for (let b = 0; b <= a; b++) for (let c = 0; c <= a; c++) for (let d = 0; d <= (c === a ? b : c); d++) seen.add(eriIndex(a, b, c, d));
    expect(seen.size).toBe(eri.values.length);
  });

  it('satisfies the Schwarz inequality and is positive semi-definite as a matrix over function pairs', () => {
    const nPairs = (n * (n + 1)) / 2;
    const full = new Float64Array(nPairs * nPairs);
    let violation = 0;
    for (let ij = 0; ij < nPairs; ij++) {
      for (let kl = 0; kl <= ij; kl++) {
        const value = eri.values[(ij * (ij + 1)) / 2 + kl];
        full[ij * nPairs + kl] = value;
        full[kl * nPairs + ij] = value;
        const bound = Math.sqrt(eri.values[(ij * (ij + 1)) / 2 + ij] * eri.values[(kl * (kl + 1)) / 2 + kl]);
        violation = Math.max(violation, Math.abs(value) - bound);
      }
    }
    expect(violation).toBeLessThan(1e-12);
    // (ij|kl) is the Gram matrix of the pair densities under the Coulomb metric.
    expect(symmetricEigen(full, nPairs).values[0]).toBeGreaterThan(-1e-10);
  });

  it('stores for each shell pair the Schwarz factor sqrt(max (ab|ab))', () => {
    const copy = buildShellPairs(basis);
    computeSchwarzBounds(copy);
    for (const pair of copy) {
      let largest = 0;
      for (let ia = 0; ia < pair.nfa; ia++) {
        for (let ib = 0; ib < pair.nfb; ib++) {
          const [mu, nu] = [pair.firstA + ia, pair.firstB + ib];
          largest = Math.max(largest, eri.values[eriIndex(mu, nu, mu, nu)]);
        }
      }
      expect(Math.abs(pair.schwarz - Math.sqrt(largest))).toBeLessThan(1e-12);
    }
  });
});

describe('integral screening', () => {
  // Three well separated fragments, so that many shell and primitive quartets are negligible.
  const atoms = [
    { z: 9, position: [0, 0, 0] as [number, number, number] },
    { z: 1, position: [0, 0, 0.92] as [number, number, number] },
    { z: 9, position: [9.5, 1.0, -0.5] as [number, number, number] },
    { z: 1, position: [9.5, 1.0, 0.42] as [number, number, number] },
    { z: 18, position: [-3.0, 14.0, 6.0] as [number, number, number] },
  ];
  const basis: Basis = buildBasis(atoms);

  it('changes no integral by more than 1e-11 while skipping most of the work', () => {
    const screened = computeEri(basis, buildShellPairs(basis));
    const exact = computeEri(basis, buildShellPairs(basis, 0), { schwarzThreshold: 0, primitiveThreshold: 0 });
    let worst = 0;
    for (let k = 0; k < exact.values.length; k++) worst = Math.max(worst, Math.abs(exact.values[k] - screened.values[k]));
    record('screening', {
      nBasis: basis.nBasis,
      largestDeviation: worst,
      shellQuartets: { all: exact.shellQuartets, computed: screened.shellQuartets, screened: screened.shellQuartetsScreened },
      primitiveQuartets: { all: exact.primitiveQuartets, computed: screened.primitiveQuartets },
    });
    expect(exact.shellQuartetsScreened).toBe(0);
    expect(screened.shellQuartets + screened.shellQuartetsScreened).toBe(exact.shellQuartets);
    expect(screened.shellQuartetsScreened).toBeGreaterThan(exact.shellQuartets / 4);
    expect(screened.primitiveQuartets).toBeLessThan(exact.primitiveQuartets / 2);
    expect(worst).toBeLessThan(1e-11);
  });

  it('drops negligible primitive pairs without changing the one-electron integrals', () => {
    const kept = buildShellPairs(basis);
    const all = buildShellPairs(basis, 0);
    const count = (list: typeof kept): number => list.reduce((sum, pair) => sum + pair.nPrim, 0);
    expect(count(kept)).toBeLessThan(count(all));
    const nuclei = nucleiOf(atoms);
    const a = computeNuclearAttraction(basis, kept, nuclei);
    const b = computeNuclearAttraction(basis, all, nuclei);
    let worst = 0;
    for (let k = 0; k < a.length; k++) worst = Math.max(worst, Math.abs(a[k] - b[k]));
    expect(worst).toBeLessThan(1e-12);
  });
});

describe('two-electron integrals of the hydrogen molecule', () => {
  it('has the six unique integrals of a two-function basis and they are all positive', () => {
    const basis = buildBasis(toInput(findMolecule('H2', 'canonical')).atoms);
    const eri = computeEri(basis, buildShellPairs(basis));
    expect(eri.values.length).toBe(6);
    expect(eri.shellQuartets).toBe(6);
    expect(Array.from(eri.values).every((value) => value > 0)).toBe(true);
    // (11|11) = (22|22) and (11|12) = (12|22) by symmetry.
    expect(eri.values[eriIndex(0, 0, 0, 0)]).toBeCloseTo(eri.values[eriIndex(1, 1, 1, 1)], 13);
    expect(eri.values[eriIndex(0, 0, 0, 1)]).toBeCloseTo(eri.values[eriIndex(0, 1, 1, 1)], 13);
  });
});
