/**
 * Hermite Gaussians and their Coulomb integrals, the building blocks of the McMurchie-Davidson
 * scheme (L. E. McMurchie and E. R. Davidson, J. Comput. Phys. 26, 218 (1978); notation follows
 * Helgaker, Jorgensen and Olsen, "Molecular Electronic-Structure Theory", chapter 9).
 *
 * A product of two Cartesian Gaussians is expanded in Hermite Gaussians
 * Lambda_tuv = (d/dPx)^t (d/dPy)^u (d/dPz)^v exp(-p |r - P|^2). For s and p functions the product
 * needs t + u + v <= 2 (10 functions) and a Coulomb integral between two such products needs the
 * Hermite Coulomb integrals R_tuv up to t + u + v <= 4 (35 values).
 */

/** Highest total Hermite order a pair of s/p functions can produce. */
export const MAX_PAIR_ORDER = 2;
/** Highest total Hermite order of a Coulomb integral between two such pairs. */
export const MAX_COULOMB_ORDER = 4;

/** HERMITE_COUNT[L] = number of (t, u, v) with t + u + v <= L. */
export const HERMITE_COUNT: readonly number[] = [1, 4, 10, 20, 35];

const TOTAL = HERMITE_COUNT[MAX_COULOMB_ORDER];

/**
 * (t, u, v) of every Hermite index, ordered by total order, then t descending, then u descending:
 * 000 | 100 010 001 | 200 110 101 020 011 002 | 300 210 201 120 111 102 030 021 012 003 | ...
 */
export const HERMITE_T = new Int8Array(TOTAL);
export const HERMITE_U = new Int8Array(TOTAL);
export const HERMITE_V = new Int8Array(TOTAL);

{
  let index = 0;
  for (let order = 0; order <= MAX_COULOMB_ORDER; order++) {
    for (let t = order; t >= 0; t--) {
      for (let u = order - t; u >= 0; u--) {
        HERMITE_T[index] = t;
        HERMITE_U[index] = u;
        HERMITE_V[index] = order - t - u;
        index++;
      }
    }
  }
}

/** Position of (t, u, v) in the ordering above. */
export function hermiteIndex(t: number, u: number, v: number): number {
  for (let index = 0; index < TOTAL; index++) {
    if (HERMITE_T[index] === t && HERMITE_U[index] === u && HERMITE_V[index] === v) return index;
  }
  throw new RangeError(`Hermite index (${t}, ${u}, ${v}) is out of range.`);
}

/** Number of Hermite functions of a pair (t + u + v <= 2). */
export const PAIR_HERMITE = HERMITE_COUNT[MAX_PAIR_ORDER];

/** HERMITE_SUM[a * PAIR_HERMITE + b] = index of the sum of pair indices a and b (each < 10). */
export const HERMITE_SUM = new Int32Array(PAIR_HERMITE * PAIR_HERMITE);

/** +1 or -1: (-1)^(t+u+v) for each pair index. */
export const HERMITE_PARITY = new Float64Array(PAIR_HERMITE);

{
  for (let a = 0; a < PAIR_HERMITE; a++) {
    HERMITE_PARITY[a] = (HERMITE_T[a] + HERMITE_U[a] + HERMITE_V[a]) % 2 === 0 ? 1 : -1;
    for (let b = 0; b < PAIR_HERMITE; b++) {
      HERMITE_SUM[a * PAIR_HERMITE + b] = hermiteIndex(HERMITE_T[a] + HERMITE_T[b], HERMITE_U[a] + HERMITE_U[b], HERMITE_V[a] + HERMITE_V[b]);
    }
  }
}

/**
 * Hermite Coulomb integrals R_tuv for all t + u + v <= `order`, written to `r` in the ordering
 * above. Input: the vector (x, y, z) between the two centres and a[n] = c (-2 alpha)^n F_n(alpha
 * R^2) for n = 0..order, where F_n is the Boys function and c any common prefactor.
 *
 * The closed forms below are what the textbook recursion
 * R^n_(t+1,u,v) = t R^(n+1)_(t-1,u,v) + x R^(n+1)_(t,u,v) (and likewise for u, v) evaluates to:
 * R_tuv = sum_ijk h(t,i) h(u,j) h(v,k) x^(t-2i) y^(u-2j) z^(v-2k) a[t+u+v-i-j-k] with
 * h(2,.) = (1,1), h(3,.) = (1,3), h(4,.) = (1,6,3). The tests check them against the recursion.
 */
export function hermiteCoulomb(order: number, x: number, y: number, z: number, a: Float64Array, r: Float64Array): void {
  const a0 = a[0];
  r[0] = a0;
  if (order === 0) return;

  const a1 = a[1];
  r[1] = x * a1;
  r[2] = y * a1;
  r[3] = z * a1;
  if (order === 1) return;

  const a2 = a[2];
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  r[4] = xx * a2 + a1;
  r[5] = xy * a2;
  r[6] = xz * a2;
  r[7] = yy * a2 + a1;
  r[8] = yz * a2;
  r[9] = zz * a2 + a1;
  if (order === 2) return;

  const a3 = a[3];
  const xx3 = xx * a3 + a2;
  const yy3 = yy * a3 + a2;
  const zz3 = zz * a3 + a2;
  r[10] = x * (xx3 + 2 * a2);
  r[11] = y * xx3;
  r[12] = z * xx3;
  r[13] = x * yy3;
  r[14] = xy * z * a3;
  r[15] = x * zz3;
  r[16] = y * (yy3 + 2 * a2);
  r[17] = z * yy3;
  r[18] = y * zz3;
  r[19] = z * (zz3 + 2 * a2);
  if (order === 3) return;

  const a4 = a[4];
  const xx4 = xx * a4 + a3;
  const yy4 = yy * a4 + a3;
  const zz4 = zz * a4 + a3;
  const twoA3 = 2 * a3;
  r[20] = xx * (xx4 + 5 * a3) + 3 * a2;
  r[21] = xy * (xx4 + twoA3);
  r[22] = xz * (xx4 + twoA3);
  r[23] = xx * yy4 + yy * a3 + a2;
  r[24] = yz * xx4;
  r[25] = xx * zz4 + zz * a3 + a2;
  r[26] = xy * (yy4 + twoA3);
  r[27] = xz * yy4;
  r[28] = xy * zz4;
  r[29] = xz * (zz4 + twoA3);
  r[30] = yy * (yy4 + 5 * a3) + 3 * a2;
  r[31] = yz * (yy4 + twoA3);
  r[32] = yy * zz4 + zz * a3 + a2;
  r[33] = yz * (zz4 + twoA3);
  r[34] = zz * (zz4 + 5 * a3) + 3 * a2;
}
