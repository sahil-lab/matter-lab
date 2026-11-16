import { describe, expect, it } from 'vitest';
import type { ApparatusInstance } from './contracts';
import { IDENTITY_TRANSFORM } from './contracts';
import { editEditorScene } from './sceneEditor';
import { EMPTY_EDITOR_HISTORY, recordEditorPatch, redoEditor, undoEditor } from './history';
import { emptyEditorScene } from './types';

function instance(id: string): ApparatusInstance {
  return { id, kind: 'BEAKER', definitionId: 'beaker.400ml', transform: IDENTITY_TRANSFORM, revision: 1, config: {}, capabilities: ['CONTAINER'], stationId: 's1' };
}

describe('editor undo/redo history', () => {
  it('undo reverses the last patch and moves it to future; redo reapplies it', () => {
    let state = emptyEditorScene();
    let history = EMPTY_EDITOR_HISTORY;

    const place = editEditorScene(state, 'Place a', (editor) => editor.placeApparatus(instance('a')));
    state = place.state;
    history = recordEditorPatch(history, place.patch);
    expect(state.apparatus.has('a')).toBe(true);

    const undone = undoEditor(state, history)!;
    expect(undone.state.apparatus.has('a')).toBe(false);
    expect(undone.history.past).toHaveLength(0);
    expect(undone.history.future).toHaveLength(1);

    const redone = redoEditor(undone.state, undone.history)!;
    expect(redone.state.apparatus.has('a')).toBe(true);
    expect(redone.history.past).toHaveLength(1);
    expect(redone.history.future).toHaveLength(0);
  });

  it('returns null when there is nothing to undo or redo', () => {
    expect(undoEditor(emptyEditorScene(), EMPTY_EDITOR_HISTORY)).toBeNull();
    expect(redoEditor(emptyEditorScene(), EMPTY_EDITOR_HISTORY)).toBeNull();
  });

  it('a new edit after an undo discards the redo stack, like a conventional editor', () => {
    let state = emptyEditorScene();
    let history = EMPTY_EDITOR_HISTORY;
    const a = editEditorScene(state, 'Place a', (editor) => editor.placeApparatus(instance('a')));
    state = a.state;
    history = recordEditorPatch(history, a.patch);

    const undone = undoEditor(state, history)!;
    state = undone.state;
    history = undone.history;
    expect(history.future).toHaveLength(1);

    const b = editEditorScene(state, 'Place b', (editor) => editor.placeApparatus(instance('b')));
    state = b.state;
    history = recordEditorPatch(history, b.patch);
    expect(history.future).toHaveLength(0);
    expect(state.apparatus.has('a')).toBe(false);
    expect(state.apparatus.has('b')).toBe(true);
  });

  it('never records an empty patch, so a no-op edit does not create an undo step', () => {
    const state = editEditorScene(emptyEditorScene(), 'Place a', (editor) => editor.placeApparatus(instance('a'))).state;
    const noop = editEditorScene(state, 'No-op', (editor) => editor.updateApparatus('a', { transform: IDENTITY_TRANSFORM }));
    const history = recordEditorPatch(EMPTY_EDITOR_HISTORY, noop.patch);
    expect(history).toBe(EMPTY_EDITOR_HISTORY);
  });

  it('bounds the stack to the given limit, dropping the oldest patch first', () => {
    let state = emptyEditorScene();
    let history = EMPTY_EDITOR_HISTORY;
    for (let i = 0; i < 5; i++) {
      const step = editEditorScene(state, `Place ${i}`, (editor) => editor.placeApparatus(instance(`id-${i}`)));
      state = step.state;
      history = recordEditorPatch(history, step.patch, 3);
    }
    expect(history.past).toHaveLength(3);
    expect(history.past[0]!.label).toBe('Place 2');
  });
});
