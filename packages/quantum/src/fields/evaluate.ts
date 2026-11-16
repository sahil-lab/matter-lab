import { ANGSTROM_TO_BOHR } from '@matterlab/core';
import { atomsToBohr, buildBasisBohr } from '../basis/basis';
import type { Basis, Shell } from '../basis/basis';
import { UnsupportedSystemError } from '../errors';
import { checkSupport, HARD_MAX_BASIS_FUNCTIONS } from '../support';
import type { GridSpec, QmInput, ScfResult } from '../types';
import { assertValidGrid } from './grid';

/**
 * A primitive Gaussian is skipped at a point when its contribution to the value of its basis
 * function there is below this amplitude (bohr^-3/2). Orbital amplitudes are therefore accurate
 * to about 1e-9 and densities to about 1e-8 e/bohr^3 in absolute terms even next to a nucleus,
 * far below both the single-precision resolution of the returned arrays and any isovalue of
 * practical interest; the tests compare against unscreened evaluation.
 */
export const FIELD_AMPLITUDE_CUTOFF = 1e-10;

/** Density-matrix elements smaller than this are skipped when contracting basis-function values. */
const DENSITY_ELEMENT_CUTOFF = 1e-14;

/**
 * Rebuilds the basis a result was computed in and checks that result and input belong together.
 */
export function basisForResult(result: ScfResult, input: QmInput): Basis {
  const report = checkSupport(input, { maxBasisFunctions: HARD_MAX_BASIS_FUNCTIONS });
  if (!report.supported) throw new UnsupportedSystemError(report.reasons);
  const basis = buildBasisBohr(atomsToBohr(input.atoms));
  const n = basis.nBasis;
  if (result.nBasis !== n || result.densityMatrix.length !== n * n || result.orbitalCoefficients.length !== n * n) {
    throw new RangeError(`The SCF result (${result.nBasis} basis functions) does not belong to this input (${n} basis functions).`);
  }
  if (Number.isNaN(result.densityMatrix[0])) {
    throw new Error('The SCF result holds no density (the calculation was cancelled before the first iteration).');
  }
  return basis;
}

/**
 * Squared distance beyond which a primitive c exp(-a r^2) (s) or c r exp(-a r^2) (p, bounded by
 * its value along the axis) stays below the amplitude cutoff.
 */
function cutoffRadiusSquared(exponent: number, coefS: number, coefP: number, cutoff: number): number {
  let r2 = 0;
  const cs = Math.abs(coefS);
  if (cs > cutoff) r2 = Math.log(cs / cutoff) / exponent;
  const cp = Math.abs(coefP);
  if (cp > 0) {
    // r exp(-a r^2) decreases beyond r = 1/sqrt(2a); solve c r exp(-a r^2) = cutoff there by fixed-point iteration.
    const turning = 1 / Math.sqrt(2 * exponent);
    if (cp * turning * Math.exp(-0.5) > cutoff) {
      let r = Math.max(turning, Math.sqrt(Math.max(Math.log(cp / cutoff), 0) / exponent));
      for (let i = 0; i < 30; i++) r = Math.max(turning, Math.sqrt(Math.max(Math.log((cp * r) / cutoff), 0) / exponent));
      // A small safety margin covers the remaining iteration error.
      r2 = Math.max(r2, r * r * 1.0001);
    }
  }
  return r2;
}

interface ShellCutoffs {
  /** Per primitive. */
  readonly r2: Float64Array;
  /** Largest of them: beyond this the whole shell is negligible. */
  readonly shellR2: number;
}

function shellCutoffs(shell: Shell, cutoff: number): ShellCutoffs {
  const r2 = new Float64Array(shell.nPrim);
  let shellR2 = 0;
  for (let k = 0; k < shell.nPrim; k++) {
    r2[k] = cutoff > 0 ? cutoffRadiusSquared(shell.exps[k], shell.coefS[k], shell.coefP[k], cutoff) : Infinity;
    shellR2 = Math.max(shellR2, r2[k]);
  }
  return { r2, shellR2 };
}

// ---------------------------------------------------------------------------------------------
// Regular grids
// ---------------------------------------------------------------------------------------------

