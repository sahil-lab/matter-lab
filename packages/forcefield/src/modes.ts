/*
 * Curvature analysis of a stationary geometry: is it a minimum, or a saddle point the optimiser
 * was trapped on by the symmetry of a hand-built start (a planar methane, a linear water, an
 * eclipsed ethane, a flat cyclohexane)?
 *
 * A gradient-following minimiser can never leave such a point, because the force along the
 * unstable direction is exactly zero. The remedy is to look at the second derivatives. The lowest
 * eigenvalue of the Hessian is found with a Lanczos iteration (full reorthogonalisation) on
 * Hessian-vector products obtained by central differences of the analytic gradient, so no second
 * derivatives have to be coded. This is not part of RDKit, which simply returns the saddle point.
 */
import type { UffKernel } from './builder';
import { evaluate } from './energy';

/** Displacement (angstrom) of the central-difference Hessian-vector product. */
const FD_STEP = 1e-4;
/** Curvatures above this (kcal/mol/angstrom^2) are not treated as unstable: flat rotors and rounding noise. */
const UNSTABLE_CURVATURE = -0.01;
/**
 * The finite-difference Hessian is only accurate to about this fraction of its largest eigenvalue,
 * so a "negative" curvature smaller than that is noise. It matters for the rare systems whose
 * stiffness is astronomically large.
 */
const RELATIVE_CURVATURE_NOISE = 1e-6;
/** Largest Krylov space built. Up to this many free coordinates (80 atoms) the lowest eigenvalue is exact. */
export const MAX_LANCZOS = 240;

export interface LowestMode {
  /** Lowest Hessian eigenvalue found, kcal/mol/angstrom^2 (never below the true lowest one). */
  readonly curvature: number;
  /** Unit vector along which the energy has that curvature. */
  readonly vector: Float64Array;
  /** True if the value is converged: the Krylov space spans all free coordinates, or the iteration settled. */
  readonly converged: boolean;
  /** True if the curvature is negative beyond numerical noise: the geometry is not a minimum. */
  readonly unstable: boolean;
}

/** Deterministic pseudo-random number in [-1, 1) from two integers (a mulberry32-style mix). */
export function hashUnit(a: number, b: number): number {
  let h = (Math.imul(a + 1, 0x9e3779b1) ^ Math.imul(b + 1, 0x85ebca6b)) | 0;
  h = Math.imul(h ^ (h >>> 15), h | 1);
  h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
  h = (h ^ (h >>> 14)) >>> 0;
  return h / 2147483648 - 1;
}

/** Number of eigenvalues of the symmetric tridiagonal matrix (alpha, beta) that are smaller than x. */
function sturmCount(alpha: Float64Array, beta: Float64Array, m: number, x: number): number {
  let count = 0;
  let q = alpha[0] - x;
  if (q < 0) count++;
  for (let i = 1; i < m; i++) {
    const denom = q === 0 ? 1e-300 : q;
    q = alpha[i] - x - (beta[i - 1] * beta[i - 1]) / denom;
    if (q < 0) count++;
  }
  return count;
}

/**
 * Smallest eigenvalue of the m x m symmetric tridiagonal matrix (alpha, beta) by bisection; its
 * eigenvector, by inverse iteration, is written to y.
 */
function lowestTridiagonalPair(alpha: Float64Array, beta: Float64Array, m: number, y: Float64Array): number {
  if (m === 1) {
    y[0] = 1;
    return alpha[0];
  }
  // Gershgorin bounds
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < m; i++) {
    const r = (i > 0 ? Math.abs(beta[i - 1]) : 0) + (i < m - 1 ? Math.abs(beta[i]) : 0);
    lo = Math.min(lo, alpha[i] - r);
    hi = Math.max(hi, alpha[i] + r);
  }
  const span = Math.max(hi - lo, 1e-300);
  for (let it = 0; it < 200 && hi - lo > 1e-14 * span; it++) {
    const mid = 0.5 * (lo + hi);
    if (sturmCount(alpha, beta, m, mid) >= 1) hi = mid;
    else lo = mid;
  }
  const theta = 0.5 * (lo + hi);
  // Inverse iteration with a shift just below the eigenvalue: T - shift is positive definite, so
  // the Thomas algorithm needs no pivoting.
  const shift = theta - 1e-9 * span;
  const c = new Float64Array(m);
  const d = new Float64Array(m);
  for (let i = 0; i < m; i++) y[i] = 1 + 0.5 * hashUnit(i, 7919);
  for (let pass = 0; pass < 4; pass++) {
    let denom = alpha[0] - shift;
    c[0] = beta[0] / denom;
    d[0] = y[0] / denom;
    for (let i = 1; i < m; i++) {
      denom = alpha[i] - shift - beta[i - 1] * c[i - 1];
      if (i < m - 1) c[i] = beta[i] / denom;
      d[i] = (y[i] - beta[i - 1] * d[i - 1]) / denom;
    }
    y[m - 1] = d[m - 1];
    for (let i = m - 2; i >= 0; i--) y[i] = d[i] - c[i] * y[i + 1];
    let norm = 0;
    for (let i = 0; i < m; i++) norm += y[i] * y[i];
    norm = Math.sqrt(norm);
    if (!(norm > 0) || !Number.isFinite(norm)) break;
    for (let i = 0; i < m; i++) y[i] /= norm;
  }
  return theta;
}

