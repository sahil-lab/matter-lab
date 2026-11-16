import { solveLinearSystem } from '../math/linalg';

/**
 * Pulay's direct inversion in the iterative subspace (P. Pulay, Chem. Phys. Lett. 73, 393 (1980);
 * J. Comput. Chem. 3, 556 (1982)).
 *
 * Each SCF iteration contributes a Fock matrix F_i and an error matrix e_i (the orthogonalised
 * commutator FPS - SPF, which vanishes at convergence). The next Fock matrix is the combination
 * sum_i c_i F_i whose error sum_i c_i e_i has the smallest norm subject to sum_i c_i = 1.
 */
export class Diis {
  private readonly maxVectors: number;
  private readonly focks: Float64Array[] = [];
  private readonly errors: Float64Array[] = [];

  constructor(maxVectors = 8) {
    this.maxVectors = maxVectors;
  }

  get size(): number {
    return this.focks.length;
  }

  /** Stores copies of the Fock and error matrices, discarding the oldest pair when full. */
  push(fock: Float64Array, error: Float64Array): void {
    if (this.focks.length === this.maxVectors) {
      this.focks.shift();
      this.errors.shift();
    }
    this.focks.push(Float64Array.from(fock));
    this.errors.push(Float64Array.from(error));
  }

  /**
   * Writes the extrapolated Fock matrix to `out` and returns true. Returns false (leaving `out`
   * untouched) when fewer than two vectors are stored or the DIIS equations cannot be solved even
   * after discarding old vectors; the caller then uses the plain Fock matrix.
   */
  extrapolate(out: Float64Array): boolean {
    while (this.focks.length >= 2) {
      const m = this.focks.length;
      const size = m + 1;
      const b = new Float64Array(size * size);
      let scale = 0;
      for (let i = 0; i < m; i++) {
        for (let j = 0; j <= i; j++) {
          let sum = 0;
          const ei = this.errors[i];
          const ej = this.errors[j];
          for (let k = 0; k < ei.length; k++) sum += ei[k] * ej[k];
          b[i * size + j] = sum;
          b[j * size + i] = sum;
        }
        scale = Math.max(scale, b[i * size + i]);
      }
      if (scale > 0) {
        // Scaling the error block leaves the coefficients unchanged (only the multiplier scales)
        // and keeps the system well conditioned when the errors become tiny near convergence.
        for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) b[i * size + j] /= scale;
        for (let i = 0; i < m; i++) {
          b[i * size + m] = -1;
          b[m * size + i] = -1;
        }
        const rhs = new Float64Array(size);
        rhs[m] = -1;
        const solution = solveLinearSystem(b, rhs, size);
        if (solution) {
          out.fill(0);
          for (let i = 0; i < m; i++) {
            const c = solution[i];
            const f = this.focks[i];
            for (let k = 0; k < out.length; k++) out[k] += c * f[k];
          }
          return true;
        }
      }
      // Singular (linearly dependent error vectors) or all errors exactly zero: drop the oldest.
      this.focks.shift();
      this.errors.shift();
    }
    return false;
  }
}
