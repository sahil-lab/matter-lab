import { describe, expect, it } from 'vitest';
import { dot, multiply, multiplyTransposeLeft, solveLinearSystem, symmetricEigen } from '../src/math/linalg';

/** Deterministic pseudo-random numbers in [-1, 1) (mulberry32). */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

function randomSymmetric(n: number, seed: number): Float64Array {
  const random = rng(seed);
  const a = new Float64Array(n * n);
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) a[i * n + j] = a[j * n + i] = random();
  return a;
}

/** Largest element of A V - V diag(values) and of V^T V - I. */
function eigenErrors(a: Float64Array, n: number, values: Float64Array, vectors: Float64Array) {
  let residual = 0;
  let orthogonality = 0;
  for (let i = 0; i < n; i++) {
    for (let r = 0; r < n; r++) {
      let sum = 0;
      for (let k = 0; k < n; k++) sum += a[r * n + k] * vectors[k * n + i];
      residual = Math.max(residual, Math.abs(sum - values[i] * vectors[r * n + i]));
    }
    for (let j = 0; j < n; j++) {
      let sum = 0;
      for (let r = 0; r < n; r++) sum += vectors[r * n + i] * vectors[r * n + j];
      orthogonality = Math.max(orthogonality, Math.abs(sum - (i === j ? 1 : 0)));
    }
  }
  return { residual, orthogonality };
}

describe('symmetricEigen (cyclic Jacobi)', () => {
  it.each([1, 2, 3, 7, 20, 60, 96])('diagonalises a random symmetric %i x %i matrix to machine precision', (n) => {
    const a = randomSymmetric(n, 100 + n);
    const { values, vectors, sweeps } = symmetricEigen(a, n);
    const errors = eigenErrors(a, n, values, vectors);
    expect(errors.residual).toBeLessThan(1e-13 * Math.max(1, n));
    expect(errors.orthogonality).toBeLessThan(1e-13);
    for (let i = 1; i < n; i++) expect(values[i]).toBeGreaterThanOrEqual(values[i - 1]);
    let trace = 0;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      trace += a[i * n + i];
      sum += values[i];
    }
    expect(Math.abs(trace - sum)).toBeLessThan(1e-12 * Math.max(1, n));
    expect(sweeps).toBeLessThan(20);
  });

  it('recovers a prescribed spectrum, including degenerate and widely spread eigenvalues', () => {
    const n = 12;
    const spectrum = [-104.5, -11.2, -11.2, -11.2, -1.3, -0.5, -0.5, 1e-9, 0.2, 0.2, 0.75, 3.0e3];
    // A = Q D Q^T with Q from Gram-Schmidt on a random matrix.
    const q = randomSymmetric(n, 7).map((v, k) => v + (k % (n + 1) === 0 ? 2 : 0));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < i; j++) {
        let overlap = 0;
        for (let r = 0; r < n; r++) overlap += q[r * n + i] * q[r * n + j];
        for (let r = 0; r < n; r++) q[r * n + i] -= overlap * q[r * n + j];
      }
      let norm = 0;
      for (let r = 0; r < n; r++) norm += q[r * n + i] ** 2;
      for (let r = 0; r < n; r++) q[r * n + i] /= Math.sqrt(norm);
    }
    const a = new Float64Array(n * n);
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) for (let k = 0; k < n; k++) a[r * n + c] += q[r * n + k] * spectrum[k] * q[c * n + k];
    const { values, vectors } = symmetricEigen(a, n);
    spectrum.forEach((expected, i) => expect(Math.abs(values[i] - expected)).toBeLessThan(1e-11 * Math.max(1, Math.abs(expected)) + 1e-12));
    const errors = eigenErrors(a, n, values, vectors);
    expect(errors.orthogonality).toBeLessThan(1e-13);
    expect(errors.residual).toBeLessThan(1e-9);
  });

  it('handles diagonal, zero and 2 x 2 matrices exactly', () => {
    const diagonal = new Float64Array([3, 0, 0, 0, -1, 0, 0, 0, 2]);
    expect(Array.from(symmetricEigen(diagonal, 3).values)).toEqual([-1, 2, 3]);
    expect(Array.from(symmetricEigen(new Float64Array(16), 4).values)).toEqual([0, 0, 0, 0]);
    const two = symmetricEigen(new Float64Array([2, 1, 1, 2]), 2);
    expect(two.values[0]).toBeCloseTo(1, 14);
    expect(two.values[1]).toBeCloseTo(3, 14);
    expect(Math.abs(two.vectors[0])).toBeCloseTo(Math.SQRT1_2, 14);
    const swap = symmetricEigen(new Float64Array([0, 1, 1, 0]), 2);
    expect(Array.from(swap.values)).toEqual([-1, 1]);
  });

  it('uses only the symmetric part and rejects non-finite or mis-sized input', () => {
    const lopsided = new Float64Array([1, 4, 0, 3]);
    const symmetric = new Float64Array([1, 2, 2, 3]);
    expect(Array.from(symmetricEigen(lopsided, 2).values)).toEqual(Array.from(symmetricEigen(symmetric, 2).values));
    expect(() => symmetricEigen(new Float64Array([1, Number.NaN, Number.NaN, 1]), 2)).toThrow(RangeError);
    expect(() => symmetricEigen(new Float64Array(5), 2)).toThrow(RangeError);
  });
});

describe('dense helpers', () => {
  it('multiplies matrices', () => {
    const a = new Float64Array([1, 2, 3, 4]);
    const b = new Float64Array([5, 6, 7, 8]);
    const out = new Float64Array(4);
    expect(Array.from(multiply(a, b, 2, out))).toEqual([19, 22, 43, 50]);
    expect(Array.from(multiplyTransposeLeft(a, b, 2, out))).toEqual([26, 30, 38, 44]);
    expect(dot(a, b)).toBe(70);
  });

  it('solves linear systems with pivoting and detects singular ones', () => {
    const n = 9;
    const random = rng(42);
    const a = Float64Array.from({ length: n * n }, () => random());
    // A zero on the diagonal forces a row exchange.
    a[0] = 0;
    const x = Float64Array.from({ length: n }, () => random());
    const b = new Float64Array(n);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) b[i] += a[i * n + j] * x[j];
    const solved = solveLinearSystem(a, b, n);
    expect(solved).not.toBeNull();
    for (let i = 0; i < n; i++) expect(Math.abs(solved![i] - x[i])).toBeLessThan(1e-10);

    expect(solveLinearSystem(new Float64Array([1, 2, 2, 4]), new Float64Array([1, 1]), 2)).toBeNull();
    expect(solveLinearSystem(new Float64Array(4), new Float64Array([1, 1]), 2)).toBeNull();
  });
});