/**
 * Evaluates all basis functions along one grid row (fixed iy, iz) at a time.
 *
 * A Gaussian factorises, exp(-a r^2) = exp(-a dx^2) exp(-a dy^2) exp(-a dz^2), so on an
 * axis-aligned grid every primitive needs just three one-dimensional tables and no exponential in
 * the inner loop. For each row a primitive contributes only on the stretch of x where it exceeds
 * the amplitude cutoff; every basis function records the stretch [lo, hi) on which it is non-zero.
 */
class GridRows {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  /** Values of basis function mu along the current row: ao[mu * nx + ix], valid for lo[mu] <= ix < hi[mu]. */
  readonly ao: Float64Array;
  readonly lo: Int32Array;
  readonly hi: Int32Array;
  /** Indices of the basis functions that are non-zero somewhere on the current row. */
  readonly active: Int32Array;
  nActive = 0;

  private readonly basis: Basis;
  private readonly xs: Float64Array;
  private readonly ys: Float64Array;
  private readonly zs: Float64Array;
  private readonly x0: number;
  private readonly hx: number;
  private readonly cutoffs: ShellCutoffs[];
  /** Per shell: tables[k] = exp(-a_k (x - Ax)^2) for all ix, and likewise for y and z. */
  private readonly gx: Float64Array[][];
  private readonly gy: Float64Array[][];
  private readonly gz: Float64Array[][];
  private readonly rowS: Float64Array;
  private readonly rowP: Float64Array;
  private readonly primLo: Int32Array;
  private readonly primHi: Int32Array;

  constructor(basis: Basis, grid: GridSpec, cutoff: number) {
    assertValidGrid(grid);
    this.basis = basis;
    [this.nx, this.ny, this.nz] = grid.dims;
    const axis = (index: number, count: number): Float64Array => {
      const out = new Float64Array(count);
      for (let i = 0; i < count; i++) out[i] = (grid.origin[index] + i * grid.spacing[index]) * ANGSTROM_TO_BOHR;
      return out;
    };
    this.xs = axis(0, this.nx);
    this.ys = axis(1, this.ny);
    this.zs = axis(2, this.nz);
    this.x0 = this.xs[0];
    this.hx = grid.spacing[0] * ANGSTROM_TO_BOHR;

    const table = (coords: Float64Array, centre: number, exponent: number): Float64Array => {
      const out = new Float64Array(coords.length);
      for (let i = 0; i < coords.length; i++) {
        const d = coords[i] - centre;
        out[i] = Math.exp(-exponent * d * d);
      }
      return out;
    };
    this.cutoffs = basis.shells.map((shell) => shellCutoffs(shell, cutoff));
    this.gx = basis.shells.map((shell) => Array.from(shell.exps, (a) => table(this.xs, shell.x, a)));
    this.gy = basis.shells.map((shell) => Array.from(shell.exps, (a) => table(this.ys, shell.y, a)));
    this.gz = basis.shells.map((shell) => Array.from(shell.exps, (a) => table(this.zs, shell.z, a)));

    const n = basis.nBasis;
    this.ao = new Float64Array(n * this.nx);
    this.lo = new Int32Array(n);
    this.hi = new Int32Array(n);
    this.active = new Int32Array(n);
    this.rowS = new Float64Array(this.nx);
    this.rowP = new Float64Array(this.nx);
    const maxPrim = basis.shells.reduce((m, shell) => Math.max(m, shell.nPrim), 0);
    this.primLo = new Int32Array(maxPrim);
    this.primHi = new Int32Array(maxPrim);
  }

