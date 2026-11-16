import type { Provenance } from '@matterlab/core';

/** One nucleus of the system to be computed. */
export interface QmAtom {
  /** Atomic number (number of protons). */
  readonly z: number;
  /** Cartesian position in angstrom. */
  readonly position: readonly [number, number, number];
}

export interface QmInput {
  readonly atoms: readonly QmAtom[];
  /** Net charge in units of the elementary charge e (so the electron count is sum(Z) - charge). */
  readonly charge: number;
}

export interface SupportOptions {
  /** Largest number of basis functions the engine will accept. Default 96. */
  readonly maxBasisFunctions?: number;
}

export interface SupportReport {
  readonly supported: boolean;
  /** Human-readable reasons why the system cannot be computed; empty when `supported` is true. */
  readonly reasons: readonly string[];
  /**
   * Number of STO-3G basis functions. Atoms without a basis set in this engine (invalid or
   * unsupported atomic numbers) contribute nothing, and a reason is given for each of them.
   */
  readonly nBasis: number;
  /** sum(Z) - charge. May be negative, odd or non-integer for unsupported input. */
  readonly nElectrons: number;
  /**
   * Rough single-thread wall-clock estimate in seconds for `runRhf`, from a cost model calibrated by
   * measurement (see README). `NaN` when no estimate can be made because a basis set could not be
   * assigned to every atom.
   */
  readonly estimatedSeconds: number;
}

export interface ScfIteration {
  /** 1-based iteration number. */
  readonly iteration: number;
  /** Total energy (electronic + nuclear repulsion) in hartree of the density entering this iteration. */
  readonly energy: number;
  /**
   * Change of `energy` relative to the previous iteration, in hartree. For the first iteration the
   * previous energy is taken as zero, so it equals `energy`.
   */
  readonly deltaEnergy: number;
  /** Root-mean-square change of the density-matrix elements produced by this iteration. */
  readonly rmsDensityChange: number;
  /** Largest absolute element of the DIIS error matrix X^T (FPS - SPF) X, in hartree. */
  readonly diisError: number;
}

export interface ScfOptions {
  /** Default 100. Counts all iterations, including those after leaving a saddle point. */
  readonly maxIterations?: number;
  /** Convergence threshold on the energy change between iterations, in hartree. Default 1e-9. */
  readonly energyTolerance?: number;
  /** Convergence threshold on the RMS change of the density matrix. Default 1e-7. */
  readonly densityTolerance?: number;
  /** Largest number of basis functions accepted. Default 96. */
  readonly maxBasisFunctions?: number;
  /** Called with the phase being worked on and the fraction of that phase completed (0..1). */
  readonly onPhase?: (phase: 'integrals' | 'scf' | 'properties', fraction: number) => void;
  /** Called once per completed SCF iteration. */
  readonly onIteration?: (it: ScfIteration) => void;
  /**
   * Polled between integral batches, between SCF iterations and during the stability analysis;
   * return true to stop early. The calculation is synchronous, so the answer has to come from
   * something that can change meanwhile: a flag in a SharedArrayBuffer, or a deadline.
   */
  readonly isCancelled?: () => boolean;
}

export interface BasisFunctionInfo {
  /** Position of this function in every matrix of the result. */
  readonly index: number;
  /** Index into `QmInput.atoms` of the atom the function is centred on. */
  readonly atomIndex: number;
  /** '1s', '2s', '2px', '2py', '2pz', '3s', '3px', ... */
  readonly shell: string;
  /** Element symbol, 1-based atom number and shell, e.g. 'O1 2px'. */
  readonly label: string;
}

export interface ScfResult {
  readonly method: 'RHF';
  readonly basisSet: 'STO-3G';
  /** True only when both the energy and the density criterion were met. */
  readonly converged: boolean;
  /**
   * True when `isCancelled` stopped the run. A cancelled result is never converged; quantities that
   * had not been computed yet are NaN (see `warnings`).
   */
  readonly cancelled: boolean;
  /**
   * One record per SCF iteration. When the first converged solution turns out to be a saddle point
   * of the energy, the calculation leaves it and continues, so the history can show an energy
   * plateau followed by a drop to the final, lower solution.
   */
  readonly iterations: readonly ScfIteration[];
  readonly nBasis: number;
  readonly nElectrons: number;
  /** Number of doubly occupied molecular orbitals. */
  readonly nOccupied: number;
  /** All energies in hartree. */
  readonly energy: {
    /** electronic + nuclearRepulsion. */
    readonly total: number;
    /** kinetic + nuclearAttraction + twoElectron. */
    readonly electronic: number;
    readonly nuclearRepulsion: number;
    readonly kinetic: number;
    readonly nuclearAttraction: number;
    readonly twoElectron: number;
  };
  /** Orbital energies in hartree, ascending, length nBasis. */
  readonly orbitalEnergies: Float64Array;
  /** Row-major nBasis x nBasis; element [mu * nBasis + i] is the coefficient of AO mu in MO i. */
  readonly orbitalCoefficients: Float64Array;
  /** Closed-shell density matrix P = 2 C_occ C_occ^T, row-major nBasis x nBasis. */
  readonly densityMatrix: Float64Array;
  /** AO overlap matrix S, row-major nBasis x nBasis. */
  readonly overlapMatrix: Float64Array;
  readonly basisFunctions: readonly BasisFunctionInfo[];
  /** Index of the highest occupied molecular orbital. */
  readonly homoIndex: number;
  /** Index of the lowest unoccupied molecular orbital, or null when every orbital is occupied. */
  readonly lumoIndex: number | null;
  /** Mulliken net atomic charges in units of e, one per atom of the input. */
  readonly mullikenCharges: readonly number[];
  readonly dipole: {
    /** Dipole moment in atomic units (e a0). */
    readonly au: readonly [number, number, number];
    /** Dipole moment in debye. */
    readonly debye: readonly [number, number, number];
    readonly magnitudeDebye: number;
    /**
     * True for charged systems, whose dipole depends on the origin. The origin used is the centre of
     * nuclear charge, sum(Z_A R_A) / sum(Z_A).
     */
    readonly originDependent: boolean;
  };
  /** Wall-clock times in milliseconds. */
  readonly timings: { readonly integralsMs: number; readonly scfMs: number; readonly totalMs: number };
  /** Anything the caller should know before trusting the numbers (non-convergence, cancellation, ...). */
  readonly warnings: readonly string[];
  /** Engine name and version, basis-set source and literature citations. */
  readonly provenance: Provenance;
}

/** A regular, axis-aligned grid of sample points. */
export interface GridSpec {
  /** Position of the first sample point, in angstrom. */
  readonly origin: readonly [number, number, number];
  /** Distance between neighbouring sample points along x, y and z, in angstrom. */
  readonly spacing: readonly [number, number, number];
  /**
   * Number of sample points along x, y and z. The value of point (ix, iy, iz) is stored at index
   * ix + dims[0] * (iy + dims[1] * iz), and the point lies at
   * origin + (ix * spacing[0], iy * spacing[1], iz * spacing[2]).
   */
  readonly dims: readonly [number, number, number];
}

/** An indexed triangle mesh. */
export interface IsoMesh {
  /** Vertex positions, xyz triples in the units of the grid (angstrom for grids from `createGrid`). */
  readonly positions: Float32Array;
  /** Unit vertex normals, xyz triples, pointing away from the enclosed region. */
  readonly normals: Float32Array;
  /** Vertex indices, three per triangle, counter-clockwise when seen from outside. */
  readonly indices: Uint32Array;
}
