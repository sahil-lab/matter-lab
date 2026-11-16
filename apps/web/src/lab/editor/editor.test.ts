import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Quaternion, Vector3 } from 'three';
import {
  parseApparatusDefinition, parseExperimentScene, parseLabAction, parseLabContract,
} from '@matterlab/contracts/lab';
import type {
  ActionReceipt, ApparatusInstance, ExperimentScene, LabAction, LabRuntimeAdapter,
  LabRuntimeEvent, ProblemDetails, RuntimeSnapshot,
} from '@matterlab/contracts/lab';
import { apparatusRegistry, ApparatusRegistry, APPARATUS_DEFINITIONS } from '../apparatus/registry';
import { createTitrationSetup } from '../apparatus/seeds';
import { createLabCameraController } from '../environment/CameraController';
import { createFloorSurface, createWorkbenchSurface } from '../environment/coordinates';
import { createLabEditorController } from './LabEditorController';
import { ApparatusSpatialIndex, matrixOf } from './geometry';
import { checkPlacement } from './placement';
import { resolveSocket, socketCandidate, validateSocketConnection } from './sockets';
import { deserializeEditorState, serializeEditorState, parseEditorState, validateEditorState, EDITOR_STATE_JSON_SCHEMA } from './serialization';
import { EditorPointerCapture } from './capture';
import { handleEditorShortcut } from './shortcuts';
import { installEditorPointerControls } from './pointerControls';
import { LabEditorInspector, LabEditorPalette, LabEditorToolbar } from './LabEditorControls';
import type { EditorOptions } from './types';

export function idFactory(start = 1): () => string {
  let value = start;
  return () => `10000000-0000-4000-8000-${(value++).toString(16).padStart(12, '0')}`;
}
const problem = (detail: string): ProblemDetails => ({
  type: 'urn:matterlab:problem:test-rejection', title: 'Test adapter rejection', status: 409,
  code: 'REVISION_CONFLICT', detail,
});

