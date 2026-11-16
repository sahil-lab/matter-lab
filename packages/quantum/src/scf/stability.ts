import { symmetricEigen } from '../math/linalg';
import { buildTwoElectronFock } from './fock';

/**
 * Internal (singlet, real) stability of a closed-shell Hartree-Fock solution.
 *
 * An SCF calculation converges to a stationary point of the energy, which need not be a minimum:
 * started from a poor guess it can settle on a saddle point, i.e. a determinant with the "wrong"
 * orbitals occupied (R. Seeger and J. A. Pople, J. Chem. Phys. 66, 3045 (1977)). Whether that
 * happened is decided by the lowest eigenvalue of the orbital-rotation Hessian restricted to real,
 * spin-restricted rotations between occupied (i, j) and virtual (a, b) orbitals,
 *
 *   H_{ia,jb} = delta_ij delta_ab (e_a - e_i) + 4 (ia|jb) - (ib|ja) - (ij|ab).
 *
 * A negative eigenvalue means the energy can be lowered by mixing occupied and virtual orbitals
 * along the corresponding eigenvector. The matrix is never built: its product with a vector v is
 *
 *   (H v)_ia = (e_a - e_i) v_ia + 4 [C_occ^T G(D) C_virt]_ia,   D = 1/2 (C_occ v C_virt^T + transpose),
 *
 * with G the same two-electron Fock builder the SCF uses, so each product costs one Fock build.
 *
 * How the lowest eigenvalue is searched for depends on the size of the problem, see
 * `lowestEigenpair`: small Hessians are built and diagonalised in full, which is exact; for
 * larger ones the absence of an instability is certified with a conjugate-gradient probe and an
 * unstable mode, if one shows up, is refined with Davidson's method (E. R. Davidson, J. Comput.
 * Phys. 17, 87 (1975)).
 */

export interface StabilityProblem {
  /** Number of basis functions and of doubly occupied orbitals. */
  readonly n: number;
  readonly nOcc: number;
  /** Converged orbitals, [mu * n + i]; the first nOcc columns are occupied. */
  readonly coefficients: Float64Array;
  readonly orbitalEnergies: Float64Array;
  /** Packed two-electron integrals (the `values` of an `EriTable`). */
  readonly eri: Float64Array;
}

export interface StabilityResult {
  /**
   * Lowest eigenvalue found. With method 'exact' it is the lowest eigenvalue. With method
   * 'iterative' it is the lowest Ritz value of the search space, by the variational principle an
   * upper bound to the lowest eigenvalue, so a value below the instability threshold proves an
   * instability even when `converged` is false.
   */
  readonly lowestEigenvalue: number;
  /** Corresponding rotation, [i * nVirt + a], normalised to unit length. */
  readonly vector: Float64Array;
  /**
   * True when the question "is there an instability?" is settled: the whole spectrum is known
   * (exact), an unstable eigenpair has converged, or the certificate that no eigenvalue lies
   * below the instability threshold was obtained.
   */
  readonly converged: boolean;
  readonly cancelled: boolean;
  /** Number of Hessian-vector products, i.e. Fock builds. */
  readonly products: number;
  readonly method: 'exact' | 'iterative';
  /** Converged modes with an eigenvalue close to zero that the iterative search set aside. */
  readonly softModes: number;
}

export interface StabilityOptions {
  /** An eigenvalue below minus this (hartree) is an instability. Default 1e-5. */
  readonly instabilityThreshold?: number;
  /** Residual norm at which an unstable eigenpair counts as converged. Default 1e-4. */
  readonly tolerance?: number;
  /** Relative residual of the probe system at which the absence of instabilities counts as certified. Default 1e-5. */
  readonly certificateTolerance?: number;
  /** Largest dimension for which the matrix is built and diagonalised in full. Default 32. */
  readonly exactLimit?: number;
  /** Maximum number of products of the iterative search. Default 60. */
  readonly maxProducts?: number;
  readonly isCancelled?: () => boolean;
}

/** A symmetric matrix that is only available through its product with a vector. */
export interface SymmetricOperator {
  readonly dimension: number;
  /** Estimate of the diagonal, used as preconditioner (the orbital-energy gaps for the Hessian). */
  readonly diagonal: Float64Array;
  apply(v: Float64Array, out: Float64Array): void;
}

