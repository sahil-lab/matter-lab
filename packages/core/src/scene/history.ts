import type { Scene, ScenePatch } from '../types';
import { applyPatch, invertPatch, isEmptyPatch } from './editor';

/** Undo/redo stacks of patches. Storing patches rather than whole scenes keeps memory proportional to what changed. */
export interface History {
  readonly past: readonly ScenePatch[];
  readonly future: readonly ScenePatch[];
}

export const EMPTY_HISTORY: History = Object.freeze({ past: [], future: [] });

export const DEFAULT_HISTORY_LIMIT = 500;

/** Records a newly applied patch. Any redo steps are discarded, as in every conventional editor. */
export function recordPatch(history: History, patch: ScenePatch, limit = DEFAULT_HISTORY_LIMIT): History {
  if (isEmptyPatch(patch)) return history;
  const past = history.past.length >= limit ? history.past.slice(history.past.length - limit + 1) : history.past;
  return { past: [...past, patch], future: [] };
}

export interface HistoryStep {
  readonly scene: Scene;
  readonly history: History;
  /** The patch that was applied to reach `scene` (already inverted for an undo). */
  readonly applied: ScenePatch;
}

export function undo(scene: Scene, history: History): HistoryStep | null {
  const patch = history.past[history.past.length - 1];
  if (!patch) return null;
  const applied = invertPatch(patch);
  return {
    scene: applyPatch(scene, applied),
    history: { past: history.past.slice(0, -1), future: [...history.future, patch] },
    applied,
  };
}

export function redo(scene: Scene, history: History): HistoryStep | null {
  const patch = history.future[history.future.length - 1];
  if (!patch) return null;
  return {
    scene: applyPatch(scene, patch),
    history: { past: [...history.past, patch], future: history.future.slice(0, -1) },
    applied: patch,
  };
}
