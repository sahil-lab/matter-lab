/**
 * Small dense linear algebra on row-major `Float64Array` matrices: element (i, j) of an n x n
 * matrix lives at index i * n + j. Everything here is O(n^3) or cheaper and written for the
 * matrix sizes of a minimal-basis calculation (n <= about 100).
 */

/** out = a b for n x n matrices. `out` must not alias `a` or `b`. */
export function multiply(a: Float64Array, b: Float64Array, n: number, out: Float64Array): Float64Array {
  out.fill(0);
  for (let i = 0; i < n; i++) {
    const io = i * n;
    for (let k = 0; k < n; k++) {
      const aik = a[io + k];
      if (aik === 0) continue;
      const ko = k * n;
      for (let j = 0; j < n; j++) out[io + j] += aik * b[ko + j];
    }
  }
  return out;
}

/** out = a^T b for n x n matrices. `out` must not alias `a` or `b`. */
export function multiplyTransposeLeft(a: Float64Array, b: Float64Array, n: number, out: Float64Array): Float64Array {
  out.fill(0);
  for (let k = 0; k < n; k++) {
    const ko = k * n;
    for (let i = 0; i < n; i++) {
      const aki = a[ko + i];
      if (aki === 0) continue;
      const io = i * n;
      for (let j = 0; j < n; j++) out[io + j] += aki * b[ko + j];
    }
  }
  return out;
}

/** sum_ij a_ij b_ij, which equals trace(a b) when either matrix is symmetric. */
export function dot(a: Float64Array, b: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

export interface SymmetricEigen {
  /** Eigenvalues in ascending order. */
  readonly values: Float64Array;
  /** Orthonormal eigenvectors as columns: element [r * n + i] is component r of eigenvector i. */
  readonly vectors: Float64Array;
  /** Number of Jacobi sweeps that were needed. */
  readonly sweeps: number;
}

const EPSILON = 2.220446049250313e-16;
const MAX_SWEEPS = 100;

/**
 * Eigenvalues and eigenvectors of a real symmetric matrix by the cyclic Jacobi method
 * (C. G. J. Jacobi, J. reine angew. Math. 30, 51 (1846); see also Golub & Van Loan, "Matrix
 * Computations").
 *
 * Each plane rotation annihilates one off-diagonal element; sweeps over all pairs are repeated
 * until every off-diagonal element is negligible next to the diagonal elements it couples,
 * |a_pq| <= eps * sqrt(|a_pp a_qq|), which gives eigenvalues with small relative error and
 * eigenvectors orthonormal to machine precision even for degenerate eigenvalues. Only the
 * symmetric part of the input is used.
 */
export function symmetricEigen(matrix: Float64Array, n: number): SymmetricEigen {
  if (matrix.length !== n * n) throw new RangeError('symmetricEigen: matrix size does not match n.');
  const a = new Float64Array(n * n);
  let scale = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      const value = 0.5 * (matrix[i * n + j] + matrix[j * n + i]);
      if (!Number.isFinite(value)) throw new RangeError('symmetricEigen: matrix contains a non-finite element.');
      a[i * n + j] = value;
      a[j * n + i] = value;
      const magnitude = Math.abs(value);
      if (magnitude > scale) scale = magnitude;
    }
  }
  const v = new Float64Array(n * n);
  for (let i = 0; i < n; i++) v[i * n + i] = 1;

  // Elements this far below the largest matrix element cannot affect any result in double precision.
  const floor = scale * 1e-22;
  let sweeps = 0;
  for (; sweeps < MAX_SWEEPS; sweeps++) {
    let rotations = 0;
    for (let p = 0; p < n - 1; p++) {
      const po = p * n;
      for (let q = p + 1; q < n; q++) {
        const qo = q * n;
        const apq = a[po + q];
        if (apq === 0) continue;
        const app = a[po + p];
        const aqq = a[qo + q];
        const magnitude = Math.abs(apq);
        if (magnitude <= floor || magnitude <= EPSILON * Math.sqrt(Math.abs(app * aqq))) {
          a[po + q] = 0;
          a[qo + p] = 0;
          continue;
        }
        const theta = (aqq - app) / (2 * apq);
        const absTheta = Math.abs(theta);
        // tan of the rotation angle: the root of t^2 + 2 theta t - 1 = 0 of smaller magnitude.
        const t = absTheta > 1e150 ? 0.5 / theta : (theta >= 0 ? 1 : -1) / (absTheta + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let r = 0; r < n; r++) {
          if (r === p || r === q) continue;
          const ro = r * n;
          const arp = a[ro + p];
          const arq = a[ro + q];
          const newP = c * arp - s * arq;
          const newQ = s * arp + c * arq;
          a[ro + p] = newP;
          a[po + r] = newP;
          a[ro + q] = newQ;
          a[qo + r] = newQ;
        }
        a[po + p] = app - t * apq;
        a[qo + q] = aqq + t * apq;
        a[po + q] = 0;
        a[qo + p] = 0;
        for (let r = 0; r < n; r++) {
          const ro = r * n;
          const vrp = v[ro + p];
          const vrq = v[ro + q];
          v[ro + p] = c * vrp - s * vrq;
          v[ro + q] = s * vrp + c * vrq;
        }
        rotations++;
      }
    }
    if (rotations === 0) break;
  }
  if (sweeps === MAX_SWEEPS) throw new Error('symmetricEigen: the Jacobi iteration did not converge.');

  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => a[i * n + i] - a[j * n + j] || i - j);
  const values = new Float64Array(n);
  const vectors = new Float64Array(n * n);
  for (let k = 0; k < n; k++) {
    const source = order[k];
    values[k] = a[source * n + source];
    for (let r = 0; r < n; r++) vectors[r * n + k] = v[r * n + source];
  }
  return { values, vectors, sweeps };
}

/**
 * Solves the n x n system a x = b by Gaussian elimination with partial pivoting. Returns null when
 * the matrix is singular to working precision. `a` and `b` are left untouched.
 */
export function solveLinearSystem(a: Float64Array, b: Float64Array, n: number): Float64Array | null {
  const m = Float64Array.from(a);
  const x = Float64Array.from(b);
  let largest = 0;
  for (let i = 0; i < m.length; i++) largest = Math.max(largest, Math.abs(m[i]));
  if (!(largest > 0) || !Number.isFinite(largest)) return null;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    let best = Math.abs(m[col * n + col]);
    for (let row = col + 1; row < n; row++) {
      const candidate = Math.abs(m[row * n + col]);
      if (candidate > best) {
        best = candidate;
        pivot = row;
      }
    }
    if (!(best > largest * 1e-14)) return null;
    if (pivot !== col) {
      for (let j = 0; j < n; j++) {
        const tmp = m[col * n + j];
        m[col * n + j] = m[pivot * n + j];
        m[pivot * n + j] = tmp;
      }
      const tmp = x[col];
      x[col] = x[pivot];
      x[pivot] = tmp;
    }
    const inv = 1 / m[col * n + col];
    for (let row = col + 1; row < n; row++) {
      const factor = m[row * n + col] * inv;
      if (factor === 0) continue;
      for (let j = col; j < n; j++) m[row * n + j] -= factor * m[col * n + j];
      x[row] -= factor * x[col];
    }
  }
  for (let row = n - 1; row >= 0; row--) {
    let sum = x[row];
    for (let j = row + 1; j < n; j++) sum -= m[row * n + j] * x[j];
    x[row] = sum / m[row * n + row];
  }
  for (let i = 0; i < n; i++) if (!Number.isFinite(x[i])) return null;
  return x;
}
