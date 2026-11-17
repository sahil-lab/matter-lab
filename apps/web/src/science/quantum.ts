import { atomCharge, getElement, sortedAtoms } from '@matterlab/core';
import type { AtomId, Scene } from '@matterlab/core';
import { DEFAULT_MAX_BASIS_FUNCTIONS, checkSupport } from '@matterlab/quantum';
import type { QmInput, ScfResult, SupportReport } from '@matterlab/quantum';
import type {
  CloudRequest,
  CloudResponse,
  EspSurfaceRequest,
  EspSurfaceResponse,
  FieldProgress,
  MolecularSurfaceRequest,
  MolecularSurfaceResponse,
  QuantumMethods,
  ScfProgress,
  SliceRequest,
  SliceResponse,
  SurfaceRequest,
  SurfaceResponse,
  VolumeRequest,
  VolumeResponse,
} from '../workers/quantum.worker';
import { WorkerClient, WorkerError } from './rpc';
import type { CallOptions } from './rpc';

const spawn = () => new Worker(new URL('../workers/quantum.worker.ts', import.meta.url), { type: 'module', name: 'matterlab-quantum' });

// Two threads: a long self-consistent-field run must not keep a surface or a slice waiting.
const scfClient = new WorkerClient<QuantumMethods>(spawn, 'quantum chemistry');
const fieldClient = new WorkerClient<QuantumMethods>(spawn, 'field');

/** A scene as the quantum engine sees it. */
export interface QuantumSystem {
  readonly input: QmInput;
  /** Scene atom behind each atom of `input`. */
  readonly atomIds: readonly AtomId[];
}

/** Nuclei at the scene's positions and the net charge that follows from the atoms' electron counts. */
export function quantumSystem(scene: Scene): QuantumSystem {
  const atoms = sortedAtoms(scene);
  let charge = 0;
  for (const atom of atoms) charge += atomCharge(atom);
  return {
    input: { atoms: atoms.map((atom) => ({ z: atom.protons, position: [atom.position[0], atom.position[1], atom.position[2]] as const })), charge },
    atomIds: atoms.map((atom) => atom.id),
  };
}

export interface QuantumSupport extends SupportReport {
  /** The engine's reasons, with its atom numbers replaced by the names the interface uses. */
  readonly reasons: readonly string[];
  /** Atoms of elements the engine has no basis set for. */
  readonly unsupportedAtoms: readonly AtomId[];
}

/** The engine numbers atoms from 1 in input order; the interface names them by element and scene id. */
function withAtomNames(reason: string, name: (index: number) => string): string {
  return reason
    .replace(/(\d+) and (\d+) \(([\d.]+) A\)/g, (_, a: string, b: string, distance: string) => `${name(Number(a) - 1)} and ${name(Number(b) - 1)} (${distance} Å)`)
    .replace(/\batoms? (\d+(?:, \d+)*)/g, (_, list: string) =>
      list
        .split(', ')
        .map((n) => name(Number(n) - 1))
        .join(', '),
    );
}

/** Whether the engine can treat the scene, and if not, why. Cheap enough to ask on every edit. */
export function quantumSupport(scene: Scene, system: QuantumSystem = quantumSystem(scene)): QuantumSupport {
  const report = checkSupport(system.input, { maxBasisFunctions: DEFAULT_MAX_BASIS_FUNCTIONS });
  const name = (index: number): string => {
    const id = system.atomIds[index];
    const atom = id === undefined ? undefined : scene.atoms.get(id);
    return atom ? `${getElement(atom.protons).symbol}${id}` : `atom ${index + 1}`;
  };
  return {
    ...report,
    reasons: report.reasons.map((reason) => withAtomNames(reason, name)),
    unsupportedAtoms: system.atomIds.filter((id) => scene.atoms.get(id)!.protons > 18),
  };
}

/** The engine refused the system; `reasons` say why. */
export class UnsupportedSystem extends Error {
  constructor(readonly reasons: readonly string[]) {
    super(reasons[0] ?? 'The quantum engine cannot treat this system.');
    this.name = 'UnsupportedSystem';
  }
}

/** Runs restricted Hartree-Fock with the STO-3G basis in the background. */
export async function runScf(input: QmInput, options: CallOptions<ScfProgress> = {}): Promise<ScfResult> {
  try {
    return await scfClient.call('scf', { input }, options);
  } catch (error) {
    if (error instanceof WorkerError && error.name === 'UnsupportedSystemError') {
      throw new UnsupportedSystem((error.data as { reasons?: string[] } | undefined)?.reasons ?? [error.message]);
    }
    throw error;
  }
}

/** Fields derived from a wavefunction, and geometric molecular surfaces, computed in the background. */
export const fields = {
  surface: (request: SurfaceRequest, options?: CallOptions<FieldProgress>): Promise<SurfaceResponse> => fieldClient.call('surface', request, options),
  espSurface: (request: EspSurfaceRequest, options?: CallOptions<FieldProgress>): Promise<EspSurfaceResponse> => fieldClient.call('espSurface', request, options),
  slice: (request: SliceRequest, options?: CallOptions<FieldProgress>): Promise<SliceResponse> => fieldClient.call('slice', request, options),
  cloud: (request: CloudRequest, options?: CallOptions<FieldProgress>): Promise<CloudResponse> => fieldClient.call('cloud', request, options),
  volume: (request: VolumeRequest, options?: CallOptions<FieldProgress>): Promise<VolumeResponse> => fieldClient.call('volume', request, options),
  molecularSurface: (request: MolecularSurfaceRequest, options?: CallOptions<FieldProgress>): Promise<MolecularSurfaceResponse> =>
    fieldClient.call('molecularSurface', request, options),
};
