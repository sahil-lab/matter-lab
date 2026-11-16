import { sortedBonds, vdist } from '@matterlab/core';
import type { AtomId, Provenance, Scene, Vec3 } from '@matterlab/core';
import type { UffEnergyTerms } from '@matterlab/forcefield';
import { create } from 'zustand';
import { stageApi } from '../render/viewApi';
import { UnsupportedStructureError, optimizeScene } from '../science/forcefield';
import { cancelJobsOfKind, runJob } from '../science/jobs';
import { JobCancelledError } from '../science/rpc';
import { moveAtoms, notify, selectOnly } from '../state/actions';
import { lab } from '../state/store';
import type { EnergyPath, OptimizeProgress } from '../workers/forcefield.worker';

/** What a finished geometry optimisation found, kept so the result can be inspected and compared. */
export interface OptimizationRecord {
  /** The scene the optimisation started from, and the scene it produced. */
  readonly sceneBefore: Scene;
  readonly sceneAfter: Scene;
  readonly atomIds: readonly AtomId[];
  /** How many atoms were free to move. */
  readonly movable: number;
  readonly converged: boolean;
  readonly steps: number;
  /** kcal/mol */
  readonly initialEnergy: number;
  readonly finalEnergy: number;
  readonly energyTerms: UffEnergyTerms;
  /** kcal/mol/angstrom */
  readonly rmsGradient: number;
  /** angstrom, without alignment */
  readonly rmsDisplacement: number;
  readonly largestMove: { readonly atomId: AtomId; readonly distance: number } | null;
  /** Bonds whose length changed the most, in angstrom. */
  readonly bondChanges: ReadonlyArray<{ readonly a: AtomId; readonly b: AtomId; readonly before: number; readonly after: number }>;
  readonly atomTypes: ReadonlyMap<AtomId, string>;
  readonly warnings: readonly string[];
  readonly elapsedMs: number;
  readonly provenance: Provenance;
  /** The optimiser's path: one frame of xyz triples per recorded step, atoms in `atomIds` order. */
  readonly trajectory: readonly Float32Array[];
  /** The energy along the optimiser's path, for the graph. */
  readonly energyPath: EnergyPath;
}

export interface ComputeProblem {
  readonly title: string;
  readonly details: readonly string[];
  readonly atomIds: readonly AtomId[];
}

interface ComputeState {
  readonly optimizing: boolean;
  readonly progress: OptimizeProgress | null;
  readonly optimization: OptimizationRecord | null;
  readonly problem: ComputeProblem | null;
  /** Draw the starting geometry as a ghost over the optimised one. */
  readonly showOriginal: boolean;
  /** Replay of the optimiser's path: the frame on screen, or `null` when not replaying. */
  readonly replayFrame: number | null;
  readonly replaying: boolean;
}

export const useCompute = create<ComputeState>()(() => ({
  optimizing: false,
  progress: null,
  optimization: null,
  problem: null,
  showOriginal: false,
  replayFrame: null,
  replaying: false,
}));

const set = useCompute.setState;
const get = useCompute.getState;

/** True while the structure on screen is still the one the optimisation produced. */
export function optimizationIsCurrent(record: OptimizationRecord | null, scene: Scene): record is OptimizationRecord {
  return record !== null && record.sceneAfter === scene;
}

function ghostOf(record: OptimizationRecord): { positions: Float32Array; bonds: Uint32Array } {
  const index = new Map(record.atomIds.map((id, i) => [id, i]));
  const positions = new Float32Array(record.atomIds.length * 3);
  record.atomIds.forEach((id, i) => positions.set(record.sceneBefore.atoms.get(id)!.position, 3 * i));
  const bonds = sortedBonds(record.sceneBefore).flatMap((bond) => [index.get(bond.a)!, index.get(bond.b)!]);
  return { positions, bonds: Uint32Array.from(bonds) };
}

function syncGhost(): void {
  const { optimization, showOriginal } = get();
  const current = lab.get().workspace === 'architect' && optimizationIsCurrent(optimization, lab.get().scene);
  stageApi.setGhost(current && showOriginal ? ghostOf(optimization) : null);
}

export function setShowOriginal(show: boolean): void {
  set({ showOriginal: show });
  syncGhost();
}

/** Keeps the comparison ghost honest: it disappears as soon as the structure is edited again. */
export function startComputeWatch(): () => void {
  return lab.subscribe(
    (s) => [s.scene, s.workspace] as const,
    () => {
      if (get().replaying) stopReplay();
      syncGhost();
    },
    { equalityFn: (a, b) => a[0] === b[0] && a[1] === b[1] },
  );
}

/**
 * Optimises the geometry with the Universal Force Field. With atoms selected only those move and
 * the rest stay fixed; otherwise the whole structure relaxes. The result is applied as one edit
 * that can be undone.
 */
