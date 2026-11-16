import { createUffSystem, optimizeUff, uffEnergy, uffSystemWarnings } from '@matterlab/forcefield';
import type { FfMolecule, OptimizeResult, UffEnergyTerms } from '@matterlab/forcefield';
import { serve } from '../science/rpc';

export interface OptimizeProgress {
  readonly step: number;
  /** kcal/mol */
  readonly energy: number;
  /** kcal/mol/angstrom */
  readonly rmsGradient: number;
}

export interface OptimizeRequest {
  readonly molecule: FfMolecule;
  readonly maxSteps?: number;
  /** Record a frame of the optimiser's path every this many steps; 0 records none. */
  readonly recordTrajectoryEvery?: number;
  readonly frozenAtoms?: readonly number[];
}

export interface SinglePoint {
  readonly energy: UffEnergyTerms;
  readonly atomTypes: readonly string[];
  readonly warnings: readonly string[];
}

/** The energy at steps of the optimiser's path, for a graph: at most `ENERGY_PATH_POINTS` of them, first and last included. */
export interface EnergyPath {
  readonly steps: readonly number[];
  /** kcal/mol */
  readonly energies: readonly number[];
}

export type OptimizeReply = OptimizeResult & { readonly energyPath: EnergyPath };

const ENERGY_PATH_POINTS = 400;

function thinned(steps: readonly number[], energies: readonly number[]): EnergyPath {
  const n = steps.length;
  if (n <= ENERGY_PATH_POINTS) return { steps, energies };
  const pick = Array.from({ length: ENERGY_PATH_POINTS }, (_, i) => Math.round((i * (n - 1)) / (ENERGY_PATH_POINTS - 1)));
  return { steps: pick.map((i) => steps[i]!), energies: pick.map((i) => energies[i]!) };
}

/**
 * The Universal Force Field in its own thread. An optimisation can take seconds for a few hundred
 * atoms; here it can never hold up the view, and cancelling simply ends the thread.
 */
const methods = {
  optimize(request: OptimizeRequest, progress: (value: OptimizeProgress) => void): OptimizeReply {
    let lastReport = 0;
    const steps: number[] = [];
    const energies: number[] = [];
    const result = optimizeUff(request.molecule, {
      ...(request.maxSteps !== undefined ? { maxSteps: request.maxSteps } : {}),
      ...(request.recordTrajectoryEvery ? { recordTrajectoryEvery: request.recordTrajectoryEvery } : {}),
      ...(request.frozenAtoms ? { frozenAtoms: request.frozenAtoms } : {}),
      onStep(step) {
        steps.push(step.step);
        energies.push(step.energy);
        const now = performance.now();
        if (now - lastReport > 40) {
          lastReport = now;
          progress({ step: step.step, energy: step.energy, rmsGradient: step.rmsGradient });
        }
      },
    });
    return { ...result, energyPath: thinned(steps, energies) };
  },

  /** Energy of a structure as it stands, by term, without moving anything. */
  energy({ molecule }: { molecule: FfMolecule }): SinglePoint {
    const system = createUffSystem(molecule);
    const positions = new Float64Array(molecule.atoms.length * 3);
    molecule.atoms.forEach((atom, i) => positions.set(atom.position, 3 * i));
    return { energy: uffEnergy(system, positions), atomTypes: system.atomTypes, warnings: uffSystemWarnings(system) };
  },
};

export type ForcefieldMethods = typeof methods;

serve(methods);