/** Applies the singlet orbital-rotation Hessian to rotations `v` ([i * nVirt + a]). */
export class RotationHessian {
  readonly dimension: number;
  readonly nVirt: number;
  /** Diagonal approximation e_a - e_i, used as preconditioner. */
  readonly gaps: Float64Array;
  private readonly problem: StabilityProblem;
  private readonly half: Float64Array;
  private readonly density: Float64Array;
  private readonly fock: Float64Array;
  private readonly scratch: Float64Array;

  constructor(problem: StabilityProblem) {
    const { n, nOcc, orbitalEnergies } = problem;
    this.problem = problem;
    this.nVirt = n - nOcc;
    this.dimension = nOcc * this.nVirt;
    this.gaps = new Float64Array(this.dimension);
    for (let i = 0; i < nOcc; i++) {
      for (let a = 0; a < this.nVirt; a++) this.gaps[i * this.nVirt + a] = orbitalEnergies[nOcc + a] - orbitalEnergies[i];
    }
    this.half = new Float64Array(n * this.nVirt);
    this.density = new Float64Array(n * n);
    this.fock = new Float64Array(n * n);
    this.scratch = new Float64Array(n * n);
  }

  /** Symmetrised transition density D = 1/2 (C_occ v C_virt^T + C_virt v^T C_occ^T), row-major n x n. */
  transitionDensity(v: Float64Array, out: Float64Array): void {
    const { n, nOcc, coefficients: c } = this.problem;
    const nVirt = this.nVirt;
    const half = this.half;
    half.fill(0);
    for (let mu = 0; mu < n; mu++) {
      for (let i = 0; i < nOcc; i++) {
        const cmi = c[mu * n + i];
        if (cmi === 0) continue;
        for (let a = 0; a < nVirt; a++) half[mu * nVirt + a] += cmi * v[i * nVirt + a];
      }
    }
    for (let mu = 0; mu < n; mu++) {
      for (let nu = 0; nu < n; nu++) {
        let sum = 0;
        for (let a = 0; a < nVirt; a++) sum += half[mu * nVirt + a] * c[nu * n + nOcc + a];
        out[mu * n + nu] = sum;
      }
    }
    for (let mu = 0; mu < n; mu++) {
      for (let nu = 0; nu < mu; nu++) {
        const value = 0.5 * (out[mu * n + nu] + out[nu * n + mu]);
        out[mu * n + nu] = value;
        out[nu * n + mu] = value;
      }
    }
  }

  apply(v: Float64Array, out: Float64Array): void {
    const { n, nOcc, coefficients: c, eri } = this.problem;
    const nVirt = this.nVirt;
    this.transitionDensity(v, this.density);
    buildTwoElectronFock(eri, this.density, n, this.fock, this.scratch);
    // half = G C_virt
    const half = this.half;
    for (let mu = 0; mu < n; mu++) {
      for (let a = 0; a < nVirt; a++) {
        let sum = 0;
        for (let nu = 0; nu < n; nu++) sum += this.fock[mu * n + nu] * c[nu * n + nOcc + a];
        half[mu * nVirt + a] = sum;
      }
    }
    for (let i = 0; i < nOcc; i++) {
      for (let a = 0; a < nVirt; a++) {
        let sum = 0;
        for (let mu = 0; mu < n; mu++) sum += c[mu * n + i] * half[mu * nVirt + a];
        out[i * nVirt + a] = this.gaps[i * nVirt + a] * v[i * nVirt + a] + 4 * sum;
      }
    }
  }
}

function dotProduct(a: Float64Array, b: Float64Array): number {
  let sum = 0;
  for (let k = 0; k < a.length; k++) sum += a[k] * b[k];
  return sum;
}

/** Removes the components along `basis` from `v` (twice, for numerical orthogonality) and normalises; returns the norm before normalising. */
function orthonormalise(v: Float64Array, basis: readonly Float64Array[]): number {
  for (let pass = 0; pass < 2; pass++) {
    for (const b of basis) {
      const overlap = dotProduct(v, b);
      for (let k = 0; k < v.length; k++) v[k] -= overlap * b[k];
    }
  }
  const norm = Math.sqrt(dotProduct(v, v));
  if (norm > 0) for (let k = 0; k < v.length; k++) v[k] /= norm;
  return norm;
}

