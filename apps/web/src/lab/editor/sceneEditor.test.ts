import { describe, expect, it } from 'vitest';
import type { ApparatusInstance } from './contracts';
import { IDENTITY_TRANSFORM } from './contracts';
import { applyEditorPatch, editEditorScene, invertEditorPatch, isEmptyEditorPatch } from './sceneEditor';
import { emptyEditorScene } from './types';

function instance(id: string, overrides: Partial<ApparatusInstance> = {}): ApparatusInstance {
  return {
    id,
    kind: 'BEAKER',
    definitionId: 'beaker.400ml',
    transform: IDENTITY_TRANSFORM,
    revision: 1,
    config: {},
    capabilities: ['CONTAINER'],
    stationId: 'station-1',
    ...overrides,
  };
}

describe('editEditorScene / EditorSceneEditor', () => {
  it('adds an apparatus instance and produces a patch that adds it', () => {
    const state = emptyEditorScene();
    const { state: next, patch } = editEditorScene(state, 'Place beaker', (editor) => {
      editor.placeApparatus(instance('a'));
    });
    expect(next.apparatus.has('a')).toBe(true);
    expect(patch.apparatusAdded).toHaveLength(1);
    expect(next.nextRevision).toBe(state.nextRevision + 1);
  });

  it('produces an empty patch, and leaves the state reference unchanged, when nothing actually changes', () => {
    const state = editEditorScene(emptyEditorScene(), 'Place beaker', (editor) => editor.placeApparatus(instance('a'))).state;
    const { state: next, patch } = editEditorScene(state, 'No-op move', (editor) => {
      editor.updateApparatus('a', { transform: IDENTITY_TRANSFORM });
    });
    expect(isEmptyEditorPatch(patch)).toBe(true);
    expect(next).toBe(state);
  });

  it('records a move as a before/after change, not an add+remove', () => {
    const state = editEditorScene(emptyEditorScene(), 'Place', (editor) => editor.placeApparatus(instance('a'))).state;
    const moved = { positionM: [1, 2, 3] as const, quaternion: IDENTITY_TRANSFORM.quaternion };
    const { patch } = editEditorScene(state, 'Move', (editor) => editor.updateApparatus('a', { transform: moved }));
    expect(patch.apparatusAdded).toHaveLength(0);
    expect(patch.apparatusRemoved).toHaveLength(0);
    expect(patch.apparatusChanged).toHaveLength(1);
    expect(patch.apparatusChanged[0]!.after.transform.positionM).toEqual([1, 2, 3]);
  });

  it('removing an apparatus also removes connections and group memberships that reference it', () => {
    let state = emptyEditorScene();
    state = editEditorScene(state, 'Place', (editor) => {
      editor.placeApparatus(instance('a'));
      editor.placeApparatus(instance('b'));
    }).state;
    state = editEditorScene(state, 'Connect', (editor) => {
      editor.addConnection({ id: 'c1', from: { instanceId: 'a', socketId: 'x' }, to: { instanceId: 'b', socketId: 'y' }, kind: 'MECHANICAL', enabled: true });
      editor.addGroup({ id: 'g1', name: 'Station', memberIds: ['a', 'b'] });
    }).state;

    const { state: next, patch } = editEditorScene(state, 'Remove a', (editor) => editor.removeApparatus('a'));
    expect(next.apparatus.has('a')).toBe(false);
    expect(next.connections.has('c1')).toBe(false);
    expect(next.groups.get('g1')!.memberIds).toEqual(['b']);
    expect(patch.apparatusRemoved).toHaveLength(1);
    expect(patch.connectionsRemoved).toHaveLength(1);
    expect(patch.groupsChanged).toHaveLength(1);
  });

  it('invertEditorPatch undoes an add as a remove, and applyEditorPatch round-trips exactly', () => {
    const state = emptyEditorScene();
    const { state: placed, patch } = editEditorScene(state, 'Place', (editor) => editor.placeApparatus(instance('a')));
    const restored = applyEditorPatch(placed, invertEditorPatch(patch));
    expect(restored.apparatus.has('a')).toBe(false);
    const reapplied = applyEditorPatch(restored, patch);
    expect(reapplied.apparatus.get('a')).toEqual(placed.apparatus.get('a'));
  });

  it('lock/unlock is tracked as its own patch field, independent of apparatus changes', () => {
    const state = editEditorScene(emptyEditorScene(), 'Place', (editor) => editor.placeApparatus(instance('a'))).state;
    const { state: locked, patch } = editEditorScene(state, 'Lock', (editor) => editor.setLocked('a', true));
    expect(locked.locked.has('a')).toBe(true);
    expect(patch.lockedAdded).toEqual(['a']);
    const unlocked = applyEditorPatch(locked, invertEditorPatch(patch));
    expect(unlocked.locked.has('a')).toBe(false);
  });
});
