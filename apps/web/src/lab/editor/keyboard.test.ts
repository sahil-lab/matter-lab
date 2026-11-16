import { beforeEach, describe, expect, it } from 'vitest';
import { installLabActionSink } from './actionSink';
import { createLabReducer } from '../experiments/labReducer';
import { placeApparatus } from './commands';
import { IDENTITY_TRANSFORM } from './contracts';
import type { UUID } from './contracts';
import { initialEditorState, labEditor, pickIndex, setSelection, useLabEditor } from './editorStore';
import { handleKeyDown } from './keyboard';
import type { KeyboardGestureEvent } from './keyboard';

function key(partial: Partial<KeyboardGestureEvent> & { key: string }): KeyboardGestureEvent {
  return { ctrlKey: false, metaKey: false, shiftKey: false, target: null, preventDefault: () => {}, ...partial };
}

beforeEach(() => {
  useLabEditor.setState(initialEditorState(), true);
  pickIndex.clear();
  installLabActionSink(createLabReducer());
});

function placeFlask(positionM: readonly [number, number, number] = [0, 0, 0]): UUID {
  return placeApparatus({ definitionId: 'flask.conical250', kind: 'FLASK', transform: { positionM, quaternion: IDENTITY_TRANSFORM.quaternion }, capabilities: ['CONTAINER'], stationId: 's1' }).instanceId;
}

describe('handleKeyDown', () => {
  it('Delete removes the selected instances', () => {
    const id = placeFlask();
    setSelection([id]);
    handleKeyDown(key({ key: 'Delete' }));
    expect(labEditor.get().scene.apparatus.has(id)).toBe(false);
  });

  it('ignores shortcuts while an input element has focus', () => {
    const id = placeFlask();
    setSelection([id]);
    handleKeyDown(key({ key: 'Delete', target: { tagName: 'INPUT' } as unknown as EventTarget }));
    expect(labEditor.get().scene.apparatus.has(id)).toBe(true);
  });

  it('Ctrl+Z undoes and Ctrl+Shift+Z redoes', () => {
    const id = placeFlask();
    handleKeyDown(key({ key: 'z', ctrlKey: true }));
    expect(labEditor.get().scene.apparatus.has(id)).toBe(false);
    handleKeyDown(key({ key: 'z', ctrlKey: true, shiftKey: true }));
    expect(labEditor.get().scene.apparatus.has(id)).toBe(true);
  });

  it('Ctrl+D duplicates the selection and selects the duplicate', () => {
    const id = placeFlask();
    setSelection([id]);
    handleKeyDown(key({ key: 'd', ctrlKey: true }));
    expect(labEditor.get().scene.apparatus.size).toBe(2);
    expect(labEditor.get().selection.has(id)).toBe(false);
  });

  it('Ctrl+C then Ctrl+V pastes a new, independent instance', () => {
    const id = placeFlask();
    setSelection([id]);
    handleKeyDown(key({ key: 'c', ctrlKey: true }));
    handleKeyDown(key({ key: 'v', ctrlKey: true }));
    expect(labEditor.get().scene.apparatus.size).toBe(2);
  });

  it('g groups a multi-selection and Ctrl+Shift+G ungroups it', () => {
    const a = placeFlask([0, 0, 0]);
    const b = placeFlask([1, 0, 0]);
    setSelection([a, b]);
    handleKeyDown(key({ key: 'g', ctrlKey: true }));
    expect(labEditor.get().scene.groups.size).toBe(1);
    handleKeyDown(key({ key: 'g', ctrlKey: true, shiftKey: true }));
    expect(labEditor.get().scene.groups.size).toBe(0);
  });

  it('l toggles lock for the selection', () => {
    const id = placeFlask();
    setSelection([id]);
    handleKeyDown(key({ key: 'l' }));
    expect(labEditor.get().scene.locked.has(id)).toBe(true);
    handleKeyDown(key({ key: 'l' }));
    expect(labEditor.get().scene.locked.has(id)).toBe(false);
  });

  it('Tab cycles the selection through every placed instance (keyboard-only selection)', () => {
    const a = placeFlask([0, 0, 0]);
    const b = placeFlask([1, 0, 0]);
    setSelection([a]);
    handleKeyDown(key({ key: 'Tab' }));
    expect(labEditor.get().selection.has(b)).toBe(true);
    handleKeyDown(key({ key: 'Tab', shiftKey: true }));
    expect(labEditor.get().selection.has(a)).toBe(true);
  });

  it('arrow keys nudge the selection by a small step, and Shift nudges further', () => {
    const id = placeFlask([0, 0, 0]);
    setSelection([id]);
    handleKeyDown(key({ key: 'ArrowRight' }));
    const afterFine = labEditor.get().scene.apparatus.get(id)!.transform.positionM[0];
    expect(afterFine).toBeGreaterThan(0);
    handleKeyDown(key({ key: 'ArrowRight', shiftKey: true }));
    const afterCoarse = labEditor.get().scene.apparatus.get(id)!.transform.positionM[0];
    expect(afterCoarse - afterFine).toBeGreaterThan(afterFine);
  });

  it('a locked instance does not move via arrow-key nudge', () => {
    const id = placeFlask([0, 0, 0]);
    setSelection([id]);
    handleKeyDown(key({ key: 'l' }));
    handleKeyDown(key({ key: 'ArrowRight' }));
    expect(labEditor.get().scene.apparatus.get(id)!.transform.positionM[0]).toBe(0);
  });
});
