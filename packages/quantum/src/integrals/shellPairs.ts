import type { Basis, Shell } from '../basis/basis';
import { KIND_S } from '../basis/basis';
import { HERMITE_PARITY, HERMITE_T, HERMITE_U, HERMITE_V, hermiteIndex } from './hermite';

/**
 * Everything the integral routines need to know about the products of the basis functions of two
 * shells, precomputed once per shell pair.
 *
 * For every pair of primitives (exponents a on centre A, b on centre B) the product of two basis
 * functions is a finite sum of Hermite Gaussians centred on P = (a A + b B) / p, p = a + b:
 *
 *     phi_mu(r) phi_nu(r) = sum_tuv E^{mu nu}_{tuv} Lambda_tuv(r; p, P)
 *
 * The coefficients E include the contraction coefficients, the normalisation constants and the
 * Gaussian product factor exp(-a b |A - B|^2 / p). Only a few (t, u, v) are non-zero for each
 * function pair and which ones is the same for all primitive pairs, so the coefficients are stored
 * as a sparse list: entry k belongs to function pair `nzFn[k]` and Hermite index `nzHerm[k]`.
 * Entries that vanish for every primitive pair (which happens for two shells on one centre) are
 * left out of the list altogether.
 */
export interface ShellPair {
  /** Shell indices, a >= b. */
  readonly a: number;
  readonly b: number;
  /** Index of the first basis function of each shell. */
  readonly firstA: number;
  readonly firstB: number;
  readonly nfa: number;
  readonly nfb: number;
  /** nfa * nfb; function pair (ia, ib) has index ia * nfb + ib. */
  readonly nf: number;
  /** Highest Hermite order that occurs: 0 (ss), 1 (one shell has p functions) or 2. */
  readonly order: number;
  /** Number of Hermite indices with t + u + v <= order: 1, 4 or 10. */
  readonly nHerm: number;
  /** Number of primitive pairs kept after dropping those with a negligible product factor. */
  readonly nPrim: number;
  /** Per primitive pair: total exponent p and product centre P (bohr). */
  readonly p: Float64Array;
  readonly px: Float64Array;
  readonly py: Float64Array;
  readonly pz: Float64Array;
  /** Length of the sparse coefficient list. */
  readonly nnz: number;
  readonly nzFn: Int32Array;
  readonly nzHerm: Int32Array;
  /** Hermite expansion coefficients, nPrim x nnz. */
  readonly e: Float64Array;
  /** The same multiplied by (-1)^(t+u+v), as needed on the ket side of a two-electron integral. */
  readonly eKet: Float64Array;
  /**
   * Per primitive pair: max over function pairs of sum_tuv |E_tuv| (2p)^((t+u+v)/2), an upper bound
   * (up to a factor of order one) on what the pair can contribute to a Coulomb integral.
   */
  readonly bound: Float64Array;
  /** sqrt(max (mu nu|mu nu)) over the pair; filled in by the two-electron integral driver. */
  schwarz: number;
}

/** Primitive pairs whose overlap-like magnitude bound * (pi/p)^(3/2) is below this are dropped. */
export const PRIMITIVE_PAIR_THRESHOLD = 1e-16;

interface Pattern {
  readonly nzFn: Int32Array;
  readonly nzHerm: Int32Array;
  /** Which of the formulas E_C .. E_PAPLUSPB_H below gives each entry. */
  readonly kind: Int8Array;
  /** Cartesian axes of the p functions involved in each entry (0 when not applicable). */
  readonly axisA: Int8Array;
  readonly axisB: Int8Array;
  /** First entry of each function pair in the list (length nf + 1). */
  readonly start: Int32Array;
  readonly order: number;
}

// Coefficient formulas, by kind (h = 1/(2p), PA = P - A, PB = P - B, c = prefactor):
const E_C = 0; //         c                        (s s | 000)
const E_PA = 1; //        c PA_i                   (p_i s | 000)
const E_PB = 2; //        c PB_j                   (s p_j | 000)
const E_H = 3; //         c h                      (p s | e_i), (s p | e_j)
const E_PAPB = 4; //      c PA_i PB_j              (p_i p_j | 000), i != j
const E_PB_H = 5; //      c PB_j h                 (p_i p_j | e_i), i != j
const E_PA_H = 6; //      c PA_i h                 (p_i p_j | e_j), i != j
const E_HH = 7; //        c h^2                    (p_i p_j | e_i + e_j), including i = j
const E_PAPB_H = 8; //    c (PA_i PB_i + h)        (p_i p_i | 000)
const E_PAPLUSPB_H = 9; // c (PA_i + PB_i) h       (p_i p_i | e_i)

const UNIT_INDEX = [hermiteIndex(1, 0, 0), hermiteIndex(0, 1, 0), hermiteIndex(0, 0, 1)];

