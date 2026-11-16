import type { Basis } from '../basis/basis';
import { UnsupportedSystemError } from '../errors';
import { computeEri } from '../integrals/eri';
import { computeNuclearAttraction, computeOverlapKineticDipole, nuclearRepulsionEnergy } from '../integrals/oneElectron';
import type { PointCharge } from '../integrals/oneElectron';
import { buildShellPairs } from '../integrals/shellPairs';
import { dot, multiply, symmetricEigen } from '../math/linalg';
import type { ScfIteration, ScfOptions } from '../types';
import { Diis } from './diis';
import { buildTwoElectronFock } from './fock';
import { lowestRotationEigenpair } from './stability';
import type { StabilityOptions } from './stability';

export const DEFAULT_MAX_ITERATIONS = 100;
export const DEFAULT_ENERGY_TOLERANCE = 1e-9;
export const DEFAULT_DENSITY_TOLERANCE = 1e-7;

/** Overlap eigenvalues below this make the symmetric orthogonalisation numerically meaningless. */
const LINEAR_DEPENDENCE_LIMIT = 1e-10;
/** Below this the basis is flagged as nearly linearly dependent. */
const LINEAR_DEPENDENCE_WARNING = 1e-5;
/** A HOMO-LUMO gap below this (hartree) is flagged: the closed-shell solution is then ill defined. */
const SMALL_GAP_WARNING = 1e-4;
/** An orbital-rotation Hessian eigenvalue below minus this (hartree) counts as an instability. */
const INSTABILITY_THRESHOLD = 1e-5;
/** How many times a saddle point is left along its unstable direction before giving up. */
const MAX_INSTABILITY_FOLLOWS = 4;
/** Rotation angles (radians, for the dominant orbital pair) tried when leaving a saddle point. */
const FOLLOW_ANGLES = [15, 30, 45, 60, 75, 90].map((degrees) => (degrees * Math.PI) / 180);

const now: () => number = typeof performance !== 'undefined' ? () => performance.now() : () => Date.now();

/** Everything the SCF produces, in atomic units, before it is packaged as a public `ScfResult`. */
export interface RhfCoreResult {
  readonly converged: boolean;
  readonly cancelled: boolean;
  /** True when cancellation happened before any density existed; all numeric results are then NaN. */
  readonly empty: boolean;
  readonly iterations: ScfIteration[];
  readonly nOccupied: number;
  readonly energy: {
    readonly total: number;
    readonly electronic: number;
    readonly nuclearRepulsion: number;
    readonly kinetic: number;
    readonly nuclearAttraction: number;
    readonly twoElectron: number;
  };
  readonly orbitalEnergies: Float64Array;
  readonly orbitalCoefficients: Float64Array;
  readonly densityMatrix: Float64Array;
  readonly overlapMatrix: Float64Array;
  /** Net Mulliken charge of every nucleus, in e. */
  readonly mullikenCharges: number[];
  /** Dipole moment in e a0 relative to `dipoleOrigin`. */
  readonly dipole: [number, number, number];
  /** Centre of nuclear charge in bohr. */
  readonly dipoleOrigin: [number, number, number];
  /** Largest absolute element of X^T (FPS - SPF) X for the returned density, in hartree. */
  readonly residual: number;
  readonly smallestOverlapEigenvalue: number;
  readonly stability: {
    /**
     * True when it is established that the returned solution has no internal instability: either
     * its orbital-rotation Hessian was diagonalised in full, or the certificate of the iterative
     * search was obtained (see stability.ts for what that certificate does and does not exclude).
     */
    readonly verified: boolean;
    /**
     * Lowest eigenvalue of the orbital-rotation Hessian of the returned solution, when analysed:
     * the exact one if `lowestEigenvalueIsExact`, otherwise an upper bound to it.
     */
    readonly lowestEigenvalue: number | null;
    readonly lowestEigenvalueIsExact: boolean;
    /** Number of saddle points that were left along their unstable direction on the way. */
    readonly saddlePointsLeft: number;
    /** Hessian-vector products (Fock builds) spent on the stability analyses. */
    readonly hessianProducts: number;
  };
  readonly integralStatistics: { readonly shellQuartets: number; readonly shellQuartetsScreened: number; readonly primitiveQuartets: number };
  readonly timings: { readonly integralsMs: number; readonly scfMs: number; readonly totalMs: number };
  readonly warnings: string[];
}

