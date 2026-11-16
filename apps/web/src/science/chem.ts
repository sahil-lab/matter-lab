import { sortedAtoms, sortedBonds, toMolfile } from '@matterlab/core';
import type { AtomId, BondId, Scene } from '@matterlab/core';
import { create } from 'zustand';
import { lab } from '../state/store';
import type { ChemAnalysis, RdkitMethods, SearchEntry, SearchResult, SmilesResult, StereoTags } from '../workers/rdkit.worker';
import { WorkerClient } from './rpc';

/** Above this size the automatic cross-check is skipped; RDKit would still work, but not at editing speed. */
export const CHEM_ATOM_LIMIT = 1500;

const client = new WorkerClient<RdkitMethods>(
  () => new Worker(new URL('../workers/rdkit.worker.ts', import.meta.url), { type: 'module', name: 'matterlab-rdkit' }),
  'RDKit',
);

/** RDKit's reading of a scene, with its findings mapped back to the scene's own atom and bond ids. */
export interface SceneChemistry extends ChemAnalysis {
  readonly aromaticAtomIds: ReadonlySet<AtomId>;
  readonly aromaticBondIds: ReadonlySet<BondId>;
  readonly radicalAtomIds: ReadonlyMap<AtomId, number>;
}

/**
 * RDKit's reading of a scene. `flat` says the coordinates are those of a flat drawing rather than a
 * geometry, so that no stereochemistry is read from them.
 */
export async function analyseScene(scene: Scene, identifiers = true, flat = false): Promise<SceneChemistry> {
  const atoms = sortedAtoms(scene);
  const bonds = sortedBonds(scene);
  const analysis = await client.call('analyse', { molblock: toMolfile(scene, flat ? { dimensions: 2 } : {}), identifiers });
  return {
    ...analysis,
    aromaticAtomIds: new Set(analysis.aromaticAtoms.map((i) => atoms[i]!.id)),
    aromaticBondIds: new Set(analysis.aromaticBonds.map((i) => bonds[i]!.id)),
    radicalAtomIds: new Map(analysis.radicals.map((r) => [atoms[r.atom]!.id, r.electrons])),
  };
}

/** Reads a SMILES string. Structures of more than `maxAtoms` atoms, hydrogens included, are read but not drawn. */
export function smilesToMolblock(smiles: string, maxAtoms?: number): Promise<SmilesResult> {
  return client.call('fromSmiles', { smiles, ...(maxAtoms !== undefined ? { maxAtoms } : {}) });
}

/** The configurations RDKit reads from the geometry of a scene; atom indices follow `sortedAtoms`. */
export function sceneStereo(scene: Scene): Promise<StereoTags | null> {
  return client.call('stereo', { molblock: toMolfile(scene) });
}

export function depictSmiles(smiles: string, width: number, height: number): Promise<string | null> {
  return client.call('depict', { smiles, width, height });
}

export function searchStructures(mode: 'substructure' | 'similarity', query: string, library: readonly SearchEntry[], threshold?: number): Promise<SearchResult> {
  return client.call('search', { mode, query, library, threshold });
}

export function rdkitVersion(): Promise<string> {
  return client.call('version', undefined);
}

export type ChemStatus = 'idle' | 'pending' | 'ready' | 'too-large' | 'unavailable';

interface ChemState {
  /** The scene the analysis below belongs to. */
  readonly scene: Scene | null;
  readonly status: ChemStatus;
  readonly analysis: SceneChemistry | null;
  /** Why RDKit could not be used at all (for example the WebAssembly module failed to load). */
  readonly problem: string | null;
}

/** RDKit's cross-check of the scene being edited, kept up to date in the background. */
export const useChem = create<ChemState>()(() => ({ scene: null, status: 'idle', analysis: null, problem: null }));

/** The analysis of exactly this scene, or `null` while it is still being worked out. */
export function chemistryOf(state: ChemState, scene: Scene): SceneChemistry | null {
  return state.scene === scene && state.status === 'ready' ? state.analysis : null;
}

const DEBOUNCE_MS = 260;
let timer: number | undefined;
let running = false;
let dirty = false;

async function refresh(): Promise<void> {
  if (running) {
    dirty = true;
    return;
  }
  // Only the Architect's document is cross-checked; other workspaces show finished results.
  if (lab.get().workspace !== 'architect') return;
  const scene = lab.get().scene;
  const current = useChem.getState();
  if (current.scene === scene && current.status !== 'pending') return;
  if (scene.atoms.size === 0) {
    useChem.setState({ scene, status: 'idle', analysis: null, problem: null });
    return;
  }
  if (scene.atoms.size > CHEM_ATOM_LIMIT) {
    useChem.setState({ scene, status: 'too-large', analysis: null, problem: null });
    return;
  }
  running = true;
  try {
    const analysis = await analyseScene(scene);
    if (lab.get().scene === scene) useChem.setState({ scene, status: 'ready', analysis, problem: null });
    else dirty = true;
  } catch (error) {
    useChem.setState({ scene, status: 'unavailable', analysis: null, problem: error instanceof Error ? error.message : String(error) });
  } finally {
    running = false;
    if (dirty) {
      dirty = false;
      schedule();
    }
  }
}

function schedule(): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void refresh(), DEBOUNCE_MS);
}

/** Starts keeping `useChem` in step with the edited scene. Returns a function that stops it. */
export function startChemistryWatch(): () => void {
  const unsubscribe = lab.subscribe(
    (s) => s.scene,
    () => {
      const state = useChem.getState();
      if (state.status === 'ready' || state.status === 'idle') useChem.setState({ status: 'pending' });
      schedule();
    },
  );
  useChem.setState({ status: 'pending' });
  schedule();
  return () => {
    unsubscribe();
    window.clearTimeout(timer);
  };
}
