/**
 * Undo/redo stacks of `EditorPatch`es for `EditorSceneState` — the editing-command history the
 * brief's item 5 calls for ("editing commands... undoable"), kept entirely separate from
 * experiment-event history (volume transfers, observations), which is never undone this way: see
 * `00_SHARED_INTEGRATION_CONTRACT.md` Section 4 and the role brief ("treat undo/redo of a running
 * experiment as reset/replay rather than magic inventory reversal"). Mirrors
 * `packages/core/src/scene/history.ts` exactly in shape so the two editors behave identically.
 */
import { applyEditorPatch, invertEditorPatch, isEmptyEditorPatch } from './sceneEditor';
import type { EditorPatch } from './sceneEditor';
import type { EditorSceneState } from './types';

export interface EditorHistory {
  readonly past: readonly EditorPatch[];
  readonly future: readonly EditorPatch[];
}

export const EMPTY_EDITOR_HISTORY: EditorHistory = Object.freeze({ past: [], future: [] });

export const DEFAULT_EDITOR_HISTORY_LIMIT = 500;

/** Records a newly applied patch. Any redo steps are discarded, as in every conventional editor. */
export function recordEditorPatch(history: EditorHistory, patch: EditorPatch, limit = DEFAULT_EDITOR_HISTORY_LIMIT): EditorHistory {
  if (isEmptyEditorPatch(patch)) return history;
  const past = history.past.length >= limit ? history.past.slice(history.past.length - limit + 1) : history.past;
  return { past: [...past, patch], future: [] };
}

export interface EditorHistoryStep {
  readonly state: EditorSceneState;
  readonly history: EditorHistory;
  /** The patch that was applied to reach `state` (already inverted for an undo). */
  readonly applied: EditorPatch;
}

export function undoEditor(state: EditorSceneState, history: EditorHistory): EditorHistoryStep | null {
  const patch = history.past[history.past.length - 1];
  if (!patch) return null;
  const applied = invertEditorPatch(patch);
  return {
    state: applyEditorPatch(state, applied),
    history: { past: history.past.slice(0, -1), future: [...history.future, patch] },
    applied,
  };
}

export function redoEditor(state: EditorSceneState, history: EditorHistory): EditorHistoryStep | null {
  const patch = history.future[history.future.length - 1];
  if (!patch) return null;
  return {
    state: applyEditorPatch(state, patch),
    history: { past: [...history.past, patch], future: history.future.slice(0, -1) },
    applied: patch,
  };
}