export async function optimizeGeometry(): Promise<void> {
  const state = lab.get();
  if (state.workspace !== 'architect' || get().optimizing) return;
  const scene = state.scene;
  if (scene.atoms.size === 0) {
    notify('info', 'There is nothing to optimise yet');
    return;
  }
  const partial = state.selectedAtoms.size > 0 && state.selectedAtoms.size < scene.atoms.size;
  const movable = partial ? state.selectedAtoms : undefined;
  stopReplay();
  set({ optimizing: true, progress: null, problem: null });
  try {
    const outcome = await runJob(
      { kind: 'optimize', title: 'Geometry optimisation', detail: `Universal Force Field · ${partial ? `${movable!.size} of ${scene.atoms.size}` : scene.atoms.size} atoms` },
      ({ signal, report }) =>
        optimizeScene(scene, {
          signal,
          movable,
          trajectory: true,
          onProgress: (progress) => {
            report(null, `step ${progress.step} · ${progress.energy.toFixed(2)} kcal/mol`);
            set({ progress });
          },
        }),
    );
    if (lab.get().scene !== scene || lab.get().workspace !== 'architect') {
      set({ optimizing: false, progress: null });
      notify('info', 'The optimisation was discarded', 'The structure was edited while it ran, so the result no longer applies.');
      return;
    }
    const { result, atomIds, positions } = outcome;
    moveAtoms(positions, 'Optimise geometry (UFF)');
    const sceneAfter = lab.get().scene;

    let largestMove: OptimizationRecord['largestMove'] = null;
    for (const id of atomIds) {
      const distance = vdist(scene.atoms.get(id)!.position, positions.get(id)!);
      if (!largestMove || distance > largestMove.distance) largestMove = { atomId: id, distance };
    }
    const bondChanges = sortedBonds(scene)
      .map((bond) => ({
        a: bond.a,
        b: bond.b,
        before: vdist(scene.atoms.get(bond.a)!.position, scene.atoms.get(bond.b)!.position),
        after: vdist(positions.get(bond.a) as Vec3, positions.get(bond.b) as Vec3),
      }))
      .sort((x, y) => Math.abs(y.after - y.before) - Math.abs(x.after - x.before))
      .slice(0, 5);

    set({
      optimizing: false,
      progress: null,
      optimization: {
        sceneBefore: scene,
        sceneAfter,
        atomIds,
        movable: movable ? movable.size : atomIds.length,
        converged: result.converged,
        steps: result.steps,
        initialEnergy: result.initialEnergy,
        finalEnergy: result.finalEnergy,
        energyTerms: result.energyTerms,
        rmsGradient: result.rmsGradient,
        rmsDisplacement: result.rmsDisplacement,
        largestMove,
        bondChanges,
        atomTypes: new Map(atomIds.map((id, i) => [id, result.atomTypes[i]!])),
        warnings: result.warnings,
        elapsedMs: result.elapsedMs,
        provenance: result.provenance,
        trajectory: result.trajectory,
        energyPath: result.energyPath,
      },
    });
    syncGhost();
    if (!result.converged) notify('warning', 'The optimisation did not converge', 'The geometry improved but is not a confirmed minimum. Run it again to continue.');
  } catch (error) {
    if (error instanceof JobCancelledError) {
      set({ optimizing: false, progress: null });
      return;
    }
    const problem: ComputeProblem =
      error instanceof UnsupportedStructureError
        ? { title: error.message, details: error.reasons, atomIds: error.atomIds }
        : { title: 'The optimisation failed', details: [error instanceof Error ? error.message : String(error)], atomIds: [] };
    set({ optimizing: false, progress: null, problem });
    if (problem.atomIds.length > 0) selectOnly(problem.atomIds);
  }
}

export function cancelOptimization(): void {
  cancelJobsOfKind('optimize');
}

export function dismissProblem(): void {
  set({ problem: null });
}

// ---------- replaying the optimiser's path ----------

let replayTimer = 0;

function showFrame(record: OptimizationRecord, frame: number): void {
  const data = record.trajectory[frame];
  if (!data) return;
  const positions = new Map<AtomId, Vec3>();
  record.atomIds.forEach((id, i) => positions.set(id, [data[3 * i]!, data[3 * i + 1]!, data[3 * i + 2]!]));
  stageApi.setTransient(positions);
}

export function stopReplay(): void {
  window.cancelAnimationFrame(replayTimer);
  if (get().replayFrame !== null || get().replaying) {
    set({ replaying: false, replayFrame: null });
    stageApi.setTransient(null);
  }
}

/** Shows one recorded step of the optimiser. The scene is not changed. */
export function seekReplay(frame: number): void {
  const record = get().optimization;
  if (!optimizationIsCurrent(record, lab.get().scene) || record.trajectory.length === 0) return;
  window.cancelAnimationFrame(replayTimer);
  const clamped = Math.min(record.trajectory.length - 1, Math.max(0, Math.round(frame)));
  set({ replaying: false, replayFrame: clamped });
  showFrame(record, clamped);
}

/** Plays the optimiser's recorded path from the start to the minimum, in about four seconds. */
export function playReplay(): void {
  const record = get().optimization;
  if (!optimizationIsCurrent(record, lab.get().scene) || record.trajectory.length < 2) return;
  window.cancelAnimationFrame(replayTimer);
  const frames = record.trajectory.length;
  const duration = Math.min(6000, Math.max(1500, frames * 16));
  const started = performance.now();
  set({ replaying: true, replayFrame: 0 });
  const tick = () => {
    const t = (performance.now() - started) / duration;
    if (t >= 1) {
      set({ replaying: false, replayFrame: null });
      stageApi.setTransient(null);
      return;
    }
    const frame = Math.min(frames - 1, Math.floor(t * frames));
    if (frame !== get().replayFrame) {
      set({ replayFrame: frame });
      showFrame(record, frame);
    }
    replayTimer = window.requestAnimationFrame(tick);
  };
  showFrame(record, 0);
  replayTimer = window.requestAnimationFrame(tick);
}
