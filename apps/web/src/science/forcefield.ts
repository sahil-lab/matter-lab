import { analyseValences, atomCharge, getElement, sortedAtoms, sortedBonds } from '@matterlab/core';
import type { AtomId, Scene, Vec3 } from '@matterlab/core';
import type { FfBond, FfMolecule } from '@matterlab/forcefield';
import type { ForcefieldMethods, OptimizeProgress, OptimizeReply, SinglePoint } from '../workers/forcefield.worker';
import { analyseScene } from './chem';
import { WorkerClient, WorkerError } from './rpc';

const client = new WorkerClient<ForcefieldMethods>(
  () => new Worker(new URL('../workers/forcefield.worker.ts', import.meta.url), { type: 'module', name: 'matterlab-forcefield' }),
  'force-field',
);

/** The structure cannot be treated by the force field; `reasons` name the atoms and why. */
export class UnsupportedStructureError extends Error {
  constructor(
    message: string,
    readonly reasons: readonly string[],
    readonly atomIds: readonly AtomId[] = [],
  ) {
    super(message);
    this.name = 'UnsupportedStructureError';
  }
}

export interface ForceFieldInput {
  readonly molecule: FfMolecule;
  /** Scene atom behind each atom of `molecule`. */
  readonly atomIds: readonly AtomId[];
}

/**
 * Translates a scene into the force field's input. UFF needs to know which bonds are aromatic in
 * RDKit's sense, so RDKit is asked; a structure RDKit rejects cannot be given to UFF at all.
 */
export async function forceFieldInput(scene: Scene): Promise<ForceFieldInput> {
  const chemistry = await analyseScene(scene, false);
  if (!chemistry.ok) {
    throw new UnsupportedStructureError('The structure has to be chemically valid before it can be optimised.', chemistry.errors);
  }
  const atoms = sortedAtoms(scene);
  const index = new Map(atoms.map((atom, i) => [atom.id, i]));
  const kekule = analyseValences(scene).kekule;
  const bonds: FfBond[] = sortedBonds(scene).map((bond) => {
    // Aromatic where RDKit says so; elsewhere the Kekule order, also for bonds that were drawn as aromatic.
    const order = chemistry.aromaticBondIds.has(bond.id) ? 1.5 : bond.order === 1.5 ? (kekule.orders.get(bond.id) ?? 1) : bond.order;
    return { a: index.get(bond.a)!, b: index.get(bond.b)!, order };
  });
  return {
    molecule: { atoms: atoms.map((atom) => ({ z: atom.protons, formalCharge: atomCharge(atom), position: atom.position })), bonds },
    atomIds: atoms.map((atom) => atom.id),
  };
}

function translate(error: unknown, scene: Scene, atomIds: readonly AtomId[]): unknown {
  if (!(error instanceof WorkerError) || error.name !== 'UnsupportedForceFieldError') return error;
  const problems = (error.data as { problems?: Array<{ atomIndex: number; reason: string }> } | undefined)?.problems ?? [];
  const ids = problems.map((p) => atomIds[p.atomIndex]!).filter((id) => id !== undefined);
  const reasons = problems.map((p) => {
    const id = atomIds[p.atomIndex];
    const atom = id === undefined ? undefined : scene.atoms.get(id);
    return `${atom ? `${getElement(atom.protons).symbol} (atom ${id})` : `atom ${p.atomIndex}`}: ${p.reason}`;
  });
  return new UnsupportedStructureError('The Universal Force Field has no parameters for part of this structure.', reasons.length > 0 ? reasons : [error.message], ids);
}

export interface OptimizeOutcome {
  readonly result: OptimizeReply;
  readonly atomIds: readonly AtomId[];
  /** The optimised position of every atom. */
  readonly positions: ReadonlyMap<AtomId, Vec3>;
}

export interface OptimizeSceneOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: OptimizeProgress) => void;
  /** Atoms allowed to move; all of them when omitted. */
  readonly movable?: ReadonlySet<AtomId>;
  readonly maxSteps?: number;
  /** Record the optimiser's path for playback. */
  readonly trajectory?: boolean;
}

/** Optimises the geometry of a scene with UFF, in the background. The scene itself is not changed. */
export async function optimizeScene(scene: Scene, options: OptimizeSceneOptions = {}): Promise<OptimizeOutcome> {
  const { molecule, atomIds } = await forceFieldInput(scene);
  const n = atomIds.length;
  const frozenAtoms = options.movable ? atomIds.flatMap((id, i) => (options.movable!.has(id) ? [] : [i])) : undefined;
  let result: OptimizeReply;
  try {
    result = await client.call(
      'optimize',
      {
        molecule,
        ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
        ...(frozenAtoms && frozenAtoms.length > 0 ? { frozenAtoms } : {}),
        // Enough frames for a smooth replay without keeping thousands of copies of a large structure.
        recordTrajectoryEvery: options.trajectory ? (n <= 80 ? 1 : n <= 300 ? 4 : 12) : 0,
      },
      { signal: options.signal, onProgress: options.onProgress },
    );
  } catch (error) {
    throw translate(error, scene, atomIds);
  }
  const positions = new Map<AtomId, Vec3>();
  atomIds.forEach((id, i) => positions.set(id, [result.positions[3 * i]!, result.positions[3 * i + 1]!, result.positions[3 * i + 2]!]));
  return { result, atomIds, positions };
}

/** The UFF energy of a scene as it stands, by term. */
export async function singlePoint(scene: Scene): Promise<SinglePoint & { readonly atomIds: readonly AtomId[] }> {
  const { molecule, atomIds } = await forceFieldInput(scene);
  try {
    return { ...(await client.call('energy', { molecule })), atomIds };
  } catch (error) {
    throw translate(error, scene, atomIds);
  }
}
