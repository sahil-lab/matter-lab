import { parseLabJson, serializeLabContract } from '@matterlab/contracts';
import type { ExperimentPlugin, LabAction, RuntimeSnapshot } from '@matterlab/contracts';
import { expect, it } from 'vitest';
import { createLabRuntime, restoreLabRuntime } from '../src/runtime.ts';
import { createAqueousExperimentPlugin, EDITOR_PLUGIN_ID, resolveSolverRequests } from '../src/plugins.ts';
import { duplicateExperimentScene } from '../src/scene-tools.ts';
import { validateConnection } from '../src/graph.ts';
import { action, dependencies, fixture, uuid } from './fixtures.ts';

it('rejects invalid attachments and atomically moves/replays a mounted subtree using final alignment', async () => {
  const { scene, ids, runId } = fixture();
  const runtime = await createLabRuntime({ ...dependencies, initialScene: scene, runId });
  const moved = [ids.standId, ids.clampId, ids.buretteId].map((id, index) => {
    const prior = scene.apparatus.find((instance) => instance.id === id)!;
    return action(runtime, 2000 + index, id, 'MOVE', { transform: {
      ...prior.transform, positionM: [prior.transform.positionM[0] + 0.03, prior.transform.positionM[1], prior.transform.positionM[2]],
    } });
  });
  const receipts = await runtime.dispatchBatch(moved);
  expect(receipts.every((receipt) => receipt.status === 'APPLIED')).toBe(true);
  const checkpoint = await runtime.getCheckpoint();
  expect(checkpoint.steps[0]?.kind === 'ACTION' && checkpoint.steps[0].action.type).toBe('CUSTOM');
  const reopened = await restoreLabRuntime(parseLabJson('RuntimeCheckpoint', serializeLabContract('RuntimeCheckpoint', checkpoint)), dependencies);
  expect(serializeLabContract('RuntimeSnapshot', reopened.reader.getSnapshot())).toBe(serializeLabContract('RuntimeSnapshot', runtime.reader.getSnapshot()));
  const before = runtime.reader.getSnapshot();
  const invalid: LabAction[] = [
    action(runtime, 2010, ids.standId, 'MOVE', { transform: { positionM: [5, 0.9, 0], quaternion: [0, 0, 0, 1] } }),
    action(runtime, 2011, ids.buretteId, 'MOVE', { transform: { positionM: [0, 1.18, 0], quaternion: [0, 0, 0, 1] } }),
  ];
  await expect(runtime.dispatchBatch(invalid)).rejects.toMatchObject({ problem: { code: 'INCOMPATIBLE_SOCKET' } });
  expect(runtime.reader.getSnapshot().scene).toBe(before.scene);
  const edge = scene.connections.find((edge) => edge.kind === 'MECHANICAL')!;
  expect(validateConnection(scene, { ...edge, to: { instanceId: ids.blankBenchId, socketId: 'work-surface' } }, dependencies.definitions)?.code)
    .toBe('CROSS_STATION_CONNECTION');
  runtime.dispose();
  reopened.dispose();
});

it('permits atomic empty-apparatus undo but never removes prepared inventory or mutates a duplicate source scene', async () => {
  const { scene, ids, runId } = fixture();
  const runtime = await createLabRuntime({ ...dependencies, initialScene: scene, runId });
  const removeProbe = action(runtime, 2100, ids.probeId, 'CUSTOM', {
    pluginId: EDITOR_PLUGIN_ID, actionType: 'REMOVE_EMPTY_APPARATUS', data: {},
  });
  await runtime.dispatchBatch([removeProbe]);
  expect(runtime.reader.getSnapshot().scene.apparatus.some((instance) => instance.id === ids.probeId)).toBe(false);
  await expect(runtime.dispatchBatch([action(runtime, 2101, ids.flaskId, 'CUSTOM', {
    pluginId: EDITOR_PLUGIN_ID, actionType: 'REMOVE_EMPTY_APPARATUS', data: {},
  })])).rejects.toMatchObject({ problem: { code: 'INVALID_PHASE' } });
  expect(runtime.reader.getSnapshot().scene.containerStates[ids.flaskId]!.volumeL).toBe(0.025);
  let next = 3000;
  const duplicated = duplicateExperimentScene(scene, () => uuid(++next));
  const originalIds = new Set(scene.apparatus.map((instance) => instance.id));
  expect(duplicated.apparatus.every((instance) => !originalIds.has(instance.id))).toBe(true);
  expect(duplicated.containerStates).not.toBe(scene.containerStates);
  expect(scene.apparatus.some((instance) => instance.id === ids.probeId)).toBe(true);
  runtime.dispose();
});

it('binds copied-but-equal solver inputs by explicit IDs and rejects ambiguous or forged vessel attribution', async () => {
  const { scene, ids, runId, secondReceiverId } = fixture();
  const runtime = await createLabRuntime({ ...dependencies, initialScene: scene, runId });
  const snapshot = runtime.reader.getSnapshot();
  const plugin = createAqueousExperimentPlugin(dependencies.science);
  const input = plugin.getSolverRequests!(snapshot, ids.stationId).find((request) => request.apparatusId === ids.flaskId)!.input;
  const explicit: ExperimentPlugin = {
    ...plugin, getSolverRequests: () => [{ apparatusId: ids.flaskId, input: structuredClone(input) }],
  };
  expect(resolveSolverRequests(explicit, snapshot, ids.stationId, dependencies.definitions)[0]!.apparatusId).toBe(ids.flaskId);
  const forged: ExperimentPlugin = { ...explicit, getSolverRequests: () => [{ apparatusId: secondReceiverId, input }] };
  expect(() => resolveSolverRequests(forged, snapshot, ids.stationId, dependencies.definitions)).toThrow(/same-station/);
  expect(() => resolveSolverRequests({ ...explicit, getSolverRequests: () => [{
    apparatusId: ids.flaskId, input: { ...input, contents: { ...input.contents, volumeL: 0.04 } },
  }] }, snapshot, ids.stationId, dependencies.definitions)).toThrow(/differs/);
  const legacy: ExperimentPlugin = {
    id: plugin.id, version: plugin.version, methodId: plugin.methodId, requiredCapabilities: plugin.requiredCapabilities,
    supportedActionTypes: plugin.supportedActionTypes, getSupport: plugin.getSupport,
    getSolverInputs: (_snapshot: RuntimeSnapshot) => [structuredClone(input)],
  };
  expect(() => resolveSolverRequests(legacy, snapshot, ids.stationId, dependencies.definitions)).toThrow(/uniquely attributed/);
  runtime.dispose();
});
