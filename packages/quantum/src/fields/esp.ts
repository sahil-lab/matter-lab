import { ANGSTROM_TO_BOHR } from '@matterlab/core';
import { atomsToBohr } from '../basis/basis';
import { hermiteCoulomb, HERMITE_T, HERMITE_U, HERMITE_V } from '../integrals/hermite';
import { buildShellPairs } from '../integrals/shellPairs';
import { boys } from '../math/boys';
import type { QmInput, ScfResult } from '../types';
import { basisForResult } from './evaluate';

/**
 * Primitive products whose Hermite charge distribution cannot contribute more than about this much
 * (hartree/e) to the potential anywhere are left out.
 */
const ESP_PRIMITIVE_CUTOFF = 1e-13;

/** Points closer to a nucleus than this (bohr) are reported as +Infinity. */
const NUCLEUS_RADIUS = 1e-10;

const boysValues = new Float64Array(3);
const factors = new Float64Array(3);
const coulomb = new Float64Array(10);

// Local aliases of the imported kernels (see the note in integrals/eri.ts).
const boysUpTo = boys;
const coulombIntegrals = hermiteCoulomb;

/**
 * The electron density written as a sum of Hermite Gaussians, one small set per primitive product:
 * rho(r) = sum_products sum_tuv D_tuv Lambda_tuv(r; p, P). The potential of each Lambda_tuv at a
 * point C is (2 pi / p) R_tuv(p, P - C), so the density-matrix contraction is done once, not per point.
 */
interface HermiteDensity {
  readonly count: number;
  readonly order: Int8Array;
  readonly p: Float64Array;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly z: Float64Array;
  /** 10 values per product: -(2 pi / p) D_tuv (the minus sign is the electron charge). */
  readonly d: Float64Array;
}

function buildHermiteDensity(result: ScfResult, input: QmInput): HermiteDensity {
  const basis = basisForResult(result, input);
  const n = basis.nBasis;
  const density = result.densityMatrix;
  const pairs = buildShellPairs(basis);
  let capacity = 0;
  for (const pair of pairs) capacity += pair.nPrim;
  const order = new Int8Array(capacity);
  const p = new Float64Array(capacity);
  const x = new Float64Array(capacity);
  const y = new Float64Array(capacity);
  const z = new Float64Array(capacity);
  const d = new Float64Array(capacity * 10);
  const local = new Float64Array(10);
  let count = 0;

  for (const pair of pairs) {
    // Off-diagonal shell pairs stand for both (a, b) and (b, a).
    const weight = pair.a === pair.b ? 1 : 2;
    for (let i = 0; i < pair.nPrim; i++) {
      local.fill(0);
      for (let k = 0; k < pair.nnz; k++) {
        const fn = pair.nzFn[k];
        const mu = pair.firstA + ((fn / pair.nfb) | 0);
        const nu = pair.firstB + (fn % pair.nfb);
        local[pair.nzHerm[k]] += weight * density[mu * n + nu] * pair.e[i * pair.nnz + k];
      }
      const scale = (-2 * Math.PI) / pair.p[i];
      const twoP = 2 * pair.p[i];
      let bound = 0;
      for (let t = 0; t < pair.nHerm; t++) {
        const degree = HERMITE_T[t] + HERMITE_U[t] + HERMITE_V[t];
        bound += Math.abs(local[t] * scale) * Math.pow(twoP, degree / 2);
      }
      if (bound < ESP_PRIMITIVE_CUTOFF) continue;
      order[count] = pair.order;
      p[count] = pair.p[i];
      x[count] = pair.px[i];
      y[count] = pair.py[i];
      z[count] = pair.pz[i];
      for (let t = 0; t < 10; t++) d[count * 10 + t] = local[t] * scale;
      count++;
    }
  }
  return { count, order, p, x, y, z, d };
}

/**
 * Internal double-precision worker behind `evaluateEspAtPoints`: points in angstrom (any numeric
 * array), potential in hartree/e.
 */
export function electrostaticPotential(result: ScfResult, input: QmInput, points: ArrayLike<number>, onProgress?: (fraction: number) => void): Float64Array {
  if (points.length % 3 !== 0) throw new RangeError('Points must be given as xyz triples.');
  const count = points.length / 3;
  const hermite = buildHermiteDensity(result, input);
  const nuclei = atomsToBohr(input.atoms);
  const out = new Float64Array(count);
  const { order, p, x, y, z, d } = hermite;
  const reportEvery = Math.max(1, Math.min(4096, Math.ceil(count / 100)));

  for (let i = 0; i < count; i++) {
    const cx = points[3 * i] * ANGSTROM_TO_BOHR;
    const cy = points[3 * i + 1] * ANGSTROM_TO_BOHR;
    const cz = points[3 * i + 2] * ANGSTROM_TO_BOHR;

    let potential = 0;
    for (const nucleus of nuclei) {
      const distance = Math.hypot(cx - nucleus.x, cy - nucleus.y, cz - nucleus.zCoord);
      potential += distance < NUCLEUS_RADIUS ? Infinity : nucleus.z / distance;
    }

    let electronic = 0;
    for (let k = 0; k < hermite.count; k++) {
      const pk = p[k];
      const dx = x[k] - cx;
      const dy = y[k] - cy;
      const dz = z[k] - cz;
      const l = order[k];
      boysUpTo(l, pk * (dx * dx + dy * dy + dz * dz), boysValues);
      const o = k * 10;
      if (l === 0) {
        electronic += d[o] * boysValues[0];
        continue;
      }
      let factor = 1;
      for (let m = 0; m <= l; m++) {
        factors[m] = factor * boysValues[m];
        factor *= -2 * pk;
      }
      coulombIntegrals(l, dx, dy, dz, factors, coulomb);
      const terms = l === 1 ? 4 : 10;
      for (let t = 0; t < terms; t++) electronic += d[o + t] * coulomb[t];
    }
    out[i] = potential + electronic;
    if (onProgress && ((i + 1) % reportEvery === 0 || i + 1 === count)) onProgress((i + 1) / count);
  }
  return out;
}

/**
 * Molecular electrostatic potential at arbitrary points,
 *
 *   V(r) = sum_A Z_A / |r - R_A|  -  integral rho(r') / |r - r'| dr',
 *
 * i.e. the interaction energy of the unperturbed molecule with a unit positive point charge at r.
 *
 * Units: `points` are xyz triples in angstrom; returned values in hartree per elementary charge
 * (atomic units of potential; multiply by 27.211386 for volts, by 627.5095 for kcal/mol per e).
 * A point that coincides with a nucleus gives +Infinity. Far from a neutral molecule V tends to
 * zero, far from an ion of charge q to q / r.
 *
 * Cost: number of points times number of primitive products (about 1500 for benzene), so roughly
 * 0.1 ms per point for a 36-function molecule; use `onProgress` for large point sets.
 */
export function evaluateEspAtPoints(result: ScfResult, input: QmInput, points: Float32Array, onProgress?: (fraction: number) => void): Float32Array {
  return Float32Array.from(electrostaticPotential(result, input, points, onProgress));
}
