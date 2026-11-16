import { beforeEach, describe, expect, it } from 'vitest';
import { installLabActionSink } from './actionSink';
import {
  alignInstances,
  attachConnection,
  copyInstances,
  detachConnection,
  duplicateInstances,
  duplicateStation,
  groupInstances,
  moveApparatus,
  pasteClipboard,
  placeApparatus,
  redo,
  removeInstances,
  resetRotation,
  setLocked,
  undo,
  ungroup,
} from './commands';
import { IDENTITY_TRANSFORM } from './contracts';
import { initialEditorState, labEditor, pickIndex, useLabEditor } from './editorStore';
import { createLabReducer } from '../experiments/labReducer';
import type { LabReducer } from '../experiments/labReducer';

let reducer: LabReducer;

beforeEach(() => {
  useLabEditor.setState(initialEditorState(), true);
  pickIndex.clear();
  reducer = createLabReducer();
  installLabActionSink(reducer);
});

const STATION = 'station-1';

function placeFlask(positionM: readonly [number, number, number] = [0, 0, 0]) {
  return placeApparatus({
    definitionId: 'flask.conical250',
    kind: 'FLASK',
    transform: { positionM, quaternion: IDENTITY_TRANSFORM.quaternion },
    capabilities: ['CONTAINER', 'FLOW_RECEIVER'],
    stationId: STATION,
  });
}

describe('placeApparatus', () => {
  it('adds the instance to both the local scene and the reducer, as one undo step', () => {
    const { instanceId, result } = placeFlask();
    expect(result.accepted).toBe(true);
    expect(labEditor.get().scene.apparatus.has(instanceId)).toBe(true);
    expect(reducer.getApparatus().some((a) => a.id === instanceId)).toBe(true);
    expect(labEditor.get().history.past).toHaveLength(1);
  });

  it('keeps the spatial pick index in sync with placement', () => {
    const { instanceId } = placeFlask([2, 0, 2]);
    expect(pickIndex.boxFor(instanceId)).toBeDefined();
  });
});

describe('undo / redo', () => {
  it('undoing a placement removes the instance from both the editor and the reducer', () => {
    const { instanceId } = placeFlask();
    undo();
    expect(labEditor.get().scene.apparatus.has(instanceId)).toBe(false);
    expect(reducer.getApparatus().some((a) => a.id === instanceId)).toBe(false);
    expect(pickIndex.boxFor(instanceId)).toBeUndefined();
  });

  it('redo restores exactly what was undone', () => {
    const { instanceId } = placeFlask();
    undo();
    redo();
    expect(labEditor.get().scene.apparatus.has(instanceId)).toBe(true);
    expect(reducer.getApparatus().some((a) => a.id === instanceId)).toBe(true);
  });

  it('undoing a move restores the previous transform on both sides', () => {
    const { instanceId } = placeFlask([0, 0, 0]);
    moveApparatus(instanceId, { positionM: [1, 0, 0], quaternion: IDENTITY_TRANSFORM.quaternion });
    expect(labEditor.get().scene.apparatus.get(instanceId)!.transform.positionM).toEqual([1, 0, 0]);
    undo();
    expect(labEditor.get().scene.apparatus.get(instanceId)!.transform.positionM).toEqual([0, 0, 0]);
    expect(reducer.getApparatus().find((a) => a.id === instanceId)!.transform.positionM).toEqual([0, 0, 0]);
  });

  it('a locked instance does not move', () => {
    const { instanceId } = placeFlask();
    setLocked([instanceId], true);
    moveApparatus(instanceId, { positionM: [5, 5, 5], quaternion: IDENTITY_TRANSFORM.quaternion });
    expect(labEditor.get().scene.apparatus.get(instanceId)!.transform.positionM).toEqual([0, 0, 0]);
  });
});