function pairIndex(i: number, j: number): number {
  const t = (i === 0 ? 1 : 0) + (j === 0 ? 1 : 0);
  const u = (i === 1 ? 1 : 0) + (j === 1 ? 1 : 0);
  const v = (i === 2 ? 1 : 0) + (j === 2 ? 1 : 0);
  return hermiteIndex(t, u, v);
}

/**
 * Which Hermite coefficients are non-zero for every pair of functions of two shells, and which
 * formula gives each of them. Follows from the recurrences
 * E^{i+1,j}_t = h E^{ij}_{t-1} + PA E^{ij}_t + (t+1) E^{ij}_{t+1} (and the analogue for j) with
 * E^{00}_0 = 1, applied along each Cartesian direction for i, j <= 1.
 */
function buildPattern(kindsA: Int8Array, kindsB: Int8Array): Pattern {
  const nzFn: number[] = [];
  const nzHerm: number[] = [];
  const kind: number[] = [];
  const axisA: number[] = [];
  const axisB: number[] = [];
  const start: number[] = [];
  let order = 0;
  const push = (fn: number, herm: number, k: number, i: number, j: number): void => {
    nzFn.push(fn);
    nzHerm.push(herm);
    kind.push(k);
    axisA.push(i);
    axisB.push(j);
  };
  for (let ia = 0; ia < kindsA.length; ia++) {
    for (let ib = 0; ib < kindsB.length; ib++) {
      const fn = ia * kindsB.length + ib;
      const i = kindsA[ia];
      const j = kindsB[ib];
      start.push(nzFn.length);
      if (i === KIND_S && j === KIND_S) {
        push(fn, 0, E_C, 0, 0);
      } else if (j === KIND_S) {
        push(fn, 0, E_PA, i, 0);
        push(fn, UNIT_INDEX[i], E_H, i, 0);
        order = Math.max(order, 1);
      } else if (i === KIND_S) {
        push(fn, 0, E_PB, 0, j);
        push(fn, UNIT_INDEX[j], E_H, 0, j);
        order = Math.max(order, 1);
      } else if (i !== j) {
        push(fn, 0, E_PAPB, i, j);
        push(fn, UNIT_INDEX[i], E_PB_H, i, j);
        push(fn, UNIT_INDEX[j], E_PA_H, i, j);
        push(fn, pairIndex(i, j), E_HH, i, j);
        order = 2;
      } else {
        push(fn, 0, E_PAPB_H, i, i);
        push(fn, UNIT_INDEX[i], E_PAPLUSPB_H, i, i);
        push(fn, pairIndex(i, i), E_HH, i, i);
        order = 2;
      }
    }
  }
  start.push(nzFn.length);
  return {
    nzFn: Int32Array.from(nzFn),
    nzHerm: Int32Array.from(nzHerm),
    kind: Int8Array.from(kind),
    axisA: Int8Array.from(axisA),
    axisB: Int8Array.from(axisB),
    start: Int32Array.from(start),
    order,
  };
}

