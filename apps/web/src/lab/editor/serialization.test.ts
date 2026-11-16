import { describe, expect, it } from 'vitest';
import { IDENTITY_TRANSFORM } from './contracts';
import type { ApparatusInstance } from './contracts';
import { buildSavedSession, checkRevision, deserializeEditorScene, restoreSavedSession, serializeEditorScene } from './serialization';
import { emptyEditorScene } from './types';
import { editEditorScene } from './sceneEditor';

function instance(id: string): ApparatusInstance {
  return { id, kind: 'FLASK', definitionId: 'flask.conical250', transform: IDENTITY_TRANSFORM, revision: 1, config: {}, capabilities: ['CONTAINER'], stationId: 's1' };
}

describe('serializeEditorScene / deserializeEditorScene', () => {
  it('round-trips apparatus, connections, groups and locks exactly, including stable ids', () => {
    let state = emptyEditorScene();
    state = editEditorScene(state, 'Place', (editor) => {
      editor.placeApparatus(instance('a'));
      editor.placeApparatus(instance('b'));
    }).state;
    state = editEditorScene(state, 'Connect', (editor) => {
      editor.addConnection({ id: 'c1', from: { instanceId: 'a', socketId: 'mouth' }, to: { instanceId: 'b', socketId: 'tip' }, kind: 'FLUID', enabled: true });
      editor.addGroup({ id: 'g1', name: 'Station', memberIds: ['a', 'b'] });
      editor.setLocked('a', true);
    }).state;

    const serialized = serializeEditorScene(state);
    const json = JSON.parse(JSON.stringify(serialized)); // round-trip through the wire format a save would actually use
    const restored = deserializeEditorScene(json);

    expect(restored.apparatus.get('a')).toEqual(state.apparatus.get('a'));
    expect(restored.connections.get('c1')).toEqual(state.connections.get('c1'));
    expect(restored.groups.get('g1')!.memberIds).toEqual(['a', 'b']);
    expect(restored.locked.has('a')).toBe(true);
    expect(restored.locked.has('b')).toBe(false);
    expect(restored.nextRevision).toBe(state.nextRevision);
  });

  it('serializes an empty scene without error', () => {
    const serialized = serializeEditorScene(emptyEditorScene());
    expect(serialized.apparatus).toHaveLength(0);
    expect(deserializeEditorScene(serialized).apparatus.size).toBe(0);
  });
});

describe('buildSavedSession / restoreSavedSession', () => {
  it('carries the station list, active station and experiment snapshot through a save/reopen cycle', () => {
    const state = editEditorScene(emptyEditorScene(), 'Place', (editor) => editor.placeApparatus(instance('a'))).state;
    const experiment = {
      id: 'scene-1',
      revision: 3,
      schemaVersion: 1 as const,
      stations: [{ id: 's1', name: 'Station 1' }],
      apparatus: [],
      connections: [],
      containerStates: {},
      simulationConfig: { methodId: 'stub', timeStepS: 0.05 },
    };
    const saved = buildSavedSession(state, [{ id: 's1', name: 'Station 1' }], 's1', experiment);
    const roundTripped = JSON.parse(JSON.stringify(saved));
    const restored = restoreSavedSession(roundTripped);

    expect(restored.scene.apparatus.has('a')).toBe(true);
    expect(restored.stations).toEqual([{ id: 's1', name: 'Station 1' }]);
    expect(restored.activeStationId).toBe('s1');
    expect(restored.experiment).toEqual(experiment);
  });

  it('preserves a null experiment snapshot (no reducer was installed) rather than fabricating one', () => {
    const state = emptyEditorScene();
    const saved = buildSavedSession(state, [], 's1', null);
    expect(restoreSavedSession(saved).experiment).toBeNull();
  });
});

describe('checkRevision', () => {
  it('returns null (safe to save) when the stored revision matches the base the save started from', () => {
    expect(checkRevision(5, 5)).toBeNull();
  });

  it('returns a conflict when the stored revision has moved on since the save started', () => {
    const conflict = checkRevision(7, 5);
    expect(conflict).not.toBeNull();
    expect(conflict!.code).toBe('REVISION_CONFLICT');
    expect(conflict!.storedRevision).toBe(7);
    expect(conflict!.baseRevision).toBe(5);
  });
});