describe('connections', () => {
  function placeStandAndClamp() {
    const stand = placeApparatus({ definitionId: 'stand.retort', kind: 'STAND', transform: IDENTITY_TRANSFORM, capabilities: ['MOUNT', 'MOUNTABLE'], stationId: STATION });
    const clamp = placeApparatus({
      definitionId: 'clamp.burette',
      kind: 'CLAMP',
      transform: { positionM: [0.06, 0.38, 0], quaternion: IDENTITY_TRANSFORM.quaternion },
      capabilities: ['MOUNT', 'MOUNTABLE'],
      stationId: STATION,
    });
    return { standId: stand.instanceId, clampId: clamp.instanceId };
  }

  it('attach is accepted for a valid socket pair and recorded as one connection', () => {
    const { standId, clampId } = placeStandAndClamp();
    const { connectionId, result } = attachConnection({ instanceId: standId, socketId: 'rail-mid' }, { instanceId: clampId, socketId: 'mount' }, 'MECHANICAL');
    expect(result.accepted).toBe(true);
    expect(labEditor.get().scene.connections.has(connectionId)).toBe(true);
    expect(reducer.getConnections().some((c) => c.id === connectionId)).toBe(true);
  });

  it('a rejected attach (incompatible sockets) rolls back locally and never reaches the reducer', () => {
    const { clampId } = placeStandAndClamp();
    const beaker = placeApparatus({ definitionId: 'beaker.400ml', kind: 'BEAKER', transform: IDENTITY_TRANSFORM, capabilities: ['CONTAINER', 'FLOW_RECEIVER'], stationId: STATION });
    const before = labEditor.get().scene.connections.size;
    const { result } = attachConnection({ instanceId: clampId, socketId: 'jaw' }, { instanceId: beaker.instanceId, socketId: 'base' }, 'MECHANICAL');
    expect(result.accepted).toBe(false);
    expect(labEditor.get().scene.connections.size).toBe(before);
    expect(reducer.getConnections()).toHaveLength(0);
  });

  it('detach removes the connection from both sides', () => {
    const { standId, clampId } = placeStandAndClamp();
    const { connectionId } = attachConnection({ instanceId: standId, socketId: 'rail-mid' }, { instanceId: clampId, socketId: 'mount' }, 'MECHANICAL');
    const result = detachConnection(connectionId);
    expect(result.accepted).toBe(true);
    expect(labEditor.get().scene.connections.has(connectionId)).toBe(false);
    expect(reducer.getConnections()).toHaveLength(0);
  });
});

