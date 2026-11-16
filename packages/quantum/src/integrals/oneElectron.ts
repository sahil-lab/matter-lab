import type { Basis } from '../basis/basis';
import { KIND_S } from '../basis/basis';
import { boys } from '../math/boys';
import { hermiteCoulomb } from './hermite';
import type { ShellPair } from './shellPairs';

/** A point charge in atomic units: charge in e, position in bohr. */
export interface PointCharge {
  readonly charge: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface OverlapKineticDipole {
  /** S_mu,nu = <mu|nu>, row-major n x n. */
  readonly overlap: Float64Array;
  /** T_mu,nu = <mu| -1/2 nabla^2 |nu> in hartree. */
  readonly kinetic: Float64Array;
  /** <mu| r - origin |nu> for x, y, z in bohr (no charge sign). */
  readonly dipole: readonly [Float64Array, Float64Array, Float64Array];
}

/**
 * One-dimensional overlap integrals s(i, j) = integral (x - A)^i (x - B)^j exp(-p (x - P)^2) dx
 * divided by sqrt(pi/p), for i = 0..2 and j = 0..3, by the Obara-Saika recurrence
 * s(i+1, j) = PA s(i, j) + h (i s(i-1, j) + j s(i, j-1)) with h = 1/(2p) (and PB for j).
 * Stored at table[i * 4 + j].
 */
function overlap1d(table: Float64Array, pa: number, pb: number, h: number): void {
  table[0] = 1;
  table[1] = pb;
  table[2] = pb * table[1] + h;
  table[3] = pb * table[2] + 2 * h * table[1];
  table[4] = pa;
  table[5] = pa * table[1] + h;
  table[6] = pa * table[2] + 2 * h * table[1];
  table[7] = pa * table[3] + 3 * h * table[2];
  table[8] = pa * table[4] + h;
  table[9] = pa * table[5] + h * (table[1] + table[4]);
  table[10] = pa * table[6] + h * (table[2] + 2 * table[5]);
  table[11] = pa * table[7] + h * (table[3] + 3 * table[6]);
}

/**
 * Overlap, kinetic-energy and dipole integrals over the contracted basis, from products of
 * one-dimensional overlaps (Obara and Saika, J. Chem. Phys. 84, 3963 (1986)):
 *
 *   S = Sx Sy Sz,   T = Tx Sy Sz + Sx Ty Sz + Sx Sy Tz,
 *   Tx(i, j) = -2 b^2 s(i, j+2) + b (2j + 1) s(i, j) - j (j - 1) / 2 s(i, j-2),
 *   <a| x - Ox |b> = (s(i+1, j) + (Ax - Ox) s(i, j)) Sy Sz.
 */
export function computeOverlapKineticDipole(basis: Basis, origin: readonly [number, number, number] = [0, 0, 0]): OverlapKineticDipole {
  const n = basis.nBasis;
  const overlap = new Float64Array(n * n);
  const kinetic = new Float64Array(n * n);
  const dipole: [Float64Array, Float64Array, Float64Array] = [new Float64Array(n * n), new Float64Array(n * n), new Float64Array(n * n)];
  const tx = new Float64Array(12);
  const ty = new Float64Array(12);
  const tz = new Float64Array(12);
  const { shells } = basis;

  for (let a = 0; a < shells.length; a++) {
    const sa = shells[a];
    const dax = sa.x - origin[0];
    const day = sa.y - origin[1];
    const daz = sa.z - origin[2];
    for (let b = 0; b <= a; b++) {
      const sb = shells[b];
      const abx = sa.x - sb.x;
      const aby = sa.y - sb.y;
      const abz = sa.z - sb.z;
      const r2 = abx * abx + aby * aby + abz * abz;
      for (let i = 0; i < sa.nPrim; i++) {
        const ea = sa.exps[i];
        for (let j = 0; j < sb.nPrim; j++) {
          const eb = sb.exps[j];
          const p = ea + eb;
          const h = 0.5 / p;
          const prefactor = Math.exp((-ea * eb * r2) / p) * Math.pow(Math.PI / p, 1.5);
          const fa = -eb / p;
          const fb = ea / p;
          overlap1d(tx, fa * abx, fb * abx, h);
          overlap1d(ty, fa * aby, fb * aby, h);
          overlap1d(tz, fa * abz, fb * abz, h);
          for (let ia = 0; ia < sa.nFunctions; ia++) {
            const ka = sa.kinds[ia];
            const ca = ka === KIND_S ? sa.coefS[i] : sa.coefP[i];
            const lax = ka === 0 ? 1 : 0;
            const lay = ka === 1 ? 1 : 0;
            const laz = ka === 2 ? 1 : 0;
            const mu = sa.firstFunction + ia;
            for (let ib = 0; ib < sb.nFunctions; ib++) {
              const kb = sb.kinds[ib];
              const c = ca * (kb === KIND_S ? sb.coefS[j] : sb.coefP[j]) * prefactor;
              const lbx = kb === 0 ? 1 : 0;
              const lby = kb === 1 ? 1 : 0;
              const lbz = kb === 2 ? 1 : 0;
              const nu = sb.firstFunction + ib;
              const sx = tx[lax * 4 + lbx];
              const sy = ty[lay * 4 + lby];
              const sz = tz[laz * 4 + lbz];
              // The j (j - 1) / 2 term vanishes for s and p functions.
              const kx = -2 * eb * eb * tx[lax * 4 + lbx + 2] + eb * (2 * lbx + 1) * sx;
              const ky = -2 * eb * eb * ty[lay * 4 + lby + 2] + eb * (2 * lby + 1) * sy;
              const kz = -2 * eb * eb * tz[laz * 4 + lbz + 2] + eb * (2 * lbz + 1) * sz;
              const index = mu * n + nu;
              overlap[index] += c * sx * sy * sz;
              kinetic[index] += c * (kx * sy * sz + sx * ky * sz + sx * sy * kz);
              dipole[0][index] += c * (tx[(lax + 1) * 4 + lbx] + dax * sx) * sy * sz;
              dipole[1][index] += c * sx * (ty[(lay + 1) * 4 + lby] + day * sy) * sz;
              dipole[2][index] += c * sx * sy * (tz[(laz + 1) * 4 + lbz] + daz * sz);
            }
          }
        }
      }
    }
  }

  // Shell pairs were visited with a >= b only; mirror the lower triangle.
  for (const matrix of [overlap, kinetic, dipole[0], dipole[1], dipole[2]]) {
    for (let mu = 0; mu < n; mu++) {
      for (let nu = 0; nu < mu; nu++) {
        // Functions of the same shell were both computed; those results agree to rounding.
        matrix[nu * n + mu] = matrix[mu * n + nu];
      }
    }
  }
  return { overlap, kinetic, dipole };
}

const boysValues = new Float64Array(3);
const coulombFactors = new Float64Array(3);
const coulomb = new Float64Array(10);

/**
 * Nuclear-attraction integrals V_mu,nu = sum_C -Z_C <mu| 1/|r - C| |nu> in hartree, by the
 * McMurchie-Davidson scheme: for each primitive product,
 * <a| 1/|r - C| |b> = (2 pi / p) sum_tuv E^{ab}_{tuv} R_tuv(p, P - C).
 */
export function computeNuclearAttraction(basis: Basis, pairs: readonly ShellPair[], nuclei: readonly PointCharge[]): Float64Array {
  const n = basis.nBasis;
  const result = new Float64Array(n * n);
  const acc = new Float64Array(16);
  for (const pair of pairs) {
    const { nnz, nzFn, nzHerm, e, order } = pair;
    acc.fill(0);
    for (let i = 0; i < pair.nPrim; i++) {
      const p = pair.p[i];
      const eo = i * nnz;
      for (const nucleus of nuclei) {
        const x = pair.px[i] - nucleus.x;
        const y = pair.py[i] - nucleus.y;
        const z = pair.pz[i] - nucleus.z;
        boys(order, p * (x * x + y * y + z * z), boysValues);
        let factor = (-nucleus.charge * 2 * Math.PI) / p;
        for (let m = 0; m <= order; m++) {
          coulombFactors[m] = factor * boysValues[m];
          factor *= -2 * p;
        }
        hermiteCoulomb(order, x, y, z, coulombFactors, coulomb);
        for (let k = 0; k < nnz; k++) acc[nzFn[k]] += e[eo + k] * coulomb[nzHerm[k]];
      }
    }
    for (let ia = 0; ia < pair.nfa; ia++) {
      const mu = pair.firstA + ia;
      for (let ib = 0; ib < pair.nfb; ib++) {
        const nu = pair.firstB + ib;
        const value = acc[ia * pair.nfb + ib];
        result[mu * n + nu] = value;
        result[nu * n + mu] = value;
      }
    }
  }
  return result;
}

/** Coulomb repulsion between the nuclei in hartree: sum_{A<B} Z_A Z_B / R_AB. */
export function nuclearRepulsionEnergy(nuclei: readonly PointCharge[]): number {
  let energy = 0;
  for (let a = 0; a < nuclei.length; a++) {
    for (let b = 0; b < a; b++) {
      const distance = Math.hypot(nuclei[a].x - nuclei[b].x, nuclei[a].y - nuclei[b].y, nuclei[a].z - nuclei[b].z);
      energy += (nuclei[a].charge * nuclei[b].charge) / distance;
    }
  }
  return energy;
}