  /** Fills `ao`, `lo`, `hi` and the list of active functions for row (iy, iz). */
  compute(iy: number, iz: number): void {
    const { nx, xs, x0, hx, ao, lo, hi, rowS, rowP, primLo, primHi } = this;
    const shells = this.basis.shells;
    this.nActive = 0;
    for (let s = 0; s < shells.length; s++) {
      const shell = shells[s];
      const first = shell.firstFunction;
      const dy = this.ys[iy] - shell.y;
      const dz = this.zs[iz] - shell.z;
      const rho2 = dy * dy + dz * dz;
      const cut = this.cutoffs[s];
      let from = nx;
      let to = 0;
      if (rho2 < cut.shellR2) {
        for (let k = 0; k < shell.nPrim; k++) {
          const remaining = cut.r2[k] - rho2;
          primLo[k] = 0;
          primHi[k] = 0;
          if (!(remaining > 0)) continue;
          let a = 0;
          let b = nx;
          if (remaining !== Infinity) {
            const reach = Math.sqrt(remaining);
            a = Math.max(0, Math.ceil((shell.x - reach - x0) / hx));
            b = Math.min(nx, Math.floor((shell.x + reach - x0) / hx) + 1);
          }
          if (a >= b) continue;
          primLo[k] = a;
          primHi[k] = b;
          if (a < from) from = a;
          if (b > to) to = b;
        }
      }
      if (from >= to) {
        for (let f = 0; f < shell.nFunctions; f++) {
          lo[first + f] = 0;
          hi[first + f] = 0;
        }
        continue;
      }

      for (let ix = from; ix < to; ix++) {
        rowS[ix] = 0;
        rowP[ix] = 0;
      }
      for (let k = 0; k < shell.nPrim; k++) {
        const a = primLo[k];
        const b = primHi[k];
        if (a >= b) continue;
        const yz = this.gy[s][k][iy] * this.gz[s][k][iz];
        const fs = shell.coefS[k] * yz;
        const fp = shell.coefP[k] * yz;
        const g = this.gx[s][k];
        if (shell.hasS && shell.hasP) {
          for (let ix = a; ix < b; ix++) {
            const v = g[ix];
            rowS[ix] += fs * v;
            rowP[ix] += fp * v;
          }
        } else if (shell.hasS) {
          for (let ix = a; ix < b; ix++) rowS[ix] += fs * g[ix];
        } else {
          for (let ix = a; ix < b; ix++) rowP[ix] += fp * g[ix];
        }
      }

      for (let f = 0; f < shell.nFunctions; f++) {
        const mu = first + f;
        const offset = mu * nx;
        const kind = shell.kinds[f];
        if (kind < 0) {
          for (let ix = from; ix < to; ix++) ao[offset + ix] = rowS[ix];
        } else if (kind === 0) {
          const ax = shell.x;
          for (let ix = from; ix < to; ix++) ao[offset + ix] = (xs[ix] - ax) * rowP[ix];
        } else {
          const d = kind === 1 ? dy : dz;
          for (let ix = from; ix < to; ix++) ao[offset + ix] = d * rowP[ix];
        }
        lo[mu] = from;
        hi[mu] = to;
        this.active[this.nActive++] = mu;
      }
    }
  }
}

function gridSize(grid: GridSpec): number {
  return grid.dims[0] * grid.dims[1] * grid.dims[2];
}

/** Internal: density on a grid with an explicit amplitude cutoff (0 disables screening). */
export function densityGridWithCutoff(
  result: ScfResult,
  input: QmInput,
  grid: GridSpec,
  cutoff: number,
  onProgress?: (fraction: number) => void,
): Float32Array {
  const basis = basisForResult(result, input);
  const rows = new GridRows(basis, grid, cutoff);
  const { nx, ny, nz, ao, lo, hi, active } = rows;
  const n = basis.nBasis;
  const density = result.densityMatrix;
  const out = new Float32Array(gridSize(grid));
  const rho = new Float64Array(nx);
  const partial = new Float64Array(nx);

  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      rows.compute(iy, iz);
      rho.fill(0);
      // rho = sum_mu phi_mu (P_mu,mu phi_mu + 2 sum_{nu<mu} P_mu,nu phi_nu)
      for (let a = 0; a < rows.nActive; a++) {
        const mu = active[a];
        const muLo = lo[mu];
        const muHi = hi[mu];
        const muOffset = mu * nx;
        const pmm = density[mu * n + mu];
        for (let ix = muLo; ix < muHi; ix++) partial[ix] = pmm * ao[muOffset + ix];
        for (let b = 0; b < a; b++) {
          const nu = active[b];
          const w = 2 * density[mu * n + nu];
          if (w < DENSITY_ELEMENT_CUTOFF && w > -DENSITY_ELEMENT_CUTOFF) continue;
          const from = muLo > lo[nu] ? muLo : lo[nu];
          const to = muHi < hi[nu] ? muHi : hi[nu];
          const nuOffset = nu * nx;
          for (let ix = from; ix < to; ix++) partial[ix] += w * ao[nuOffset + ix];
        }
        for (let ix = muLo; ix < muHi; ix++) rho[ix] += ao[muOffset + ix] * partial[ix];
      }
      out.set(rho, nx * (iy + ny * iz));
    }
    onProgress?.((iz + 1) / nz);
  }
  return out;
}