/** Deliberately a validating action recorder, NOT the scientific/production runtime. */
export function recordingRuntime(scene: ExperimentScene) {
  const createId = idFactory(100_000);
  let snapshot = parseLabContract('RuntimeSnapshot', {
    schemaVersion: 1, runId: createId(), revision: 0, scene, apparatusStates: {}, transferTotals: [],
    observations: [], lastSequence: 0,
    stationStates: Object.fromEntries(scene.stations.map((station) => [station.id, {
      stationId: station.id, epoch: 0, status: 'PREPARING', simulationTimeS: 0, tick: 0, speed: 1,
    }])),
  });
  const listeners = new Set<(snapshot: RuntimeSnapshot, event: LabRuntimeEvent) => void>();
  const actions: LabAction[] = [];
  const batches: (readonly LabAction[])[] = [];
  let nextRejection: ProblemDetails | null = null;
  const emit = (event: LabRuntimeEvent) => listeners.forEach((listener) => listener(snapshot, parseLabContract('LabRuntimeEvent', event)));
  function stationOf(action: LabAction, current: RuntimeSnapshot): string {
    return action.type === 'PLACE' ? action.payload.instance.stationId :
      current.scene.apparatus.find((instance) => instance.id === action.targetInstanceId)!.stationId;
  }
  function apply(current: RuntimeSnapshot, raw: LabAction): { snapshot: RuntimeSnapshot; receipt: ActionReceipt; event: LabRuntimeEvent } {
    const action = parseLabAction(raw);
    actions.push(action);
    const stationId = stationOf(action, current);
    const station = current.stationStates[stationId];
    const sequence = current.lastSequence + 1;
    const rejection = nextRejection ?? (action.expectedRevision !== undefined && action.expectedRevision !== current.revision
      ? problem('The runtime changed before this edit.') : null);
    nextRejection = null;
    let next = current;
    if (!rejection) {
      const apparatus = [...current.scene.apparatus];
      const connections = [...current.scene.connections];
      const containerStates = { ...current.scene.containerStates };
      const apparatusStates = { ...current.apparatusStates };
      if (action.type === 'PLACE') apparatus.push(action.payload.instance);
      if (action.type === 'MOVE') {
        const index = apparatus.findIndex((instance) => instance.id === action.targetInstanceId);
        apparatus[index] = { ...apparatus[index], transform: action.payload.transform, revision: apparatus[index].revision + 1 };
      }
      if (action.type === 'ATTACH') connections.push(action.payload.connection);
      if (action.type === 'DETACH') {
        const index = connections.findIndex((connection) => connection.id === action.payload.connectionId);
        if (index >= 0) connections.splice(index, 1);
      }
      if (action.type === 'CUSTOM' && action.payload.actionType === 'REMOVE_EMPTY_APPARATUS') {
        apparatus.splice(apparatus.findIndex((instance) => instance.id === action.targetInstanceId), 1);
        delete containerStates[action.targetInstanceId];
        delete apparatusStates[action.targetInstanceId];
      }
      if (action.type === 'SET_VALVE') apparatusStates[action.targetInstanceId] = { ...apparatusStates[action.targetInstanceId], valveOpeningFraction: action.payload.openingFraction };
      if (action.type === 'START_STIRRER') apparatusStates[action.targetInstanceId] = { ...apparatusStates[action.targetInstanceId], stirring: action.payload };
      if (action.type === 'SET_PROBE') apparatusStates[action.targetInstanceId] = { ...apparatusStates[action.targetInstanceId], probe: action.payload };
      if (action.type === 'FILL') containerStates[action.targetInstanceId] = action.payload.contents;
      next = { ...current, revision: current.revision + 1, apparatusStates,
        scene: { ...current.scene, apparatus, connections, containerStates } };
    }
    const receipt: ActionReceipt = rejection
      ? { actionId: action.actionId, sequence, runtimeRevision: next.revision, stationId, epoch: station.epoch, status: 'REJECTED', error: rejection }
      : { actionId: action.actionId, sequence, runtimeRevision: next.revision, stationId, epoch: station.epoch, status: 'APPLIED' };
    next = { ...next, lastSequence: sequence };
    return { snapshot: next, receipt, event: { type: 'ACTION', runId: current.runId, stationId, epoch: station.epoch, sequence, action, receipt } };
  }
  const adapter: LabRuntimeAdapter = {
    reader: { getSnapshot: () => snapshot, subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; } },
    actions: {
      dispatch: async (action) => {
        const next = apply(snapshot, action);
        snapshot = parseLabContract('RuntimeSnapshot', next.snapshot);
        emit(next.event);
        return next.receipt;
      },
      control: async (control) => {
        const state = snapshot.stationStates[control.stationId];
        const sequence = snapshot.lastSequence + 1;
        const receipt = { controlId: control.controlId, sequence, runtimeRevision: snapshot.revision + 1,
          stationId: state.stationId, epoch: state.epoch, status: 'APPLIED' as const };
        snapshot = parseLabContract('RuntimeSnapshot', {
          ...snapshot, lastSequence: sequence, revision: snapshot.revision + 1,
          stationStates: { ...snapshot.stationStates, [state.stationId]: {
            ...state, ...(control.type === 'SET_SPEED' ? { speed: control.payload.speed }
              : { status: control.type === 'RESUME' ? 'RUNNING' : 'PAUSED' }),
          } },
        });
        emit({ type: 'CONTROL', runId: snapshot.runId, stationId: state.stationId, epoch: state.epoch, sequence, control, receipt });
        return receipt;
      },
    },
  };
  const dispatchBatch = async (requested: readonly LabAction[]): Promise<readonly ActionReceipt[]> => {
    batches.push(requested);
    let draft = snapshot;
    const applied = requested.map((action) => {
      const next = apply(draft, action);
      draft = next.snapshot;
      return next;
    });
    if (applied.some((item) => item.receipt.status === 'REJECTED')) return applied.map((item) => ({
      ...item.receipt, status: 'REJECTED' as const, error: problem('Atomic test rejection; no graph effects published.'),
    }));
    snapshot = parseLabContract('RuntimeSnapshot', draft);
    applied.forEach((item) => emit(item.event));
    const batchAction = parseLabAction({
      actionId: createId(), type: 'CUSTOM', targetInstanceId: requested[0].targetInstanceId,
      atSimulationS: requested[0].atSimulationS,
      payload: { pluginId: 'matterlab:editor-v1', actionType: 'BATCH', data: { actions: requested } },
    });
    const stationId = applied[0].receipt.stationId;
    const sequence = snapshot.lastSequence + 1;
    snapshot = parseLabContract('RuntimeSnapshot', { ...snapshot, lastSequence: sequence });
    emit({ type: 'ACTION', runId: snapshot.runId, sequence, stationId, epoch: snapshot.stationStates[stationId].epoch, action: batchAction,
      receipt: { actionId: batchAction.actionId, sequence, stationId, epoch: snapshot.stationStates[stationId].epoch,
        status: 'APPLIED', runtimeRevision: snapshot.revision } });
    return applied.map((item) => item.receipt);
  };
  return { adapter, dispatchBatch, actions, batches, rejectNext: (detail: string) => { nextRejection = problem(detail); } };
}
export function editorFixture(assembled = false, options: { batch?: boolean; onDuplicateStation?: EditorOptions['onDuplicateStation'] } = {}) {
  const createId = idFactory();
  const setup = createTitrationSetup('fixture:method', createId);
  const scene = assembled ? setup.scene : parseExperimentScene({
    ...setup.scene, apparatus: setup.scene.apparatus.filter((instance) => instance.kind === 'BENCH'), connections: [],
  });
  const definitions = new ApparatusRegistry(APPARATUS_DEFINITIONS.map((definition) =>
    definition.kind === 'CLAMP' || definition.kind === 'BURETTE'
      ? parseApparatusDefinition({ ...definition, tags: [...new Set([...(definition.tags ?? []), 'requires-mount'])] }) : definition));
  const runtime = recordingRuntime(scene);
  const camera = createLabCameraController({ reducedMotion: true });
  const editor = createLabEditorController({
    runtime: runtime.adapter, definitions, camera, surfaces: [createFloorSurface(20, 12)], idFactory: createId,
    ...(options.batch === false ? {} : { dispatchBatch: runtime.dispatchBatch }),
    ...(options.onDuplicateStation ? { onDuplicateStation: options.onDuplicateStation } : {}),
  });
  return { editor, runtime, camera, ids: setup.ids, definitions, scene };
}
async function place(editor: ReturnType<typeof editorFixture>['editor'], definitionId: string, x: number, z: number) {
  expect(editor.beginPlacement(definitionId)).toBe(true);
  const surface = editor.getSurfaces().find((item) => item.kind === 'tabletop' && item.stationId === editor.getSnapshot().activeStationId)!;
  expect(editor.previewPlacementOnSurface(surface.id, x, z)).toBe(true);
  expect(await editor.commitPreview()).toBe(true);
  return editor.getSnapshot().selectedIds[0];
}