/**
 * Finds the direction of lowest curvature of the energy at `x`. Frozen atoms are held fixed: their
 * coordinates are not part of the search space. Returns null if nothing can move or the gradient
 * is not finite around `x`.
 */
export function lowestCurvatureMode(kernel: UffKernel, x: Float64Array, frozen: Uint8Array | null): LowestMode | null {
  const dim = x.length;
  const mask = new Float64Array(dim);
  let nFree = 0;
  for (let i = 0; i < dim; i++) {
    if (frozen === null || !frozen[(i / 3) | 0]) {
      mask[i] = 1;
      nFree++;
    }
  }
  if (nFree === 0) return null;
  const m = Math.min(nFree, MAX_LANCZOS);

  // Every vector below is zero on frozen coordinates, so plain loops over all coordinates are safe.
  const basis = new Float64Array((m + 1) * dim);
  const alpha = new Float64Array(m);
  const beta = new Float64Array(m);
  const w = new Float64Array(dim);
  const xp = new Float64Array(dim);
  const gPlus = new Float64Array(dim);
  const gMinus = new Float64Array(dim);
  const y = new Float64Array(m);

  // starting vector: deterministic, with a component along every free coordinate
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    const v = mask[i] * hashUnit(i, 104729);
    basis[i] = v;
    norm += v * v;
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < dim; i++) basis[i] /= norm;

  let size = 0;
  let scale = 0;
  let previousBeta = 0;
  let theta = 0;
  let converged = false;
  let unstable = false;
  for (let k = 0; k < m; k++) {
    const vk = k * dim;
    // w = H v by central differences of the analytic gradient
    for (let i = 0; i < dim; i++) xp[i] = x[i] + FD_STEP * basis[vk + i];
    evaluate(kernel, xp, gPlus, null);
    for (let i = 0; i < dim; i++) xp[i] = x[i] - FD_STEP * basis[vk + i];
    evaluate(kernel, xp, gMinus, null);
    let a = 0;
    for (let i = 0; i < dim; i++) {
      const hv = (mask[i] * (gPlus[i] - gMinus[i])) / (2 * FD_STEP);
      w[i] = hv;
      a += hv * basis[vk + i];
    }
    if (!Number.isFinite(a)) return null;
    alpha[k] = a;
    // orthogonalise against every previous vector, twice (this includes the three-term recurrence)
    for (let pass = 0; pass < 2; pass++) {
      for (let j = k; j >= 0; j--) {
        const vj = j * dim;
        let dot = 0;
        for (let i = 0; i < dim; i++) dot += w[i] * basis[vj + i];
        for (let i = 0; i < dim; i++) w[i] -= dot * basis[vj + i];
      }
    }
    let b = 0;
    for (let i = 0; i < dim; i++) b += w[i] * w[i];
    b = Math.sqrt(b);
    // Gershgorin estimate of the largest eigenvalue: the scale of the Hessian
    scale = Math.max(scale, Math.abs(a) + b + previousBeta);
    previousBeta = b;
    const threshold = Math.min(UNSTABLE_CURVATURE, -RELATIVE_CURVATURE_NOISE * scale);

    size = k + 1;
    const breakdown = !(b > 1e-9 * Math.max(scale, 1));
    const last = size === m || breakdown;
    if (last || size % 8 === 0) {
      theta = lowestTridiagonalPair(alpha, beta, size, y);
      const residual = breakdown || size === nFree ? 0 : b * Math.abs(y[size - 1]);
      // An unstable direction is established as soon as its Ritz value is clearly negative and
      // settled; a minimum can only be asserted once the whole space has been explored.
      const saddleSettled = theta < threshold && residual <= 0.1 * Math.abs(theta);
      if (last || saddleSettled) {
        converged = saddleSettled || residual <= 0.1 * Math.max(Math.abs(theta), -threshold);
        unstable = theta < threshold;
        break;
      }
    }
    beta[k] = b;
    const vn = (k + 1) * dim;
    for (let i = 0; i < dim; i++) basis[vn + i] = w[i] / b;
  }

  const vector = new Float64Array(dim);
  for (let j = 0; j < size; j++) {
    const vj = j * dim;
    const yj = y[j];
    for (let i = 0; i < dim; i++) vector[i] += yj * basis[vj + i];
  }
  norm = 0;
  for (let i = 0; i < dim; i++) norm += vector[i] * vector[i];
  norm = Math.sqrt(norm);
  if (!(norm > 0) || !Number.isFinite(norm)) return null;
  for (let i = 0; i < dim; i++) vector[i] /= norm;
  return { curvature: theta, vector, converged, unstable };
}
