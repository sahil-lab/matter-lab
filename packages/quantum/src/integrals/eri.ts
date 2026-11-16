import type { Basis } from '../basis/basis';
import { UnsupportedSystemError } from '../errors';
import { boys, boys0 } from '../math/boys';
import { HERMITE_SUM, PAIR_HERMITE, hermiteCoulomb } from './hermite';
import type { ShellPair } from './shellPairs';

/**
 * Two-electron repulsion integrals (mu nu|lambda sigma) in chemists' notation over contracted
 * Cartesian s/p Gaussians, by the McMurchie-Davidson scheme:
 *
 *   (ab|cd) = 2 pi^(5/2) / (p q sqrt(p + q))
 *             sum_tuv E^{ab}_{tuv} sum_{t'u'v'} (-1)^(t'+u'+v') E^{cd}_{t'u'v'} R_{t+t',u+u',v+v'}(alpha, P - Q)
 *
 * with alpha = p q / (p + q). For each pair of primitive products the Hermite Coulomb integrals R
 * are evaluated once and shared by all function pairs of the two shell pairs (up to 16 x 16
 * integrals for two SP-SP pairs); the ket side is contracted first, the bra side once per bra
 * primitive pair.
 */

const TWO_PI_52 = 2 * Math.pow(Math.PI, 2.5);

// Local aliases of the imported kernels. In a bundle or as native ES modules this changes nothing;
// module runners that resolve an imported binding through a property access on every use (Vitest's
// does) would otherwise pay for it millions of times in the loops below.
const boysUpTo = boys;
const boysZero = boys0;
const coulombIntegrals = hermiteCoulomb;
const PAIR = PAIR_HERMITE;

/** Shell quartets with Q_ab Q_cd below this are skipped (Schwarz inequality |(ab|cd)| <= Q_ab Q_cd). */
export const SCHWARZ_THRESHOLD = 1e-12;
/** Primitive quartets whose contribution is bounded by about this value are skipped. */
export const PRIMITIVE_QUARTET_THRESHOLD = 1e-15;

const MAX_PAIR_FUNCTIONS = 16;

// Scratch space. The kernel never yields to a callback while these are live.
const boysValues = new Float64Array(5);
const coulombFactors = new Float64Array(5);
const coulomb = new Float64Array(35);
const halfContracted = new Float64Array(PAIR_HERMITE * MAX_PAIR_FUNCTIONS);

/**
 * All integrals (ab|cd) between the function pairs of `bra` and `ket`:
 * block[fab * ket.nf + fcd]. Returns the number of primitive quartets that were evaluated.
 */