describe('canonical titration editor action flow (recording adapter, not science acceptance)', () => {
  it('assembles a complete empty titration graph by surface and socket controls, then dispatches real typed operations', async () => {
    const { editor, runtime, definitions } = editorFixture();
    const stand = await place(editor, 'retort-stand', -0.45, 0);
    editor.beginPlacement('burette-clamp');
    expect(editor.previewPlacementOnSocket({ instanceId: stand, socketId: 'clamp-mount' })).toBe(true);
    expect(await editor.commitPreview()).toBe(true);
    const clamp = editor.getSnapshot().selectedIds[0];
    editor.beginPlacement('burette-50ml');
    expect(editor.previewPlacementOnSocket({ instanceId: clamp, socketId: 'barrel-grip' })).toBe(true);
    expect(await editor.commitPreview()).toBe(true);
    const burette = editor.getSnapshot().selectedIds[0];
    const stirrer = await place(editor, 'magnetic-stirrer', -0.13, 0);
    editor.beginPlacement('conical-flask-250ml');
    expect(editor.previewPlacementOnSocket({ instanceId: stirrer, socketId: 'platform' })).toBe(true);
    expect(await editor.commitPreview()).toBe(true);
    const flask = editor.getSnapshot().selectedIds[0];
    expect(await editor.connect({ instanceId: burette, socketId: 'outlet' }, { instanceId: flask, socketId: 'inlet' })).toBe(true);
    expect(await editor.connect({ instanceId: stirrer, socketId: 'stir-control' }, { instanceId: flask, socketId: 'stir-control' })).toBe(true);
    const scene = editor.getRuntimeSnapshot().scene;
    expect(scene.connections).toHaveLength(5);
    for (const connection of scene.connections) expect(validateSocketConnection(scene, definitions, connection, { ignoreConnectionId: connection.id })).toEqual([]);
    expect(scene.apparatus.find((instance) => instance.id === burette)?.transform.positionM[1]).toBeCloseTo(1.18);
    expect(scene.apparatus.find((instance) => instance.id === flask)?.transform.positionM[1]).toBeCloseTo(0.96);
    expect(await editor.setValve(burette, 0.35)).toBe(true);
    expect(runtime.actions.at(-1)?.type).toBe('SET_VALVE');
    expect(editor.getRuntimeSnapshot().apparatusStates[burette].valveOpeningFraction).toBe(0.35);
    expect(editor.getRuntimeSnapshot().scene.containerStates).toEqual({});
    expect(editor.getRuntimeSnapshot().observations).toEqual([]);
    editor.dispose();
  });

  it('preserves stable graph IDs and prior history across atomic batches while undo/redo use fresh action IDs', async () => {
    const { editor, runtime } = editorFixture();
    const stand = await place(editor, 'retort-stand', -0.45, 0);
    editor.beginPlacement('burette-clamp');
    editor.previewPlacementOnSocket({ instanceId: stand, socketId: 'clamp-mount' });
    await editor.commitPreview();
    const clamp = editor.getSnapshot().selectedIds[0];
    const edgeId = editor.getRuntimeSnapshot().scene.connections[0].id;
    expect(await editor.undo()).toBe(true);
    expect(editor.getRuntimeSnapshot().scene.apparatus.some((instance) => instance.id === clamp)).toBe(false);
    expect(await editor.undo()).toBe(true);
    expect(editor.getRuntimeSnapshot().scene.apparatus.some((instance) => instance.id === stand)).toBe(false);
    expect(await editor.redo()).toBe(true);
    expect(await editor.redo()).toBe(true);
    expect(editor.getRuntimeSnapshot().scene.apparatus.some((instance) => instance.id === clamp)).toBe(true);
    expect(editor.getRuntimeSnapshot().scene.connections[0].id).toBe(edgeId);
    expect(new Set(runtime.actions.map((action) => action.actionId)).size).toBe(runtime.actions.length);
    expect(runtime.batches.every((batch) => batch[0].expectedRevision !== undefined && batch.slice(1).every((action) => action.expectedRevision === undefined))).toBe(true);
    editor.dispose();
  });

  it('rejects invalid snaps, floating mount-only placement, bounds overflow and overlaps before sending an action', async () => {
    const { editor, runtime } = editorFixture();
    const stand = await place(editor, 'retort-stand', -0.45, 0);
    const before = runtime.actions.length;
    editor.beginPlacement('burette-clamp');
    expect(editor.previewPlacement({ positionM: [0.2, 0.9275, 0], quaternion: [0, 0, 0, 1] })).toBe(false);
    expect(editor.getSnapshot().feedback.message).toContain('mount');
    editor.beginPlacement('conical-flask-250ml');
    expect(editor.previewPlacement({ positionM: [1.18, 0.9, 0], quaternion: [0, 0, 0, 1] })).toBe(false);
    expect(editor.previewPlacement({ positionM: [-0.45, 0.9, 0], quaternion: [0, 0, 0, 1] })).toBe(false);
    expect(editor.getPreview()?.reasons.join(' ')).toContain('overlaps');
    expect(editor.previewPlacementOnSocket({ instanceId: stand, socketId: 'clamp-mount' })).toBe(false);
    expect(await editor.commitPreview()).toBe(false);
    expect(runtime.actions).toHaveLength(before);
    editor.dispose();
  });

  it('uses final geometry for grouped moves and does not move a mounted child independently', async () => {
    const { editor, ids } = editorFixture(true);
    editor.select([ids.buretteId]);
    expect(await editor.translateSelection([0.01, 0, 0])).toBe(false);
    editor.select([ids.standId, ids.stirrerId]);
    await editor.groupSelection('Titration apparatus');
    expect(await editor.translateSelection([0.2, 0, 0])).toBe(true);
    const scene = editor.getRuntimeSnapshot().scene;
    expect(scene.apparatus.find((instance) => instance.id === ids.buretteId)!.transform.positionM[0]).toBeCloseTo(0.07);
    expect(scene.apparatus.find((instance) => instance.id === ids.flaskId)!.transform.positionM[0]).toBeCloseTo(0.07);
    expect(await editor.undo()).toBe(true);
    expect(editor.getRuntimeSnapshot().scene.apparatus.find((instance) => instance.id === ids.buretteId)!.transform.positionM[0]).toBeCloseTo(-0.13);
    editor.dispose();
  });

  it('does not fake atomic rollback when no runtime batch adapter is supplied', async () => {
    const { editor, runtime } = editorFixture(false, { batch: false });
    const stand = await place(editor, 'retort-stand', -0.45, 0);
    editor.beginPlacement('burette-clamp');
    editor.previewPlacementOnSocket({ instanceId: stand, socketId: 'clamp-mount' });
    const before = runtime.actions.length;
    expect(await editor.commitPreview()).toBe(false);
    expect(editor.getSnapshot().feedback.message).toContain('dispatchBatch');
    expect(runtime.actions.length).toBe(before);
    editor.dispose();
  });

  it('keeps rejected/stale commands out of history and preserves the authoritative transform', async () => {
    const { editor, runtime, ids } = editorFixture(true);
    editor.select([ids.bottleId]);
    const original = editor.getRuntimeSnapshot().scene.apparatus.find((instance) => instance.id === ids.bottleId)!.transform;
    runtime.rejectNext('Server revision changed during drag.');
    expect(await editor.translateSelection([0.1, 0, 0])).toBe(false);
    expect(editor.getSnapshot().feedback.message).toContain('revision changed');
    expect(editor.getSnapshot().canUndo).toBe(false);
    expect(editor.getRuntimeSnapshot().scene.apparatus.find((instance) => instance.id === ids.bottleId)!.transform).toEqual(original);
    editor.dispose();
  });

  it('invalidates old previews on invalid input and keeps a rejected placement retryable', async () => {
    const { editor, runtime } = editorFixture();
    editor.beginPlacement('conical-flask-250ml');
    const surface = editor.getSurfaces().find((item) => item.kind === 'tabletop')!;
    expect(editor.previewPlacementOnSurface(surface.id, 0.4, 0)).toBe(true);
    expect(editor.previewPlacementOnSurface('missing-surface', 0.4, 0)).toBe(false);
    expect(await editor.commitPreview()).toBe(false);
    expect(runtime.actions).toHaveLength(0);
    expect(editor.previewPlacementOnSurface(surface.id, 0.4, 0)).toBe(true);
    runtime.rejectNext('Revision conflict; try again.');
    expect(await editor.commitPreview()).toBe(false);
    expect(editor.getPreview()?.kind).toBe('placement');
    expect(editor.previewPlacementOnSurface(surface.id, 0.45, 0)).toBe(true);
    expect(await editor.commitPreview()).toBe(true);
    editor.dispose();
  });

  it('never makes inventory-changing fills undoable or deletes a nonempty vessel, and blocks run undo', async () => {
    const { editor, runtime } = editorFixture();
    const flask = await place(editor, 'conical-flask-250ml', 0.4, 0);
    const contents = parseLabContract('ContainerContents', {
      volumeL: 0.025, temperatureK: 298.15, mixing: 'WELL_MIXED', modelId: 'fixture:method',
      species: [{ speciesId: 'fixture:analytical-component', moles: 0.0025 }],
    });
    expect(await editor.fill(flask, contents, 'fixture:preparation')).toBe(true);
    expect(editor.getSnapshot().canUndo).toBe(false);
    expect(await editor.deleteSelection()).toBe(false);
    expect(editor.getRuntimeSnapshot().scene.containerStates[flask]).toEqual(contents);
    expect(await editor.translateSelection([0.1, 0, 0])).toBe(true);
    expect(editor.getSnapshot().canUndo).toBe(true);
    await editor.controlStation('RESUME');
    expect(await editor.undo()).toBe(false);
    expect(editor.getSnapshot().canUndo).toBe(false);
    expect(runtime.actions.filter((action) => action.type === 'FILL')).toHaveLength(1);
    expect(editor.getRuntimeSnapshot().scene.containerStates[flask]).toEqual(contents);
    editor.dispose();
  });

  it('duplicates only geometry into an independent station, preserves original IDs, and sends new IDs through PLACE', async () => {
    const { editor, ids } = editorFixture(true);
    editor.select([ids.bottleId]);
    const original = editor.getRuntimeSnapshot().scene.apparatus.find((instance) => instance.id === ids.bottleId)!;
    editor.copySelection();
    editor.setActiveStation(ids.blankStationId);
    expect(await editor.paste([3, 0, 0])).toBe(true);
    const duplicate = editor.getRuntimeSnapshot().scene.apparatus.find((instance) => instance.id === editor.getSnapshot().selectedIds[0])!;
    expect(duplicate.id).not.toBe(original.id);
    expect(duplicate.stationId).toBe(ids.blankStationId);
    expect(duplicate.transform.positionM[0]).toBeCloseTo(original.transform.positionM[0] + 3);
    expect(editor.getRuntimeSnapshot().scene.containerStates[duplicate.id]).toBeUndefined();
    expect(await editor.translateSelection([0.1, 0, 0])).toBe(true);
    expect(editor.getRuntimeSnapshot().scene.apparatus.find((instance) => instance.id === ids.bottleId)).toEqual(original);
    editor.dispose();
  });

  it('proposes a complete independent station through the new-run callback rather than writing scene or inventories', async () => {
    const receive = vi.fn<(scene: ExperimentScene) => void>();
    const { editor, runtime, ids } = editorFixture(true, { onDuplicateStation: receive });
    const before = editor.getRuntimeSnapshot();
    expect(await editor.duplicateStation()).toBe(true);
    expect(runtime.actions).toHaveLength(0);
    expect(editor.getRuntimeSnapshot()).toBe(before);
    const proposed = receive.mock.calls[0][0];
    expect(proposed.id).not.toBe(before.scene.id);
    expect(proposed.stations).toHaveLength(3);
    const stationId = proposed.stations[2].id;
    const originals = before.scene.apparatus.filter((instance) => instance.stationId === ids.stationId);
    const clones = proposed.apparatus.filter((instance) => instance.stationId === stationId);
    expect(clones).toHaveLength(originals.length);
    expect(clones.every((instance) => !before.scene.apparatus.some((original) => original.id === instance.id))).toBe(true);
    expect(clones.every((instance) => proposed.containerStates[instance.id] === undefined)).toBe(true);
    expect(parseExperimentScene(proposed)).toEqual(proposed);
    editor.dispose();
  });

  it('locks grouped dependents and restores editor-only metadata without restoring domain inventory', async () => {
    const { editor, ids } = editorFixture(true);
    editor.select([ids.standId, ids.stirrerId]);
    await editor.groupSelection();
    await editor.lockSelection(true);
    expect(await editor.translateSelection([0.1, 0, 0])).toBe(false);
    const scene = editor.getRuntimeSnapshot().scene;
    const saved = editor.serialize();
    const json = serializeEditorState(saved, scene);
    expect(json).not.toContain('containerStates');
    expect(json).not.toContain('observations');
    expect(deserializeEditorState(json, scene)).toEqual(saved);
    await editor.lockSelection(false);
    expect(editor.restore(json)).toBe(true);
    expect(editor.getSnapshot().lockedIds).toContain(ids.buretteId);
    expect(editor.getRuntimeSnapshot().scene).toBe(scene);
    expect(editor.restore({ ...saved, containerStates: {} })).toBe(false);
    editor.dispose();
  });

  it('validates the Node-safe sidecar by scene ID without loading scene UI or accepting invalid transforms/domain fields', () => {
    const { editor, scene, ids } = editorFixture(true);
    editor.select([ids.bottleId]);
    const state = editor.serialize();
    expect(parseEditorState(state, scene.id)).toEqual(state);
    expect(validateEditorState(state, scene.id).ok).toBe(true);
    expect(EDITOR_STATE_JSON_SCHEMA.properties.initialTransforms.additionalProperties).toEqual({ $ref: '#/$defs/Transform' });
    expect(validateEditorState({ ...state, containerStates: {} }, scene.id).ok).toBe(false);
    expect(validateEditorState({ ...state, sceneId: idFactory(5000)() }, scene.id).ok).toBe(false);
    expect(validateEditorState({ ...state, initialTransforms: { [ids.bottleId]: {
      positionM: [0, Number.NaN, 0], quaternion: [0, 0, 0, 1],
    } } }, scene.id).ok).toBe(false);
    expect(validateEditorState({ ...state, initialTransforms: { [ids.bottleId]: {
      positionM: [0, 0.9, 0], quaternion: [0, 0, 0, 0.5],
    } } }, scene.id).ok).toBe(false);
    expect(Object.isFrozen(parseEditorState(state, scene.id).initialTransforms[ids.bottleId].positionM)).toBe(true);
    editor.dispose();
  });

  describe('camera ownership and accessible interaction', () => {
    it('acquires the real camera lock before capture and releases on cancel, errors and unmount with overlapping locks intact', () => {
      const { editor, camera } = editorFixture();
      const trace: string[] = [];
      const otherRelease = camera.acquireControlLock('another-tool');
      const target = {
        setPointerCapture: () => { expect(camera.getSnapshot().controlsLocked).toBe(true); trace.push('capture'); },
        releasePointerCapture: () => { trace.push('release'); },
      };
      expect(editor.beginCapture(target, 1, 'test')).toBe(true);
      expect(camera.setMode('top-down')).toBe(false);
      editor.cancel();
      expect(trace).toEqual(['capture', 'release']);
      expect(camera.getSnapshot().controlsLocked).toBe(true);
      otherRelease();
      expect(camera.getSnapshot().controlsLocked).toBe(false);
      const capture = new EditorPointerCapture(camera);
      expect(() => capture.begin({ ...target, setPointerCapture: () => { throw new Error('detached element'); } }, 1, 'failure')).toThrow('detached');
      expect(camera.getSnapshot().controlsLocked).toBe(false);
      editor.beginCapture({ ...target, releasePointerCapture: () => { throw new Error('lost element'); } }, 2, 'dispose');
      editor.dispose();
      expect(camera.getSnapshot().controlsLocked).toBe(false);
      expect(camera.setMode('top-down')).toBe(true);
    });

    it('handles scoped keyboard transforms and never intercepts editable fields or browser zoom', async () => {
      const { editor, runtime, ids } = editorFixture(true);
      editor.select([ids.bottleId]);
      const event = (key: string, overrides = {}) => ({
        key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, repeat: false,
        preventDefault: vi.fn(), stopPropagation: vi.fn(), ...overrides,
      });
      const input = event('ArrowRight', { target: { tagName: 'INPUT' } as unknown as EventTarget });
      expect(handleEditorShortcut(input, editor)).toBe(false);
      expect(input.preventDefault).not.toHaveBeenCalled();
      const arrow = event('ArrowRight', { shiftKey: true });
      expect(handleEditorShortcut(arrow, editor)).toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(arrow.preventDefault).toHaveBeenCalledOnce();
      const moved = runtime.actions.at(-1)!;
      expect(moved.type).toBe('MOVE');
      if (moved.type === 'MOVE') expect(moved.payload.transform.positionM[0]).toBeCloseTo(0.321);
      expect(handleEditorShortcut(event('+', { ctrlKey: true }), editor)).toBe(false);
      editor.dispose();
    });

    it('drives the native pointer state machine through a complete drag, pointercancel, blur and teardown', async () => {
      const { editor, runtime, camera, ids } = editorFixture(true);
      const cameraView = camera.getView();
      let enabled = true;
      const disconnect = camera.connectDriver({
        getView: () => cameraView, moveTo: () => {}, cancelMotion: () => {},
        setEnabled: (next) => { enabled = next; },
        getWorldRay: (x, y) => ({ originM: [x / 100, 3, y / 100], direction: [0, -1, 0] }),
        projectPoint: (point) => ({ clientX: point[0] * 100, clientY: point[2] * 100, visible: true }),
      });
      class FakeWindow extends EventTarget {
        callbacks = new Map<number, FrameRequestCallback>();
        next = 1;
        requestAnimationFrame(callback: FrameRequestCallback) { const id = this.next++; this.callbacks.set(id, callback); return id; }
        cancelAnimationFrame(id: number) { this.callbacks.delete(id); }
      }
      const ownerWindow = new FakeWindow();
      class FakeCanvas extends EventTarget {
        style = { cursor: 'original' };
        ownerDocument = { defaultView: ownerWindow };
        captured = new Set<number>();
        focus() {}
        setPointerCapture(id: number) { expect(enabled).toBe(false); this.captured.add(id); }
        releasePointerCapture(id: number) { this.captured.delete(id); }
        hasPointerCapture(id: number) { return this.captured.has(id); }
      }
      const canvas = new FakeCanvas();
      const teardown = installEditorPointerControls(editor, canvas as unknown as HTMLCanvasElement, {
        pick: () => ({ instanceId: ids.bottleId }), pickSocket: () => null,
      });
      const send = (type: string, x = 32, y = 0) => {
        const event = Object.assign(new Event(type, { cancelable: true }), {
          pointerId: 1, button: 0, isPrimary: true, clientX: x, clientY: y,
          shiftKey: false, metaKey: false, ctrlKey: false,
        });
        canvas.dispatchEvent(event);
        return event;
      };
      send('pointerdown');
      expect(camera.getSnapshot().controlsLocked).toBe(true);
      expect(send('pointerup', 42).defaultPrevented).toBe(true);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(camera.getSnapshot().controlsLocked).toBe(false);
      expect(editor.getRuntimeSnapshot().scene.apparatus.find((instance) => instance.id === ids.bottleId)!.transform.positionM[0]).toBeCloseTo(0.42);
      const count = runtime.actions.length;
      send('pointerdown', 42);
      send('pointermove', 52);
      send('pointercancel', 52);
      expect(runtime.actions).toHaveLength(count);
      expect(camera.getSnapshot().controlsLocked).toBe(false);
      send('pointerdown', 42);
      ownerWindow.dispatchEvent(new Event('blur'));
      expect(camera.getSnapshot().controlsLocked).toBe(false);
      send('pointerdown', 42);
      teardown();
      expect(camera.getSnapshot().controlsLocked).toBe(false);
      expect(canvas.style.cursor).toBe('original');
      expect(canvas.captured.size).toBe(0);
      disconnect();
      editor.dispose();
    });

    it('renders keyboard alternatives, a typed stopcock control and explicit experiment reset without requiring WebGL', () => {
      const { editor, ids } = editorFixture(true);
      editor.select([ids.buretteId]);
      editor.beginConnection({ instanceId: ids.buretteId, socketId: 'outlet' });
      const inspector = renderToStaticMarkup(createElement(LabEditorInspector, { editor }));
      const palette = renderToStaticMarkup(createElement(LabEditorPalette, { editor }));
      const toolbar = renderToStaticMarkup(createElement(LabEditorToolbar, { editor }));
      expect(inspector).toContain('aria-label="Apparatus selection"');
      expect(inspector).toContain('data-control-id="stopcock"');
      expect(inspector).toContain('Connect selected sockets');
      expect(inspector).toContain('editor.fill');
      expect(palette).toContain('data-definition-id="burette-50ml"');
      expect(toolbar).toContain('role="toolbar"');
      expect(toolbar).toContain('Reset experiment');
      expect(toolbar).toContain('aria-live="polite"');
      editor.dispose();
    });
  });

  it('keeps durable save revision separate and retains dirty edits made while a save is in flight', async () => {
    const { editor, ids, runtime } = editorFixture(true);
    editor.select([ids.bottleId]);
    const ticket = editor.prepareSave();
    expect(ticket.ifMatch).toBe(0);
    expect(await editor.translateSelection([0.1, 0, 0])).toBe(true);
    expect(editor.acknowledgeSave(ticket, 1)).toBe(true);
    expect(editor.getSaveStatus()).toEqual({ durableRevision: 1, dirty: true, conflict: false });
    expect(runtime.adapter.reader.getSnapshot().scene.revision).toBe(0);
    const a = editor.prepareSave();
    const b = editor.prepareSave();
    expect(editor.acknowledgeSave(b, 2)).toBe(true);
    expect(editor.acknowledgeSave(a, 3)).toBe(false);
    editor.markSaveConflict();
    expect(editor.getSaveStatus().conflict).toBe(true);
    editor.dispose();
  });
});