function centreOfNuclearCharge(nuclei: readonly PointCharge[]): [number, number, number] {
  let total = 0;
  let x = 0;
  let y = 0;
  let z = 0;
  for (const nucleus of nuclei) {
    total += nucleus.charge;
    x += nucleus.charge * nucleus.x;
    y += nucleus.charge * nucleus.y;
    z += nucleus.charge * nucleus.z;
  }
  return total > 0 ? [x / total, y / total, z / total] : [0, 0, 0];
}

function filled(length: number, value: number): Float64Array {
  return new Float64Array(length).fill(value);
}

/**
 * Restricted (closed-shell) Hartree-Fock in a given contracted Gaussian basis (C. C. J. Roothaan,
 * Rev. Mod. Phys. 23, 69 (1951)).
 *
 *  1. All integrals are computed up front (conventional SCF): S, T, V, dipole and the packed table
 *     of unique two-electron integrals.
 *  2. Symmetric (Loewdin) orthogonalisation X = S^(-1/2) from the eigen-decomposition of S.
 *  3. Core-Hamiltonian guess: the first orbitals diagonalise H = T + V.
 *  4. Iterations: F = H + G(P), E = 1/2 tr P (H + F) + E_nuc, DIIS extrapolation of F, diagonalise
 *     X F X, occupy the lowest N/2 orbitals, P = 2 C_occ C_occ^T. Converged when both |dE| and the
 *     RMS change of P are below their tolerances.
 *  5. Stability: the core-Hamiltonian guess occasionally leads to a saddle point of the energy
 *     (N2 is the textbook case: an antibonding pi orbital stays occupied). The converged solution
 *     is therefore tested for internal stability (see stability.ts); if an orbital rotation lowers
 *     the energy, the orbitals are rotated along it and the SCF continues from there.
 *  6. The reported energies, orbital energies (expectation values of the final Fock operator) and
 *     properties all belong to the final density, for which one more Fock matrix is built.
 *
 * `nElectrons` must be even and positive and at most twice the number of basis functions; the
 * public entry point `runRhf` guarantees this through `checkSupport`.
 */
/** Switches for tests and diagnostics; the public entry point always uses the defaults. */
export interface RhfCoreSettings {
  /** How many saddle points may be left; 0 returns the first converged solution as it is. Default 4. */
  readonly maxInstabilityFollows?: number;
  /** Overrides for the stability analysis, e.g. `exactLimit: 0` to force the iterative search. */
  readonly stability?: Pick<StabilityOptions, 'exactLimit' | 'maxProducts' | 'certificateTolerance' | 'tolerance'>;
}