/** Removes the components along the orthonormal `vectors` from `v` (one pass). */
function projectOut(v: Float64Array, vectors: readonly Float64Array[]): void {
  for (const x of vectors) {
    const overlap = dotProduct(v, x);
    if (overlap !== 0) for (let k = 0; k < v.length; k++) v[k] -= overlap * x[k];
  }
}

/** Default for `StabilityOptions.exactLimit`. */
export const EXACT_STABILITY_LIMIT = 32;
/** The preconditioner is the diagonal estimate, not smaller than this. */
const PRECONDITIONER_FLOOR = 0.05;
/** A converged mode with an eigenvalue up to this is set aside instead of being iterated on. */
const SOFT_MODE_LIMIT = 0.02;
/** Residual norm required of a mode before it is set aside. */
const SOFT_MODE_TOLERANCE = 1e-6;

/**
 * Lowest eigenvalue of a symmetric operator, with the corresponding eigenvector, for deciding
 * whether an eigenvalue below `-instabilityThreshold` exists.
 *
 * Up to `exactLimit` dimensions the matrix is built column by column and diagonalised: the answer
 * is exact and costs as many products as there are dimensions.
 *
 * Beyond that the search is iterative, and an iterative eigenvalue search that stops when its
 * lowest Ritz pair has converged can settle on an eigenvalue that is not the lowest: if the true
 * lowest mode belongs to another symmetry species than the vectors the search started from, the
 * search space never acquires a usable component along it. (An earlier version of this routine,
 * Davidson's method started from the smallest-gap rotations plus one random vector, did exactly
 * that for stretched N2 and for ethane.) The iterative branch therefore does not rely on the
 * convergence of an eigenpair to conclude that there is no instability. It runs preconditioned
 * conjugate gradients on (H + threshold) y = b for a pseudo-random probe b, keeping the search
 * directions, and monitors the Ritz values of H in the space they span:
 *
 *  - a Ritz value below -threshold proves an instability; from then on the space is extended
 *    with Davidson corrections until that eigenpair has converged;
 *  - otherwise, once the relative residual of the linear system is below `certificateTolerance`,
 *    the absence of an instability is certified in the following sense. In a Krylov space the
 *    residual is r = p(A) b with p(0) = 1 and the Ritz values as the roots of p. If they are all
 *    positive while A = H + threshold has a negative eigenvalue, |p| exceeds 1 there, so the
 *    relative residual cannot be smaller than the cosine of the angle between the probe and that
 *    eigenvector (in the metric of the preconditioner). An instability therefore escapes only if
 *    its overlap with the probe is below `certificateTolerance`, which for a random direction in
 *    d dimensions has a probability of about 0.8 * certificateTolerance * sqrt(d);
 *  - a mode with an eigenvalue close to zero (it appears when the solution breaks a continuous
 *    symmetry, e.g. occupies one of two degenerate pi orbitals of a linear molecule) would stall
 *    the conjugate gradients. Once such a mode has converged it is set aside and the certificate
 *    is sought again, with a fresh probe, in the space orthogonal to it. The coupling this
 *    neglects is at most the residual of the mode, 1e-6 hartree.
 *
 * If neither outcome is reached within `maxProducts` products the result has `converged: false`.
 */
export function lowestEigenpair(operator: SymmetricOperator, options: StabilityOptions = {}): StabilityResult {
  const dimension = operator.dimension;
  if (dimension === 0) return { lowestEigenvalue: Infinity, vector: new Float64Array(0), converged: true, cancelled: false, products: 0, method: 'exact', softModes: 0 };
  return dimension <= (options.exactLimit ?? EXACT_STABILITY_LIMIT) ? exactLowestEigenpair(operator, options) : iterativeLowestEigenpair(operator, options);
}