describe('meter-space geometry and canonical sockets', () => {
  it('permits the declared Y-only half-turn without mistaking Euler decomposition for forbidden X/Z rotation', async () => {
    const { editor, ids } = editorFixture(true);
    editor.select([ids.bottleId]);
    expect(await editor.rotateSelection('Y', 180)).toBe(true);
    expect(await editor.rotateSelection('X', 15)).toBe(false);
    expect(editor.getPreview()?.reasons.join(' ')).toContain('does not permit rotation');
    editor.dispose();
  });
  it('checks rotated full footprints and the 0.01m tabletop inset, not molecular angstrom bounds', () => {
    const { editor, scene, ids } = editorFixture();
    const definition = apparatusRegistry.getDefinition('conical-flask-250ml')!;
    const quaternion = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 4).toArray();
    const instance: ApparatusInstance = { id: idFactory(20_000)(), definitionId: definition.id, kind: definition.kind,
      config: definition.defaultConfig, capabilities: definition.capabilities, revision: 0, stationId: ids.stationId,
      transform: { positionM: [1.14, 0.9, 0], quaternion } };
    expect(checkPlacement({ scene, definitions: apparatusRegistry, instance, surfaces: editor.getSurfaces() }).valid).toBe(false);
    const inside = { ...instance, transform: { ...instance.transform, positionM: [1.13, 0.9, 0] as const } };
    expect(checkPlacement({ scene, definitions: apparatusRegistry, instance: inside, surfaces: editor.getSurfaces() }).valid).toBe(true);
    const bench = scene.apparatus.find((item) => item.id === ids.benchId)!;
    expect(createWorkbenchSurface({ id: bench.id, transform: bench.transform }).transform.positionM[1]).toBe(0.9);
    editor.dispose();
  });

  it('rejects connection capacity, direction, cross-station and mechanical cycles using only supplied metadata', () => {
    const { scene, ids, editor } = editorFixture(true);
    const duplicate = { ...scene.connections[0], id: idFactory(5000)() };
    expect(validateSocketConnection(scene, apparatusRegistry, duplicate).join(' ')).toMatch(/capacity|already connected/);
    const reversed = { ...duplicate, from: duplicate.to, to: duplicate.from };
    expect(validateSocketConnection(scene, apparatusRegistry, reversed).join(' ')).toMatch(/output|input/);
    const cross = socketCandidate(scene, apparatusRegistry, { instanceId: ids.blankBenchId, socketId: 'work-surface' },
      { instanceId: ids.standId, socketId: 'base' }, idFactory(5001)());
    expect(cross.reasons.join(' ')).toContain('workstations');
    expect(validateSocketConnection(scene, apparatusRegistry, {
      id: idFactory(5002)(), kind: 'MECHANICAL', enabled: true,
      from: { instanceId: ids.buretteId, socketId: 'barrel-mount' }, to: { instanceId: ids.standId, socketId: 'base' },
    }).join(' ')).toContain('cycle');
    const resolved = resolveSocket(scene, apparatusRegistry, { instanceId: ids.clampId, socketId: 'barrel-grip' })!;
    expect(resolved.worldTransform.positionM[0]).toBeCloseTo(-0.13);
    const physical = new Vector3(0.32, 0, 0).applyMatrix4(matrixOf(scene.apparatus.find((item) => item.id === ids.clampId)!.transform));
    expect(resolved.worldTransform.positionM).toEqual(physical.toArray());
    editor.dispose();
  });

  it('keeps 512 indexed objects queryable, updates moved bounds, and bounds oversized-object indexing', () => {
    const index = new ApparatusSpatialIndex();
    for (let i = 0; i < 512; i++) index.upsert(String(i), { minM: [i * 0.15, 0.9, 0], maxM: [i * 0.15 + 0.05, 1, 0.05] });
    expect(index.size).toBe(512);
    expect(index.query({ minM: [0.001, 0.901, 0.001], maxM: [0.049, 0.999, 0.049] })).toEqual(['0']);
    expect(index.raycast({ originM: [0.025, 3, 0.025], direction: [0, -1, 0] })[0].id).toBe('0');
    index.upsert('0', { minM: [-1, 0.9, 0], maxM: [-0.95, 1, 0.05] });
    expect(index.raycast({ originM: [0.025, 3, 0.025], direction: [0, -1, 0] })).toEqual([]);
    index.upsert('room', { minM: [-1000, -1000, -1000], maxM: [1000, 1000, 1000] });
    expect(index.raycast({ originM: [0.025, 3, 0.025], direction: [0, -1, 0] })[0].id).toBe('room');
    expect(index.raycast({ originM: [0, 0, 0], direction: [0, 0, 0] })).toEqual([]);
  });

  it('reports CPU broad-phase timings for 128 apparatus without claiming GPU frame rate', () => {
    const index = new ApparatusSpatialIndex();
    for (let i = 0; i < 128; i++) {
      const x = (i % 16) * 0.15;
      const z = Math.floor(i / 16) * 0.15;
      index.upsert(String(i), { minM: [x, 0.9, z], maxM: [x + 0.05, 1.1, z + 0.05] });
    }
    const samples: number[] = [];
    for (let i = 0; i < 500; i++) {
      const start = performance.now();
      const hits = index.raycast({ originM: [(i % 16) * 0.15 + 0.02, 3, 0.02], direction: [0, -1, 0] }, 5);
      samples.push(performance.now() - start);
      expect(hits).toHaveLength(1);
    }
    samples.sort((a, b) => a - b);
    process.stdout.write(`${JSON.stringify({ measurement: 'CPU editor spatial broad phase, no rendering', objects: 128, queries: 500,
      platform: process.platform, node: process.version,
      meanMs: samples.reduce((sum, sample) => sum + sample, 0) / samples.length, p95Ms: samples[Math.floor(samples.length * 0.95)] })}\n`);
  });
});
