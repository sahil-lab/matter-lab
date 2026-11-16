import type { Provenance } from '@matterlab/core';

/** One atom of the molecule to optimise. All hydrogens must be present as atoms. */
export interface FfAtom {
  /** Atomic number. */
  readonly z: number;
  /** Integer formal charge, in units of the elementary charge. */
  readonly formalCharge: number;
  /** angstrom */
  readonly position: readonly [number, number, number];
}

/**
 * A covalent bond between atoms `a` and `b` (indices into `FfMolecule.atoms`). An order of 1.5 means
 * "aromatic exactly as RDKit reports it after sanitisation"; this package does not perceive
 * aromaticity itself.
 */
export interface FfBond {
  readonly a: number;
  readonly b: number;
  readonly order: 1 | 1.5 | 2 | 3;
}

export interface FfMolecule {
  readonly atoms: readonly FfAtom[];
  readonly bonds: readonly FfBond[];
}

/** kcal/mol */
export interface UffEnergyTerms {
  readonly bondStretch: number;
  readonly angleBend: number;
  readonly torsion: number;
  readonly inversion: number;
  readonly vanDerWaals: number;
  readonly total: number;
}

/**
 * A force field built for one molecule. The object returned by `createUffSystem` is plain data
 * (numbers, strings, arrays and typed arrays), so it survives `structuredClone` / `postMessage`.
 */
export interface UffSystem {
  readonly nAtoms: number;
  /** UFF labels, e.g. 'C_3', 'O_R' */
  readonly atomTypes: readonly string[];
  /**
   * Number of terms of each kind. `vdwPairs` counts the atom pairs that can interact (same fragment,
   * neither bonded nor sharing a neighbour); a pair further apart than 10 x_ij contributes nothing.
   */
  readonly termCounts: {
    readonly bonds: number;
    readonly angles: number;
    readonly torsions: number;
    readonly inversions: number;
    readonly vdwPairs: number;
  };
}

export interface OptimizeStep {
  /** 0 for the starting geometry, then 1, 2, ... */
  readonly step: number;
  /** kcal/mol */
  readonly energy: number;
  /** RMS of the Cartesian gradient components of the atoms that are free to move, kcal/mol/angstrom. */
  readonly rmsGradient: number;
  /** Largest absolute Cartesian gradient component of the atoms that are free to move, kcal/mol/angstrom. */
  readonly maxGradient: number;
  /** live view; copy it if you keep it */
  readonly positions: Float64Array;
}

export interface OptimizeOptions {
  /**
   * Maximum number of steps. Default 2000. Steps of the pre-relaxation that untangles an unusable
   * starting geometry count as steps.
   */
  readonly maxSteps?: number;
  /** RMS gradient over the atoms that are free to move, kcal/mol/angstrom. Default 1e-4. */
  readonly gradientTolerance?: number;
  /** kcal/mol between steps. Default 1e-6. */
  readonly energyTolerance?: number;
  /** Indices of atoms that must not move. */
  readonly frozenAtoms?: readonly number[];
  /** Record a frame every this many steps (plus the first and the last). 0/undefined = no trajectory. */
  readonly recordTrajectoryEvery?: number;
  /** Called once for the starting geometry (step 0) and then after every step. Return false to cancel. */
  readonly onStep?: (step: OptimizeStep) => boolean | void;
}

export interface OptimizeResult {
  readonly method: 'UFF';
  /**
   * True only if both convergence criteria were met and the final geometry is a minimum rather
   * than a saddle point. False when the step limit was hit or the run was cancelled; `warnings`
   * then says why.
   */
  readonly converged: boolean;
  readonly cancelled: boolean;
  readonly steps: number;
  /**
   * kcal/mol, at the geometry as given. If the energy is undefined there (coincident atoms), this is
   * the energy of the repaired starting geometry, and a warning says so.
   */
  readonly initialEnergy: number;
  /** kcal/mol */
  readonly finalEnergy: number;
  readonly energyTerms: UffEnergyTerms;
  /** kcal/mol/angstrom, over the atoms that are free to move. */
  readonly rmsGradient: number;
  /** kcal/mol/angstrom, over the atoms that are free to move. */
  readonly maxGradient: number;
  /** Final coordinates as xyz triples, angstrom. */
  readonly positions: Float64Array;
  /** RMS atomic displacement from the starting geometry, angstrom (no alignment) */
  readonly rmsDisplacement: number;
  readonly trajectory: readonly Float32Array[];
  readonly atomTypes: readonly string[];
  readonly warnings: readonly string[];
  readonly elapsedMs: number;
  /** 'UFF as implemented in RDKit <version>, ported to TypeScript', with literature citations */
  readonly provenance: Provenance;
}