function exactLowestEigenpair(operator: SymmetricOperator, options: StabilityOptions): StabilityResult {
  const dimension = operator.dimension;
  const matrix = new Float64Array(dimension * dimension);
  const unit = new Float64Array(dimension);
  const column = new Float64Array(dimension);
  for (let k = 0; k < dimension; k++) {
    if (options.isCancelled?.()) return { lowestEigenvalue: Infinity, vector: unit, converged: false, cancelled: true, products: k, method: 'exact', softModes: 0 };
    unit[k] = 1;
    operator.apply(unit, column);
    unit[k] = 0;
    for (let row = 0; row < dimension; row++) matrix[row * dimension + k] = column[row];
  }
  for (let i = 0; i < dimension; i++) {
    for (let j = 0; j < i; j++) {
      const mean = 0.5 * (matrix[i * dimension + j] + matrix[j * dimension + i]);
      matrix[i * dimension + j] = mean;
      matrix[j * dimension + i] = mean;
    }
  }
  const eigen = symmetricEigen(matrix, dimension);
  const vector = new Float64Array(dimension);
  for (let k = 0; k < dimension; k++) vector[k] = eigen.vectors[k * dimension];
  return { lowestEigenvalue: eigen.values[0], vector, converged: true, cancelled: false, products: dimension, method: 'exact', softModes: 0 };
}