export function eriShellQuartet(bra: ShellPair, ket: ShellPair, block: Float64Array, primitiveThreshold: number): number {
  const nfKet = ket.nf;
  const nHerm = bra.nHerm;
  const order = bra.order + ket.order;
  const braE = bra.e;
  const braP = bra.p;
  const ketE = ket.eKet;
  const ketP = ket.p;
  const ketPx = ket.px;
  const ketPy = ket.py;
  const ketPz = ket.pz;
  const ketBound = ket.bound;
  const nKet = ket.nPrim;
  let evaluated = 0;

  if (bra.nnz === 0 || ket.nnz === 0) {
    // Every Hermite coefficient of one pair is exactly zero (its Gaussian product factor has underflowed).
    const size = bra.nf * nfKet;
    for (let i = 0; i < size; i++) block[i] = 0;
    return 0;
  }

  if (order === 0) {
    // (ss|ss): one Hermite function per pair, so the integral is a plain double sum over F_0.
    let sum = 0;
    for (let i = 0; i < bra.nPrim; i++) {
      const p = braP[i];
      const px = bra.px[i];
      const py = bra.py[i];
      const pz = bra.pz[i];
      const braBound = bra.bound[i];
      let inner = 0;
      for (let j = 0; j < nKet; j++) {
        const q = ketP[j];
        const pq = p + q;
        const prefactor = TWO_PI_52 / (p * q * Math.sqrt(pq));
        if (prefactor * braBound * ketBound[j] < primitiveThreshold) continue;
        const x = px - ketPx[j];
        const y = py - ketPy[j];
        const z = pz - ketPz[j];
        inner += ketE[j] * prefactor * boysZero(((p * q) / pq) * (x * x + y * y + z * z));
        evaluated++;
      }
      sum += braE[i] * inner;
    }
    block[0] = sum;
    return evaluated;
  }

  const size = bra.nf * nfKet;
  for (let i = 0; i < size; i++) block[i] = 0;

  const braNnz = bra.nnz;
  const braFn = bra.nzFn;
  const braHerm = bra.nzHerm;
  const ketNnz = ket.nnz;
  const ketFn = ket.nzFn;
  const ketHerm = ket.nzHerm;
  const gSize = nHerm * nfKet;
  const g = halfContracted;
  const r = coulomb;
  const a = coulombFactors;
  const f = boysValues;
  const sums = HERMITE_SUM;

  for (let i = 0; i < bra.nPrim; i++) {
    const p = braP[i];
    const px = bra.px[i];
    const py = bra.py[i];
    const pz = bra.pz[i];
    const braBound = bra.bound[i];
    for (let k = 0; k < gSize; k++) g[k] = 0;
    let any = false;

    for (let j = 0; j < nKet; j++) {
      const q = ketP[j];
      const pq = p + q;
      const prefactor = TWO_PI_52 / (p * q * Math.sqrt(pq));
      if (prefactor * braBound * ketBound[j] < primitiveThreshold) continue;
      const alpha = (p * q) / pq;
      const x = px - ketPx[j];
      const y = py - ketPy[j];
      const z = pz - ketPz[j];
      boysUpTo(order, alpha * (x * x + y * y + z * z), f);
      const minusTwoAlpha = -2 * alpha;
      let factor = prefactor;
      for (let n = 0; n <= order; n++) {
        a[n] = factor * f[n];
        factor *= minusTwoAlpha;
      }
      coulombIntegrals(order, x, y, z, a, r);

      const eo = j * ketNnz;
      if (nHerm === 1) {
        for (let n = 0; n < ketNnz; n++) g[ketFn[n]] += ketE[eo + n] * r[ketHerm[n]];
      } else {
        for (let n = 0; n < ketNnz; n++) {
          const e = ketE[eo + n];
          const fn = ketFn[n];
          const so = ketHerm[n] * PAIR;
          for (let tb = 0, go = fn; tb < nHerm; tb++, go += nfKet) g[go] += e * r[sums[so + tb]];
        }
      }
      any = true;
      evaluated++;
    }
    if (!any) continue;

    const eo = i * braNnz;
    for (let n = 0; n < braNnz; n++) {
      const e = braE[eo + n];
      if (e === 0) continue;
      const bo = braFn[n] * nfKet;
      const go = braHerm[n] * nfKet;
      for (let k = 0; k < nfKet; k++) block[bo + k] += e * g[go + k];
    }
  }
  return evaluated;
}

export interface EriOptions {
  readonly schwarzThreshold?: number;
  readonly primitiveThreshold?: number;
  /** Called after each batch (one bra shell pair against all its ket pairs) with the fraction done. */
  readonly onProgress?: (fraction: number) => void;
  /** Polled before each batch. */
  readonly isCancelled?: () => boolean;
}

export interface EriTable {
  /**
   * Unique integrals in a packed array. With the compound indices ij = i (i + 1) / 2 + j (i >= j)
   * and kl likewise, (ij|kl) with ij >= kl is stored at ij (ij + 1) / 2 + kl. All eight
   * permutations of the indices map onto the same entry. Integrals removed by screening are zero.
   */
  readonly values: Float64Array;
  /** Number of basis functions. */
  readonly n: number;
  readonly cancelled: boolean;
  readonly shellQuartets: number;
  readonly shellQuartetsScreened: number;
  readonly primitiveQuartets: number;
}

/** Position of (i j|k l) in the packed array, for any order of the indices. */
export function eriIndex(i: number, j: number, k: number, l: number): number {
  const ij = i >= j ? (i * (i + 1)) / 2 + j : (j * (j + 1)) / 2 + i;
  const kl = k >= l ? (k * (k + 1)) / 2 + l : (l * (l + 1)) / 2 + k;
  return ij >= kl ? (ij * (ij + 1)) / 2 + kl : (kl * (kl + 1)) / 2 + ij;
}