/**
 * Electron density rho(r) = sum_{mu nu} P_{mu nu} phi_mu(r) phi_nu(r) on a regular grid.
 *
 * Units: grid geometry in angstrom; returned values in electrons per bohr^3 (multiply by
 * 1 / 0.529177210903^3 = 6.7483 for electrons per angstrom^3). Value index: ix + dims[0] * (iy +
 * dims[1] * iz). Integrating the result over all space gives the number of electrons.
 */
export function evaluateDensityGrid(result: ScfResult, input: QmInput, grid: GridSpec, onProgress?: (fraction: number) => void): Float32Array {
  return densityGridWithCutoff(result, input, grid, FIELD_AMPLITUDE_CUTOFF, onProgress);
}

/**
 * Molecular orbital psi_i(r) = sum_mu C_{mu i} phi_mu(r) on a regular grid.
 *
 * Units: grid geometry in angstrom; returned amplitudes in bohr^(-3/2). The overall sign of an
 * orbital is arbitrary (the engine makes the largest coefficient positive) and degenerate
 * orbitals may be any orthonormal combination within their degenerate set.
 */
export function evaluateOrbitalGrid(
  result: ScfResult,
  input: QmInput,
  orbitalIndex: number,
  grid: GridSpec,
  onProgress?: (fraction: number) => void,
): Float32Array {
  const basis = basisForResult(result, input);
  const n = basis.nBasis;
  if (!Number.isInteger(orbitalIndex) || orbitalIndex < 0 || orbitalIndex >= n) {
    throw new RangeError(`Orbital index ${orbitalIndex} is outside 0..${n - 1}.`);
  }
  const rows = new GridRows(basis, grid, FIELD_AMPLITUDE_CUTOFF);
  const { nx, ny, nz, ao, lo, hi, active } = rows;
  const coefficients = result.orbitalCoefficients;
  const out = new Float32Array(gridSize(grid));
  const psi = new Float64Array(nx);

  for (let iz = 0; iz < nz; iz++) {
    for (let iy = 0; iy < ny; iy++) {
      rows.compute(iy, iz);
      psi.fill(0);
      for (let a = 0; a < rows.nActive; a++) {
        const mu = active[a];
        const c = coefficients[mu * n + orbitalIndex];
        if (c === 0) continue;
        const offset = mu * nx;
        for (let ix = lo[mu]; ix < hi[mu]; ix++) psi[ix] += c * ao[offset + ix];
      }
      out.set(psi, nx * (iy + ny * iz));
    }
    onProgress?.((iz + 1) / nz);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Arbitrary points
// ---------------------------------------------------------------------------------------------

/** Values of all basis functions at one point (bohr); returns the number of non-zero functions listed in `active`. */
function basisFunctionsAt(
  basis: Basis,
  cutoffs: readonly ShellCutoffs[],
  x: number,
  y: number,
  z: number,
  phi: Float64Array,
  active: Int32Array,
): number {
  let nActive = 0;
  const shells = basis.shells;
  for (let s = 0; s < shells.length; s++) {
    const shell = shells[s];
    const dx = x - shell.x;
    const dy = y - shell.y;
    const dz = z - shell.z;
    const r2 = dx * dx + dy * dy + dz * dz;
    const cut = cutoffs[s];
    if (!(r2 < cut.shellR2)) continue;
    let radialS = 0;
    let radialP = 0;
    for (let k = 0; k < shell.nPrim; k++) {
      if (!(r2 < cut.r2[k])) continue;
      const g = Math.exp(-shell.exps[k] * r2);
      radialS += shell.coefS[k] * g;
      radialP += shell.coefP[k] * g;
    }
    for (let f = 0; f < shell.nFunctions; f++) {
      const kind = shell.kinds[f];
      const mu = shell.firstFunction + f;
      phi[mu] = kind < 0 ? radialS : (kind === 0 ? dx : kind === 1 ? dy : dz) * radialP;
      active[nActive++] = mu;
    }
  }
  return nActive;
}

function assertPoints(points: ArrayLike<number>): number {
  if (points.length % 3 !== 0) throw new RangeError('Points must be given as xyz triples.');
  return points.length / 3;
}

/** Internal: density at points with an explicit amplitude cutoff (0 disables screening); double precision. */
export function densityAtPointsWithCutoff(result: ScfResult, input: QmInput, points: ArrayLike<number>, cutoff: number): Float64Array {
  const basis = basisForResult(result, input);
  const n = basis.nBasis;
  const count = assertPoints(points);
  const cutoffs = basis.shells.map((shell) => shellCutoffs(shell, cutoff));
  const phi = new Float64Array(n);
  const active = new Int32Array(n);
  const density = result.densityMatrix;
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const nActive = basisFunctionsAt(
      basis,
      cutoffs,
      points[3 * i] * ANGSTROM_TO_BOHR,
      points[3 * i + 1] * ANGSTROM_TO_BOHR,
      points[3 * i + 2] * ANGSTROM_TO_BOHR,
      phi,
      active,
    );
    let rho = 0;
    for (let a = 0; a < nActive; a++) {
      const mu = active[a];
      let partial = density[mu * n + mu] * phi[mu];
      for (let b = 0; b < a; b++) {
        const nu = active[b];
        partial += 2 * density[mu * n + nu] * phi[nu];
      }
      rho += phi[mu] * partial;
    }
    out[i] = rho;
  }
  return out;
}

/**
 * Electron density at arbitrary points.
 *
 * Units: `points` are xyz triples in angstrom; returned values in electrons per bohr^3, one per
 * point.
 */
export function evaluateDensityAtPoints(result: ScfResult, input: QmInput, points: Float32Array): Float32Array {
  return Float32Array.from(densityAtPointsWithCutoff(result, input, points, FIELD_AMPLITUDE_CUTOFF));
}

/** Internal: one molecular orbital at points (angstrom), double precision, with an explicit amplitude cutoff. */
export function orbitalAtPointsWithCutoff(result: ScfResult, input: QmInput, orbitalIndex: number, points: ArrayLike<number>, cutoff: number): Float64Array {
  const basis = basisForResult(result, input);
  const n = basis.nBasis;
  if (!Number.isInteger(orbitalIndex) || orbitalIndex < 0 || orbitalIndex >= n) {
    throw new RangeError(`Orbital index ${orbitalIndex} is outside 0..${n - 1}.`);
  }
  const count = points.length / 3;
  const cutoffs = basis.shells.map((shell) => shellCutoffs(shell, cutoff));
  const phi = new Float64Array(n);
  const active = new Int32Array(n);
  const out = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const nActive = basisFunctionsAt(
      basis,
      cutoffs,
      points[3 * i] * ANGSTROM_TO_BOHR,
      points[3 * i + 1] * ANGSTROM_TO_BOHR,
      points[3 * i + 2] * ANGSTROM_TO_BOHR,
      phi,
      active,
    );
    let psi = 0;
    for (let a = 0; a < nActive; a++) {
      const mu = active[a];
      psi += result.orbitalCoefficients[mu * n + orbitalIndex] * phi[mu];
    }
    out[i] = psi;
  }
  return out;
}

/**
 * One molecular orbital at arbitrary points (not part of the required API, but convenient for
 * colouring surfaces by orbital phase). `points` in angstrom, amplitudes in bohr^(-3/2).
 */
export function evaluateOrbitalAtPoints(result: ScfResult, input: QmInput, orbitalIndex: number, points: Float32Array): Float32Array {
  assertPoints(points);
  return Float32Array.from(orbitalAtPointsWithCutoff(result, input, orbitalIndex, points, FIELD_AMPLITUDE_CUTOFF));
}