function buildShellPair(shells: readonly Shell[], a: number, b: number, dropThreshold: number, patterns: Map<string, Pattern>): ShellPair {
  const sa = shells[a];
  const sb = shells[b];
  const patternKey = `${sa.kinds.join(',')}|${sb.kinds.join(',')}`;
  let pattern = patterns.get(patternKey);
  if (!pattern) {
    pattern = buildPattern(sa.kinds, sb.kinds);
    patterns.set(patternKey, pattern);
  }
  const nnz = pattern.nzFn.length;
  const nf = sa.nFunctions * sb.nFunctions;
  const maxPrim = sa.nPrim * sb.nPrim;

  const abx = sa.x - sb.x;
  const aby = sa.y - sb.y;
  const abz = sa.z - sb.z;
  const r2 = abx * abx + aby * aby + abz * abz;

  const p = new Float64Array(maxPrim);
  const px = new Float64Array(maxPrim);
  const py = new Float64Array(maxPrim);
  const pz = new Float64Array(maxPrim);
  const e = new Float64Array(maxPrim * nnz);
  const bound = new Float64Array(maxPrim);
  const pa = [0, 0, 0];
  const pb = [0, 0, 0];
  let nPrim = 0;

  for (let i = 0; i < sa.nPrim; i++) {
    const ea = sa.exps[i];
    for (let j = 0; j < sb.nPrim; j++) {
      const eb = sb.exps[j];
      const pp = ea + eb;
      const h = 0.5 / pp;
      const k = Math.exp((-ea * eb * r2) / pp);
      // P - A = -(b/p)(A - B) and P - B = (a/p)(A - B); exact zeros when the centres coincide.
      const fa = -eb / pp;
      const fb = ea / pp;
      pa[0] = fa * abx;
      pa[1] = fa * aby;
      pa[2] = fa * abz;
      pb[0] = fb * abx;
      pb[1] = fb * aby;
      pb[2] = fb * abz;

      const offset = nPrim * nnz;
      const twoP = 2 * pp;
      const sqrtTwoP = Math.sqrt(twoP);
      let pairBound = 0;
      for (let fn = 0; fn < nf; fn++) {
        let fnBound = 0;
        for (let n = pattern.start[fn]; n < pattern.start[fn + 1]; n++) {
          const ia = pattern.axisA[n];
          const ib = pattern.axisB[n];
          const ka = sa.kinds[(fn / sb.nFunctions) | 0];
          const kb = sb.kinds[fn % sb.nFunctions];
          const c = (ka === KIND_S ? sa.coefS[i] : sa.coefP[i]) * (kb === KIND_S ? sb.coefS[j] : sb.coefP[j]) * k;
          let value: number;
          switch (pattern.kind[n]) {
            case E_C:
              value = c;
              break;
            case E_PA:
              value = c * pa[ia];
              break;
            case E_PB:
              value = c * pb[ib];
              break;
            case E_H:
              value = c * h;
              break;
            case E_PAPB:
              value = c * pa[ia] * pb[ib];
              break;
            case E_PB_H:
              value = c * pb[ib] * h;
              break;
            case E_PA_H:
              value = c * pa[ia] * h;
              break;
            case E_HH:
              value = c * h * h;
              break;
            case E_PAPB_H:
              value = c * (pa[ia] * pb[ia] + h);
              break;
            case E_PAPLUSPB_H:
              value = c * (pa[ia] + pb[ia]) * h;
              break;
            default:
              throw new Error('Unknown Hermite coefficient kind.');
          }
          e[offset + n] = value;
          const herm = pattern.nzHerm[n];
          const degree = HERMITE_T[herm] + HERMITE_U[herm] + HERMITE_V[herm];
          fnBound += Math.abs(value) * (degree === 0 ? 1 : degree === 1 ? sqrtTwoP : twoP);
        }
        if (fnBound > pairBound) pairBound = fnBound;
      }
      if (pairBound * Math.pow(Math.PI / pp, 1.5) < dropThreshold) continue;
      p[nPrim] = pp;
      px[nPrim] = sa.x + pa[0];
      py[nPrim] = sa.y + pa[1];
      pz[nPrim] = sa.z + pa[2];
      bound[nPrim] = pairBound;
      nPrim++;
    }
  }

  const eKept = e.slice(0, nPrim * nnz);

  // Coefficients that vanish for every primitive pair (on a shared centre P - A = P - B = 0 removes
  // more than half of them) are dropped from the sparse list, which shortens every contraction loop.
  const keep: number[] = [];
  for (let k = 0; k < nnz; k++) {
    let nonZero = false;
    for (let i = 0; i < nPrim && !nonZero; i++) nonZero = eKept[i * nnz + k] !== 0;
    if (nonZero) keep.push(k);
  }
  const kept = keep.length;
  const nzFn = Int32Array.from(keep, (k) => pattern.nzFn[k]);
  const nzHerm = Int32Array.from(keep, (k) => pattern.nzHerm[k]);
  const eFinal = new Float64Array(nPrim * kept);
  const eKet = new Float64Array(nPrim * kept);
  for (let i = 0; i < nPrim; i++) {
    for (let k = 0; k < kept; k++) {
      const value = eKept[i * nnz + keep[k]];
      eFinal[i * kept + k] = value;
      eKet[i * kept + k] = value * HERMITE_PARITY[nzHerm[k]];
    }
  }

  return {
    a,
    b,
    firstA: sa.firstFunction,
    firstB: sb.firstFunction,
    nfa: sa.nFunctions,
    nfb: sb.nFunctions,
    nf,
    order: pattern.order,
    nHerm: pattern.order === 0 ? 1 : pattern.order === 1 ? 4 : 10,
    nPrim,
    p: p.slice(0, nPrim),
    px: px.slice(0, nPrim),
    py: py.slice(0, nPrim),
    pz: pz.slice(0, nPrim),
    nnz: kept,
    nzFn,
    nzHerm,
    e: eFinal,
    eKet,
    bound: bound.slice(0, nPrim),
    schwarz: Number.POSITIVE_INFINITY,
  };
}

/**
 * Shell pairs (a, b) for all a >= b, stored at index a (a + 1) / 2 + b. A pair of a shell with
 * itself keeps all nPrim^2 primitive products and all nf^2 function pairs.
 */
export function buildShellPairs(basis: Basis, dropThreshold: number = PRIMITIVE_PAIR_THRESHOLD): ShellPair[] {
  const pairs: ShellPair[] = [];
  const patterns = new Map<string, Pattern>();
  for (let a = 0; a < basis.shells.length; a++) {
    for (let b = 0; b <= a; b++) pairs.push(buildShellPair(basis.shells, a, b, dropThreshold, patterns));
  }
  return pairs;
}