function storeBlock(bra: ShellPair, ket: ShellPair, block: Float64Array, values: Float64Array): void {
  const nfKet = ket.nf;
  for (let fa = 0; fa < bra.nfa; fa++) {
    const mu = bra.firstA + fa;
    for (let fb = 0; fb < bra.nfb; fb++) {
      const nu = bra.firstB + fb;
      if (nu > mu) continue;
      const ij = (mu * (mu + 1)) / 2 + nu;
      const ijOffset = (ij * (ij + 1)) / 2;
      const row = (fa * bra.nfb + fb) * nfKet;
      for (let fc = 0; fc < ket.nfa; fc++) {
        const lambda = ket.firstA + fc;
        for (let fd = 0; fd < ket.nfb; fd++) {
          const sigma = ket.firstB + fd;
          if (sigma > lambda) continue;
          const kl = (lambda * (lambda + 1)) / 2 + sigma;
          const value = block[row + fc * ket.nfb + fd];
          if (ij >= kl) values[ijOffset + kl] = value;
          else values[(kl * (kl + 1)) / 2 + ij] = value;
        }
      }
    }
  }
}

/** Fills in `schwarz` = sqrt(max (mu nu|mu nu)) for every shell pair. */
export function computeSchwarzBounds(pairs: readonly ShellPair[]): void {
  const block = new Float64Array(MAX_PAIR_FUNCTIONS * MAX_PAIR_FUNCTIONS);
  for (const pair of pairs) {
    eriShellQuartet(pair, pair, block, 0);
    let largest = 0;
    for (let fn = 0; fn < pair.nf; fn++) {
      const diagonal = block[fn * pair.nf + fn];
      if (diagonal > largest) largest = diagonal;
    }
    pair.schwarz = Math.sqrt(largest);
  }
}

/**
 * Computes all unique two-electron integrals, using the eight-fold permutational symmetry (each
 * unordered pair of shell pairs is visited once) and Schwarz screening.
 */
export function computeEri(basis: Basis, pairs: readonly ShellPair[], options: EriOptions = {}): EriTable {
  const schwarzThreshold = options.schwarzThreshold ?? SCHWARZ_THRESHOLD;
  const primitiveThreshold = options.primitiveThreshold ?? PRIMITIVE_QUARTET_THRESHOLD;
  const n = basis.nBasis;
  const nPairs = (n * (n + 1)) / 2;
  const entries = (nPairs * (nPairs + 1)) / 2;
  let values: Float64Array;
  try {
    values = new Float64Array(entries);
  } catch {
    throw new UnsupportedSystemError([
      `The table of two-electron integrals for ${n} basis functions needs ${Math.round((entries * 8) / 1e6)} MB, which could not be allocated in this environment.`,
    ]);
  }
  const block = new Float64Array(MAX_PAIR_FUNCTIONS * MAX_PAIR_FUNCTIONS);

  computeSchwarzBounds(pairs);

  const total = (pairs.length * (pairs.length + 1)) / 2;
  let shellQuartets = 0;
  let shellQuartetsScreened = 0;
  let primitiveQuartets = 0;
  for (let ij = 0; ij < pairs.length; ij++) {
    if (options.isCancelled?.()) {
      return { values, n, cancelled: true, shellQuartets, shellQuartetsScreened, primitiveQuartets };
    }
    const bra = pairs[ij];
    for (let kl = 0; kl <= ij; kl++) {
      const ket = pairs[kl];
      if (bra.schwarz * ket.schwarz < schwarzThreshold) {
        shellQuartetsScreened++;
        continue;
      }
      primitiveQuartets += eriShellQuartet(bra, ket, block, primitiveThreshold);
      storeBlock(bra, ket, block, values);
      shellQuartets++;
    }
    options.onProgress?.(((ij + 1) * (ij + 2)) / 2 / total);
  }
  return { values, n, cancelled: false, shellQuartets, shellQuartetsScreened, primitiveQuartets };
}