function iterativeLowestEigenpair(operator: SymmetricOperator, options: StabilityOptions): StabilityResult {
  const dimension = operator.dimension;
  const threshold = options.instabilityThreshold ?? 1e-5;
  const tolerance = options.tolerance ?? 1e-4;
  const certificate = options.certificateTolerance ?? 1e-5;
  const maxProducts = options.maxProducts ?? 60;

  const preconditioner = new Float64Array(dimension);
  for (let q = 0; q < dimension; q++) preconditioner[q] = Math.max(operator.diagonal[q], PRECONDITIONER_FLOOR);

  /** Converged soft modes; the search continues in the space orthogonal to them. */
  const locked: Float64Array[] = [];
  let lowestLocked = Infinity;
  let lowestLockedVector = new Float64Array(dimension);
  let products = 0;
  let randomState = 0x2545f491;

  const finish = (value: number, vector: Float64Array, converged: boolean, cancelled = false): StabilityResult => {
    const fromLocked = lowestLocked < value;
    return { lowestEigenvalue: fromLocked ? lowestLocked : value, vector: fromLocked ? lowestLockedVector : vector, converged, cancelled, products, method: 'iterative', softModes: locked.length };
  };

  for (;;) {
    if (locked.length === dimension) return finish(Infinity, lowestLockedVector, true);

    // Probe b = M^(1/2) g with pseudo-random g, so that it is isotropic in the metric of the
    // preconditioner M; restricted to the space orthogonal to the locked modes.
    const probe = new Float64Array(dimension);
    for (let q = 0; q < dimension; q++) {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
      probe[q] = Math.sqrt(preconditioner[q]) * (randomState / 4294967296 - 0.5);
    }
    projectOut(probe, locked);
    let probeNorm = 0;
    for (let q = 0; q < dimension; q++) probeNorm += (probe[q] * probe[q]) / preconditioner[q];

    /** Locked modes followed by the search directions: everything a new direction is orthogonalised against. */
    const space: Float64Array[] = [...locked];
    const basis: Float64Array[] = [];
    const images: Float64Array[] = [];
    const probeOverlaps: number[] = [];
    const projectedRows: number[][] = [];
    let unstable = false;
    let ritzValue = Infinity;
    let ritz = new Float64Array(dimension);
    let next = new Float64Array(dimension);
    for (let q = 0; q < dimension; q++) next[q] = probe[q] / preconditioner[q];

    for (;;) {
      // ---- extend the search space by `next` ---------------------------------------------------
      const length = Math.sqrt(dotProduct(next, next));
      if (!(length > 0)) return finish(ritzValue, ritz, false);
      for (let q = 0; q < dimension; q++) next[q] /= length;
      if (orthonormalise(next, space) < 1e-8) return finish(ritzValue, ritz, false);
      const image = new Float64Array(dimension);
      operator.apply(next, image);
      products++;
      space.push(next);
      basis.push(next);
      images.push(image);
      probeOverlaps.push(dotProduct(next, probe));
      const size = basis.length;
      projectedRows.push(basis.map((b) => dotProduct(b, image)));

      // ---- Ritz values of H in the search space -------------------------------------------------
      const projected = new Float64Array(size * size);
      for (let i = 0; i < size; i++) {
        for (let j = 0; j <= i; j++) {
          projected[i * size + j] = projectedRows[i][j];
          projected[j * size + i] = projectedRows[i][j];
        }
      }
      const eigen = symmetricEigen(projected, size);
      ritzValue = eigen.values[0];
      ritz = new Float64Array(dimension);
      const residual = new Float64Array(dimension);
      for (let k = 0; k < size; k++) {
        const s = eigen.vectors[k * size];
        const b = basis[k];
        const w = images[k];
        for (let q = 0; q < dimension; q++) {
          ritz[q] += s * b[q];
          residual[q] += s * w[q];
        }
      }
      for (let q = 0; q < dimension; q++) residual[q] -= ritzValue * ritz[q];
      const residualNorm = Math.sqrt(dotProduct(residual, residual));
      const exhausted = size + locked.length === dimension;

      if (ritzValue < -threshold) unstable = true;
      if (unstable) {
        // An instability is proven; converge its eigenpair with Davidson corrections.
        if (residualNorm <= tolerance || exhausted) return finish(ritzValue, ritz, true);
        if (products >= maxProducts) return finish(ritzValue, ritz, false);
        if (options.isCancelled?.()) return finish(ritzValue, ritz, false, true);
        next = new Float64Array(dimension);
        for (let q = 0; q < dimension; q++) {
          let denominator = operator.diagonal[q] - ritzValue;
          if (Math.abs(denominator) < 1e-3) denominator = denominator < 0 ? -1e-3 : 1e-3;
          next[q] = residual[q] / denominator;
        }
        projectOut(next, locked);
        continue;
      }

      // ---- conjugate-gradient certificate: residual of (H + threshold) y = probe ----------------
      const solution = new Float64Array(size);
      for (let i = 0; i < size; i++) {
        let overlap = 0;
        for (let k = 0; k < size; k++) overlap += eigen.vectors[k * size + i] * probeOverlaps[k];
        const weight = overlap / (eigen.values[i] + threshold);
        for (let k = 0; k < size; k++) solution[k] += weight * eigen.vectors[k * size + i];
      }
      const probeResidual = Float64Array.from(probe);
      for (let k = 0; k < size; k++) {
        const c = solution[k];
        const b = basis[k];
        const w = images[k];
        for (let q = 0; q < dimension; q++) probeResidual[q] -= c * (w[q] + threshold * b[q]);
      }
      projectOut(probeResidual, locked);
      let probeResidualNorm = 0;
      for (let q = 0; q < dimension; q++) probeResidualNorm += (probeResidual[q] * probeResidual[q]) / preconditioner[q];
      if (probeResidualNorm <= certificate * certificate * probeNorm || exhausted) return finish(ritzValue, ritz, true);

      if (ritzValue <= SOFT_MODE_LIMIT && residualNorm <= SOFT_MODE_TOLERANCE) {
        // A converged soft mode: set it aside and look for the certificate in the rest of the space.
        locked.push(ritz);
        if (ritzValue < lowestLocked) {
          lowestLocked = ritzValue;
          lowestLockedVector = ritz;
        }
        if (products >= maxProducts) return finish(Infinity, ritz, false);
        if (options.isCancelled?.()) return finish(Infinity, ritz, false, true);
        break;
      }
      if (products >= maxProducts) return finish(ritzValue, ritz, false);
      if (options.isCancelled?.()) return finish(ritzValue, ritz, false, true);
      next = new Float64Array(dimension);
      for (let q = 0; q < dimension; q++) next[q] = probeResidual[q] / preconditioner[q];
      projectOut(next, locked);
    }
  }
}

/** Lowest eigenpair of the orbital-rotation Hessian of a closed-shell solution, see `lowestEigenpair`. */
export function lowestRotationEigenpair(problem: StabilityProblem, options: StabilityOptions = {}): StabilityResult {
  const hessian = new RotationHessian(problem);
  return lowestEigenpair({ dimension: hessian.dimension, diagonal: hessian.gaps, apply: (v, out) => hessian.apply(v, out) }, options);
}