describe('duplicate / copy / paste', () => {
  it('duplicateInstances creates a new id, offsets the transform, and starts with no chemical inventory', () => {
    const { instanceId } = placeFlask([0, 0, 0]);
    reducer.dispatch({ actionId: 'fill-1', atSimulationS: 0, targetInstanceId: instanceId, type: 'FILL', payload: { speciesId: 'HCl', concentrationMolPerL: 0.1, volumeL: 0.01, temperatureK: 298.15 } });
    const [copyId] = duplicateInstances([instanceId]);
    expect(copyId).toBeDefined();
    expect(copyId).not.toBe(instanceId);
    const copyTransform = labEditor.get().scene.apparatus.get(copyId!)!.transform;
    expect(copyTransform.positionM).not.toEqual([0, 0, 0]);
    expect(reducer.getContainerStates()[copyId!]!.volumeL).toBe(0);
    // The original is left untouched and editable independently.
    expect(reducer.getContainerStates()[instanceId]!.volumeL).toBeCloseTo(0.01, 9);
  });

  it('copy then paste produces an independent instance distinct from the original', () => {
    const { instanceId } = placeFlask([0, 0, 0]);
    copyInstances([instanceId]);
    const [pastedId] = pasteClipboard();
    expect(pastedId).toBeDefined();
    expect(pastedId).not.toBe(instanceId);
    expect(labEditor.get().scene.apparatus.has(pastedId!)).toBe(true);
  });

  it('duplicateStation copies the apparatus and connection graph into a new, independent station', () => {
    const stand = placeApparatus({ definitionId: 'stand.retort', kind: 'STAND', transform: IDENTITY_TRANSFORM, capabilities: ['MOUNT', 'MOUNTABLE'], stationId: STATION });
    const clamp = placeApparatus({
      definitionId: 'clamp.burette',
      kind: 'CLAMP',
      transform: { positionM: [0.06, 0.38, 0], quaternion: IDENTITY_TRANSFORM.quaternion },
      capabilities: ['MOUNT', 'MOUNTABLE'],
      stationId: STATION,
    });
    attachConnection({ instanceId: stand.instanceId, socketId: 'rail-mid' }, { instanceId: clamp.instanceId, socketId: 'mount' }, 'MECHANICAL');

    const newStationId = duplicateStation(STATION, 'Station 2');
    const copiedInstances = [...labEditor.get().scene.apparatus.values()].filter((i) => i.stationId === newStationId);
    expect(copiedInstances).toHaveLength(2);
    const copiedConnections = [...labEditor.get().scene.connections.values()].filter((c) => copiedInstances.some((i) => i.id === c.from.instanceId));
    expect(copiedConnections).toHaveLength(1);
    // Editing the duplicate (moving it) never touches the original station's instances.
    const originalStand = labEditor.get().scene.apparatus.get(stand.instanceId)!;
    moveApparatus(copiedInstances[0]!.id, { positionM: [9, 9, 9], quaternion: IDENTITY_TRANSFORM.quaternion });
    expect(labEditor.get().scene.apparatus.get(stand.instanceId)!.transform).toEqual(originalStand.transform);
  });
});

describe('groups and alignment', () => {
  it('groupInstances then ungroup round-trips the group', () => {
    const a = placeFlask([0, 0, 0]);
    const b = placeFlask([1, 0, 0]);
    const groupId = groupInstances([a.instanceId, b.instanceId], 'My station')!;
    expect(labEditor.get().scene.groups.get(groupId)?.memberIds).toEqual([a.instanceId, b.instanceId]);
    ungroup(groupId);
    expect(labEditor.get().scene.groups.has(groupId)).toBe(false);
  });

  it('alignInstances(center) moves every selected instance to the same coordinate on that axis', () => {
    const a = placeFlask([0, 0, 0]);
    const b = placeFlask([2, 0, 0]);
    alignInstances([a.instanceId, b.instanceId], 'x', 'center');
    const ax = labEditor.get().scene.apparatus.get(a.instanceId)!.transform.positionM[0];
    const bx = labEditor.get().scene.apparatus.get(b.instanceId)!.transform.positionM[0];
    expect(ax).toBeCloseTo(1, 9);
    expect(bx).toBeCloseTo(1, 9);
  });

  it('resetRotation clears orientation while preserving position', () => {
    const { instanceId } = placeFlask([3, 0, 3]);
    moveApparatus(instanceId, { positionM: [3, 0, 3], quaternion: [0, 0.707, 0, 0.707] });
    resetRotation([instanceId]);
    const transform = labEditor.get().scene.apparatus.get(instanceId)!.transform;
    expect(transform.quaternion).toEqual([0, 0, 0, 1]);
    expect(transform.positionM).toEqual([3, 0, 3]);
  });
});

describe('removeInstances', () => {
  it('deletes an unlocked instance from both sides and skips a locked one', () => {
    const unlocked = placeFlask([0, 0, 0]);
    const locked = placeFlask([1, 0, 0]);
    setLocked([locked.instanceId], true);
    removeInstances([unlocked.instanceId, locked.instanceId]);
    expect(labEditor.get().scene.apparatus.has(unlocked.instanceId)).toBe(false);
    expect(labEditor.get().scene.apparatus.has(locked.instanceId)).toBe(true);
    expect(reducer.getApparatus().some((a) => a.id === unlocked.instanceId)).toBe(false);
  });
});