export function runRhfCore(basis: Basis, nuclei: readonly PointCharge[], nElectrons: number, options: ScfOptions = {}, settings: RhfCoreSettings = {}): RhfCoreResult {
  const maxInstabilityFollows = settings.maxInstabilityFollows ?? MAX_INSTABILITY_FOLLOWS;
  const start = now();
  const n = basis.nBasis;
  const nOcc = nElectrons / 2;
  if (!Number.isInteger(nOcc) || nOcc < 1 || nOcc > n) {
    throw new UnsupportedSystemError([`A closed-shell calculation needs an even, positive electron count of at most ${2 * n} (got ${nElectrons}).`]);
  }
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const energyTolerance = options.energyTolerance ?? DEFAULT_ENERGY_TOLERANCE;
  const densityTolerance = options.densityTolerance ?? DEFAULT_DENSITY_TOLERANCE;
  if (!Number.isInteger(maxIterations) || maxIterations < 1) throw new RangeError('maxIterations must be a positive integer.');
  if (!(energyTolerance > 0) || !(densityTolerance > 0)) throw new RangeError('Convergence tolerances must be positive.');

  const warnings: string[] = [];
  const iterations: ScfIteration[] = [];
  const origin = centreOfNuclearCharge(nuclei);
  const nuclearRepulsion = nuclearRepulsionEnergy(nuclei);

  // ---- integrals -------------------------------------------------------------------------
  options.onPhase?.('integrals', 0);
  const pairs = buildShellPairs(basis);
  const { overlap, kinetic, dipole: dipoleIntegrals } = computeOverlapKineticDipole(basis, origin);
  const nuclearAttraction = computeNuclearAttraction(basis, pairs, nuclei);
  const eri = computeEri(basis, pairs, {
    onProgress: options.onPhase ? (fraction) => options.onPhase?.('integrals', fraction) : undefined,
    isCancelled: options.isCancelled,
  });
  const integralsDone = now();
  const integralStatistics = {
    shellQuartets: eri.shellQuartets,
    shellQuartetsScreened: eri.shellQuartetsScreened,
    primitiveQuartets: eri.primitiveQuartets,
  };

  if (eri.cancelled) {
    warnings.push('The calculation was cancelled while the integrals were being computed; no energies, orbitals or properties are available (NaN).');
    return {
      converged: false,
      cancelled: true,
      empty: true,
      iterations,
      nOccupied: nOcc,
      energy: { total: NaN, electronic: NaN, nuclearRepulsion, kinetic: NaN, nuclearAttraction: NaN, twoElectron: NaN },
      orbitalEnergies: filled(n, NaN),
      orbitalCoefficients: filled(n * n, NaN),
      densityMatrix: filled(n * n, NaN),
      overlapMatrix: overlap,
      mullikenCharges: nuclei.map(() => NaN),
      dipole: [NaN, NaN, NaN],
      dipoleOrigin: origin,
      residual: NaN,
      smallestOverlapEigenvalue: NaN,
      stability: { verified: false, lowestEigenvalue: null, lowestEigenvalueIsExact: false, saddlePointsLeft: 0, hessianProducts: 0 },
      integralStatistics,
      timings: { integralsMs: integralsDone - start, scfMs: 0, totalMs: now() - start },
      warnings,
    };
  }

  // ---- orthogonalisation -------------------------------------------------------------------
  const overlapEigen = symmetricEigen(overlap, n);
  const smallestOverlapEigenvalue = overlapEigen.values[0];
  if (!(smallestOverlapEigenvalue > LINEAR_DEPENDENCE_LIMIT)) {
    throw new UnsupportedSystemError([
      `The basis functions are linearly dependent (smallest overlap eigenvalue ${smallestOverlapEigenvalue.toExponential(2)}), which happens when nuclei are unphysically close.`,
    ]);
  }
  if (smallestOverlapEigenvalue < LINEAR_DEPENDENCE_WARNING) {
    warnings.push(
      `The basis is nearly linearly dependent (smallest overlap eigenvalue ${smallestOverlapEigenvalue.toExponential(2)}); the results carry larger numerical errors than usual.`,
    );
  }
  const x = new Float64Array(n * n);
  for (let k = 0; k < n; k++) {
    const scale = 1 / Math.sqrt(overlapEigen.values[k]);
    for (let i = 0; i < n; i++) {
      const uik = overlapEigen.vectors[i * n + k] * scale;
      for (let j = 0; j < n; j++) x[i * n + j] += uik * overlapEigen.vectors[j * n + k];
    }
  }

  // ---- work space ----------------------------------------------------------------------------
  const core = new Float64Array(n * n);
  for (let i = 0; i < n * n; i++) core[i] = kinetic[i] + nuclearAttraction[i];
  const fock = new Float64Array(n * n);
  const twoElectron = new Float64Array(n * n);
  const extrapolated = new Float64Array(n * n);
  const error = new Float64Array(n * n);
  const tmp1 = new Float64Array(n * n);
  const tmp2 = new Float64Array(n * n);
  let density: Float64Array = new Float64Array(n * n);
  let nextDensity: Float64Array = new Float64Array(n * n);
  let coefficients: Float64Array = new Float64Array(n * n);
  let orbitalEnergies: Float64Array = new Float64Array(n);

  /** Solves F C = S C e through the orthogonalised problem (X F X) C' = C' e, C = X C'. */
  const diagonalise = (f: Float64Array): void => {
    multiply(x, f, n, tmp1);
    multiply(tmp1, x, n, tmp2);
    const eigen = symmetricEigen(tmp2, n);
    orbitalEnergies = eigen.values;
    coefficients = new Float64Array(n * n);
    multiply(x, eigen.vectors, n, coefficients);
  };

  const buildDensity = (c: Float64Array, out: Float64Array): void => {
    for (let mu = 0; mu < n; mu++) {
      for (let nu = 0; nu <= mu; nu++) {
        let sum = 0;
        for (let i = 0; i < nOcc; i++) sum += c[mu * n + i] * c[nu * n + i];
        out[mu * n + nu] = 2 * sum;
        out[nu * n + mu] = 2 * sum;
      }
    }
  };

  /** Total energy of a density; leaves G(P) in `twoElectron`. */
  const energyOf = (p: Float64Array): number => {
    buildTwoElectronFock(eri.values, p, n, twoElectron, tmp1);
    return dot(p, core) + 0.5 * dot(p, twoElectron) + nuclearRepulsion;
  };

  /** error = X (F P S - S P F) X; returns its largest absolute element. */
  const commutator = (f: Float64Array, p: Float64Array): number => {
    multiply(f, p, n, tmp1);
    multiply(tmp1, overlap, n, tmp2);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) tmp1[i * n + j] = tmp2[i * n + j] - tmp2[j * n + i];
    }
    multiply(x, tmp1, n, tmp2);
    multiply(tmp2, x, n, error);
    let largest = 0;
    for (let i = 0; i < n * n; i++) largest = Math.max(largest, Math.abs(error[i]));
    return largest;
  };

  // These are assigned inside the closures below; the casts stop TypeScript from narrowing them to
  // their initial values, which it would otherwise assume to survive the calls.
  let converged = false as boolean;
  let cancelled = false as boolean;
  let failure = null as string | null;
  let previousEnergy = 0;
  let firstRms = 0;
  let progress = 0;

  /** Iterates from the current `density` until convergence, cancellation, failure or the iteration limit. */
  const iterate = (): void => {
    const diis = new Diis(8);
    converged = false;
    while (iterations.length < maxIterations) {
      if (options.isCancelled?.()) {
        cancelled = true;
        return;
      }
      const iteration = iterations.length + 1;
      const energy = energyOf(density);
      for (let i = 0; i < n * n; i++) fock[i] = core[i] + twoElectron[i];
      if (!Number.isFinite(energy)) {
        failure = `The SCF energy became non-finite in iteration ${iteration}.`;
        return;
      }
      const diisError = commutator(fock, density);
      diis.push(fock, error);
      const useFock = diis.extrapolate(extrapolated) ? extrapolated : fock;
      diagonalise(useFock);
      buildDensity(coefficients, nextDensity);

      let sumSquares = 0;
      for (let i = 0; i < n * n; i++) {
        const d = nextDensity[i] - density[i];
        sumSquares += d * d;
      }
      const rmsDensityChange = Math.sqrt(sumSquares / (n * n));
      const deltaEnergy = energy - previousEnergy;
      previousEnergy = energy;
      const swap = density;
      density = nextDensity;
      nextDensity = swap;

      const record: ScfIteration = { iteration, energy, deltaEnergy, rmsDensityChange, diisError };
      iterations.push(record);
      options.onIteration?.(record);

      if (iteration === 1) firstRms = rmsDensityChange;
      if (options.onPhase) {
        // Progress on a logarithmic scale between the first density change and the tolerance.
        const span = Math.log(firstRms / densityTolerance);
        const done = span > 0 && rmsDensityChange > 0 ? Math.log(firstRms / rmsDensityChange) / span : 1;
        progress = Math.max(progress, Math.min(0.99, Math.max(0, done)));
        options.onPhase('scf', progress);
      }

      if (Math.abs(deltaEnergy) < energyTolerance && rmsDensityChange < densityTolerance) {
        converged = true;
        return;
      }
    }
  };

  /**
   * Rotates the occupied orbitals into the virtual space along `kappa` ([i * nVirt + a], unit
   * norm) and leaves the lowest-energy density found along that path in `density`. With the
   * singular value decomposition kappa = sum_k s_k u_k w_k^T, occupied combination u_k is mixed
   * with virtual combination w_k by the angle phi s_k / s_max, an exact orthogonal rotation.
   * Returns false when no point on the path is lower in energy than `reference`.
   */
  const leaveSaddlePoint = (kappa: Float64Array, reference: number): boolean => {
    const nVirt = n - nOcc;
    const gram = new Float64Array(nOcc * nOcc);
    for (let i = 0; i < nOcc; i++) {
      for (let j = 0; j <= i; j++) {
        let sum = 0;
        for (let a = 0; a < nVirt; a++) sum += kappa[i * nVirt + a] * kappa[j * nVirt + a];
        gram[i * nOcc + j] = sum;
        gram[j * nOcc + i] = sum;
      }
    }
    const svd = symmetricEigen(gram, nOcc);
    const largest = Math.sqrt(Math.max(svd.values[nOcc - 1], 0));
    if (!(largest > 0)) return false;

    const occupied = new Float64Array(n * nOcc);
    const partner = new Float64Array(n * nOcc);
    const singular = new Float64Array(nOcc);
    const w = new Float64Array(nVirt);
    for (let k = 0; k < nOcc; k++) {
      const s = Math.sqrt(Math.max(svd.values[k], 0));
      for (let mu = 0; mu < n; mu++) {
        let sum = 0;
        for (let i = 0; i < nOcc; i++) sum += coefficients[mu * n + i] * svd.vectors[i * nOcc + k];
        occupied[mu * nOcc + k] = sum;
      }
      if (s < 1e-8 * largest) continue;
      singular[k] = s;
      for (let a = 0; a < nVirt; a++) {
        let sum = 0;
        for (let i = 0; i < nOcc; i++) sum += kappa[i * nVirt + a] * svd.vectors[i * nOcc + k];
        w[a] = sum / s;
      }
      for (let mu = 0; mu < n; mu++) {
        let sum = 0;
        for (let a = 0; a < nVirt; a++) sum += coefficients[mu * n + nOcc + a] * w[a];
        partner[mu * nOcc + k] = sum;
      }
    }

    const rotated = new Float64Array(n * n);
    const trial = new Float64Array(n * n);
    const best = new Float64Array(n * n);
    let bestEnergy = reference;
    for (const angle of FOLLOW_ANGLES) {
      for (let k = 0; k < nOcc; k++) {
        const phi = (angle * singular[k]) / largest;
        const cos = Math.cos(phi);
        const sin = Math.sin(phi);
        for (let mu = 0; mu < n; mu++) rotated[mu * n + k] = cos * occupied[mu * nOcc + k] + sin * partner[mu * nOcc + k];
      }
      buildDensity(rotated, trial);
      const energy = energyOf(trial);
      if (energy < bestEnergy) {
        bestEnergy = energy;
        best.set(trial);
      }
    }
    if (!(bestEnergy < reference - 1e-8)) return false;
    density.set(best);
    return true;
  };

  // ---- core-Hamiltonian guess, SCF iterations, stability ---------------------------------------
  options.onPhase?.('scf', 0);
  diagonalise(core);
  buildDensity(coefficients, density);
  iterate();

  let stabilityVerified = false;
  let lowestEigenvalue: number | null = null;
  let lowestEigenvalueIsExact = false;
  let saddlePointsLeft = 0;
  let hessianProducts = 0;
  while (converged && !cancelled && !failure) {
    if (nOcc === n) {
      // No virtual orbitals, hence no orbital rotations: trivially stable.
      stabilityVerified = true;
      break;
    }
    const analysis = lowestRotationEigenpair(
      { n, nOcc, coefficients, orbitalEnergies, eri: eri.values },
      { ...settings.stability, instabilityThreshold: INSTABILITY_THRESHOLD, isCancelled: options.isCancelled },
    );
    hessianProducts += analysis.products;
    if (analysis.cancelled) {
      cancelled = true;
      break;
    }
    lowestEigenvalue = analysis.lowestEigenvalue;
    lowestEigenvalueIsExact = analysis.method === 'exact';
    if (!(analysis.lowestEigenvalue < -INSTABILITY_THRESHOLD)) {
      stabilityVerified = analysis.converged;
      if (!analysis.converged) {
        warnings.push('The stability analysis of the SCF solution did not converge, so it could not be confirmed that the solution is an energy minimum.');
      }
      break;
    }
    const saddleEnergy = previousEnergy;
    const saddleDensity = Float64Array.from(density);
    const unstable = `The SCF solution is a saddle point of the energy (an orbital-rotation eigenvalue of ${analysis.lowestEigenvalue.toFixed(5)} hartree); a lower-energy closed-shell solution exists`;
    if (saddlePointsLeft === maxInstabilityFollows || iterations.length >= maxIterations || !leaveSaddlePoint(analysis.vector, saddleEnergy)) {
      warnings.push(`${unstable} but could not be reached. The returned values belong to the saddle point.`);
      break;
    }
    saddlePointsLeft++;
    const iterationsBefore = iterations.length;
    iterate();
    if (iterations.length === iterationsBefore) {
      // Cancelled before the first iteration from the rotated density: the orbitals still belong
      // to the saddle point, so return that (consistent) solution.
      density.set(saddleDensity);
      break;
    }
    if (converged && !(previousEnergy < saddleEnergy - 1e-8)) {
      warnings.push(`${unstable}, but the SCF returned to a solution that is not lower in energy.`);
      break;
    }
  }

  // ---- final energies and orbital energies for the returned density ----------------------------
  buildTwoElectronFock(eri.values, density, n, twoElectron, tmp1);
  for (let i = 0; i < n * n; i++) fock[i] = core[i] + twoElectron[i];
  const kineticEnergy = dot(density, kinetic);
  const attractionEnergy = dot(density, nuclearAttraction);
  const twoElectronEnergy = 0.5 * dot(density, twoElectron);
  const electronic = kineticEnergy + attractionEnergy + twoElectronEnergy;
  const residual = commutator(fock, density);

  // Orbital energies as expectation values of the final Fock operator. They agree with its
  // eigenvalues to second order in the residual and are exactly consistent with the returned
  // orbitals and density.
  multiply(fock, coefficients, n, tmp1);
  const expectation = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let mu = 0; mu < n; mu++) sum += coefficients[mu * n + i] * tmp1[mu * n + i];
    expectation[i] = sum;
  }
  // Keep each block (occupied, virtual) in ascending order without mixing the two.
  const order = [
    ...Array.from({ length: nOcc }, (_, i) => i).sort((i, j) => expectation[i] - expectation[j] || i - j),
    ...Array.from({ length: n - nOcc }, (_, i) => i + nOcc).sort((i, j) => expectation[i] - expectation[j] || i - j),
  ];
  const finalEnergies = new Float64Array(n);
  const finalCoefficients = new Float64Array(n * n);
  for (let k = 0; k < n; k++) {
    const source = order[k];
    finalEnergies[k] = expectation[source];
    // Phase convention: the largest coefficient of every orbital is positive.
    let largest = 0;
    for (let mu = 0; mu < n; mu++) largest = Math.max(largest, Math.abs(coefficients[mu * n + source]));
    let sign = 1;
    for (let mu = 0; mu < n; mu++) {
      const c = coefficients[mu * n + source];
      if (Math.abs(c) >= largest * (1 - 1e-6)) {
        sign = c < 0 ? -1 : 1;
        break;
      }
    }
    for (let mu = 0; mu < n; mu++) finalCoefficients[mu * n + k] = sign * coefficients[mu * n + source];
  }
  const scfDone = now();
  options.onPhase?.('scf', 1);

  // ---- warnings ---------------------------------------------------------------------------------
  const last = iterations[iterations.length - 1];
  if (failure) {
    warnings.push(`${failure} The returned values are not reliable.`);
  } else if (cancelled) {
    warnings.push(
      `The calculation was cancelled after ${iterations.length} SCF iteration${iterations.length === 1 ? '' : 's'}; energies, orbitals and properties belong to an unconverged density.`,
    );
  } else if (!converged) {
    warnings.push(
      `The SCF did not converge within ${maxIterations} iterations (last energy change ${last.deltaEnergy.toExponential(2)} hartree, RMS density change ${last.rmsDensityChange.toExponential(2)}); energies, orbitals and properties are those of the last iteration and are not reliable.`,
    );
  }
  if (nOcc < n && finalEnergies[nOcc] - finalEnergies[nOcc - 1] < SMALL_GAP_WARNING) {
    warnings.push(
      `The HOMO-LUMO gap is ${(finalEnergies[nOcc] - finalEnergies[nOcc - 1]).toExponential(2)} hartree; a closed-shell description is questionable for this system.`,
    );
  }

  // ---- properties -------------------------------------------------------------------------------
  options.onPhase?.('properties', 0);
  const populations = new Float64Array(nuclei.length);
  for (let mu = 0; mu < n; mu++) {
    let gross = 0;
    for (let nu = 0; nu < n; nu++) gross += density[mu * n + nu] * overlap[nu * n + mu];
    populations[basis.atomOfFunction[mu]] += gross;
  }
  const mullikenCharges = nuclei.map((nucleus, index) => nucleus.charge - populations[index]);

  const dipole: [number, number, number] = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    let nuclearPart = 0;
    for (const nucleus of nuclei) nuclearPart += nucleus.charge * ((axis === 0 ? nucleus.x : axis === 1 ? nucleus.y : nucleus.z) - origin[axis]);
    dipole[axis] = nuclearPart - dot(density, dipoleIntegrals[axis]);
  }
  options.onPhase?.('properties', 1);

  const end = now();
  return {
    converged,
    cancelled,
    empty: false,
    iterations,
    nOccupied: nOcc,
    energy: {
      total: electronic + nuclearRepulsion,
      electronic,
      nuclearRepulsion,
      kinetic: kineticEnergy,
      nuclearAttraction: attractionEnergy,
      twoElectron: twoElectronEnergy,
    },
    orbitalEnergies: finalEnergies,
    orbitalCoefficients: finalCoefficients,
    densityMatrix: density,
    overlapMatrix: overlap,
    mullikenCharges,
    dipole,
    dipoleOrigin: origin,
    residual,
    smallestOverlapEigenvalue,
    stability: { verified: stabilityVerified, lowestEigenvalue, lowestEigenvalueIsExact, saddlePointsLeft, hessianProducts },
    integralStatistics,
    timings: { integralsMs: integralsDone - start, scfMs: scfDone - integralsDone, totalMs: end - start },
    warnings,
  };
}
