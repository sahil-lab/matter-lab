import { parseLabJson, serializeLabContract } from '@matterlab/contracts';
import type { LabRuntimeEvent, RuntimeSnapshot } from '@matterlab/contracts';
import { describe, expect, it } from 'vitest';
import { createLabRuntime, restoreLabRuntime } from '../src/runtime.ts';
import { inventoryTotals } from '../src/inventory.ts';
import { selectCurrentObservation, selectProbeObservation, selectTitrationObservations } from '../src/selectors.ts';
import { action, dependencies, fixture, prepared, resume, uuid } from './fixtures.ts';

describe('single-writer inventory, real science and independent clocks', () => {
  it('runs the real 25mL titration at the seed 0.1s timestep and conserves both stations', async () => {
    const { scene, ids, runId, secondSourceId } = fixture();
    const runtime = await createLabRuntime({ ...dependencies, initialScene: scene, runId });
    const before = inventoryTotals(runtime.reader.getSnapshot().scene);
    const secondBefore = runtime.reader.getSnapshot().scene.containerStates[secondSourceId];
    const observed: { snapshot: RuntimeSnapshot; event: LabRuntimeEvent }[] = [];
    runtime.reader.subscribe((snapshot, event) => { observed.push({ snapshot, event }); });
    await resume(runtime, ids.stationId, 1000);
    await runtime.actions.dispatch(action(runtime, 1001, ids.buretteId, 'SET_VALVE', { openingFraction: 1 }));
    await runtime.advanceStation(ids.stationId, 250);
    const snapshot = runtime.reader.getSnapshot();
    const after = inventoryTotals(snapshot.scene);
    expect(after.volumeL).toBeCloseTo(before.volumeL, 12);
    for (const [species, amount] of Object.entries(before.moles)) expect(after.moles[species]).toBeCloseTo(amount, 12);
    expect(snapshot.scene.containerStates[ids.flaskId]!.volumeL).toBeCloseTo(0.05, 12);
    expect(snapshot.scene.containerStates[ids.buretteId]!.volumeL).toBeCloseTo(0.025, 12);
    expect(snapshot.scene.containerStates[secondSourceId]).toBe(secondBefore);
    expect(snapshot.stationStates[ids.blankStationId]!.simulationTimeS).toBe(0);
    const ph = selectCurrentObservation(snapshot, ids.flaskId, 'PH')!;
    expect(ph.observation.quantity.value).toBeCloseTo(7, 5);
    expect(ph.observation.evidence).toBe('MODEL_CALCULATED');
    expect(ph.observation.titration?.deliveredVolumeL).toBeCloseTo(0.025, 12);
    expect(selectTitrationObservations(snapshot, ids.stationId, ids.buretteId, ids.flaskId).length).toBeGreaterThan(200);
    const transfers = observed.filter(({ event }) => event.type === 'ACTION' && event.action.type === 'TRANSFER');
    expect(transfers).toHaveLength(250);
    for (const { event, snapshot: published } of transfers) {
      expect(event.type === 'ACTION' && event.receipt.status).toBe('APPLIED');
      expect(published).toBe(snapshot);
    }
    const checkpoint = await runtime.getCheckpoint();
    expect(serializeLabContract('RuntimeCheckpoint', checkpoint).length).toBeLessThan(8 * 1024 * 1024);
    runtime.dispose();
  }, 60_000);

  it('logs explicit preparation, prevents FILL during run/pause, and pauses without transfers', async () => {
    const { scene, ids, runId } = fixture(false);
    const runtime = await createLabRuntime({ ...dependencies, initialScene: scene, runId });
    const fillSource = action(runtime, 1100, ids.buretteId, 'FILL', {
      contents: prepared('naoh', 0.05), preparation: { kind: 'INITIAL', sourceId: 'test:external-stock' },
    });
    expect((await runtime.actions.dispatch(fillSource)).status).toBe('APPLIED');
    await runtime.actions.dispatch(action(runtime, 1101, ids.flaskId, 'FILL', {
      contents: prepared('hcl', 0.025), preparation: { kind: 'INITIAL', sourceId: 'test:aliquot' },
    }));
    await resume(runtime, ids.stationId, 1102);
    await runtime.actions.dispatch(action(runtime, 1103, ids.buretteId, 'SET_VALVE', { openingFraction: 1 }));
    await runtime.advanceStation(ids.stationId, 2);
    const station = runtime.reader.getSnapshot().stationStates[ids.stationId]!;
    await runtime.actions.control({ controlId: uuid(1104), stationId: ids.stationId, atSimulationS: station.simulationTimeS, type: 'PAUSE', payload: {} });
    const paused = runtime.reader.getSnapshot().scene.containerStates;
    await runtime.advanceStation(ids.stationId, 5);
    expect(runtime.reader.getSnapshot().scene.containerStates).toBe(paused);
    const rejected = await runtime.actions.dispatch(action(runtime, 1105, ids.buretteId, 'FILL', {
      contents: prepared('naoh', 0.05), preparation: { kind: 'EXTERNAL', sourceId: 'test:not-an-invisible-source' },
    }));
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.status === 'REJECTED' && rejected.error.code).toBe('INVALID_PHASE');
    expect(runtime.reader.getSnapshot().scene.containerStates).toBe(paused);
    runtime.dispose();
  });

  it('is idempotent across reset and serialized restore without replaying transfers twice', async () => {
    const { scene, ids, fluidId, runId } = fixture();
    const runtime = await createLabRuntime({ ...dependencies, initialScene: scene, runId });
    await resume(runtime, ids.stationId, 1200);
    const transfer = action(runtime, 1201, ids.buretteId, 'TRANSFER', {
      sourceInstanceId: ids.buretteId, targetInstanceId: ids.flaskId, connectionId: fluidId, volumeL: 0.001,
    });
    const receipt = await runtime.actions.dispatch(transfer);
    const applied = runtime.reader.getSnapshot();
    expect(await runtime.actions.dispatch(transfer)).toBe(receipt);
    expect(runtime.reader.getSnapshot()).toBe(applied);
    await expect(runtime.actions.dispatch({ ...transfer, atSimulationS: 1 })).rejects.toMatchObject({ problem: { code: 'ACTION_ID_CONFLICT' } });
    const beforeResetRecord = selectCurrentObservation(applied, ids.flaskId, 'PH')!;
    await runtime.actions.dispatch(action(runtime, 1202, ids.buretteId, 'RESET', { scope: 'STATION' }));
    const reset = runtime.reader.getSnapshot();
    expect(reset.stationStates[ids.stationId]!.epoch).toBe(1);
    expect(reset.scene.containerStates[ids.flaskId]!.volumeL).toBe(0.025);
    expect(reset.observations).toContain(beforeResetRecord);
    expect(await runtime.actions.dispatch(transfer)).toBe(receipt);
    expect(runtime.reader.getSnapshot()).toBe(reset);
    const serialized = serializeLabContract('RuntimeCheckpoint', await runtime.getCheckpoint());
    const restored = await restoreLabRuntime(parseLabJson('RuntimeCheckpoint', serialized), dependencies);
    expect(serializeLabContract('RuntimeSnapshot', restored.reader.getSnapshot())).toBe(serializeLabContract('RuntimeSnapshot', reset));
    expect((await restored.actions.dispatch(transfer)).sequence).toBe(receipt.sequence);
    expect(restored.reader.getSnapshot().scene.containerStates[ids.flaskId]!.volumeL).toBe(0.025);
    runtime.dispose();
    restored.dispose();
  }, 20_000);

  it('rolls back an over-budget tick batch and preserves honest failed science without stale pH', async () => {
    const { scene, ids, runId } = fixture();
    const runtime = await createLabRuntime({
      ...dependencies, initialScene: scene, runId,
      limits: { maxTicks: 1, maxActions: 100, maxObservations: 1000, maxSimulationTimeS: 10 },
    });
    await resume(runtime, ids.stationId, 1300);
    await runtime.actions.dispatch(action(runtime, 1301, ids.buretteId, 'SET_VALVE', { openingFraction: 1 }));
    const before = runtime.reader.getSnapshot();
    await expect(runtime.advanceStation(ids.stationId, 2)).rejects.toMatchObject({ problem: { code: 'LIMIT_EXCEEDED' } });
    expect(runtime.reader.getSnapshot()).toBe(before);
    expect((await runtime.getCheckpoint()).events.some((event) => event.type === 'ADVANCE')).toBe(false);
    runtime.dispose();

    const unsupported = await createLabRuntime({ ...dependencies, initialScene: scene, runId: uuid(1302) });
    const oldPH = selectCurrentObservation(unsupported.reader.getSnapshot(), ids.flaskId, 'PH');
    await unsupported.actions.dispatch(action(unsupported, 1303, ids.flaskId, 'FILL', {
      contents: { ...prepared('hcl', 0.025), species: [{ speciesId: 'unknown:compound', moles: 0.001 }] },
      preparation: { kind: 'EXTERNAL', sourceId: 'test:unsupported' },
    }));
    expect(unsupported.reader.getSnapshot().stationStates[ids.stationId]!.status).toBe('UNSUPPORTED');
    expect(selectCurrentObservation(unsupported.reader.getSnapshot(), ids.flaskId, 'PH')).toBeUndefined();
    expect(unsupported.reader.getSnapshot().observations).toContain(oldPH);
    expect(selectCurrentObservation(unsupported.reader.getSnapshot(), ids.flaskId, 'VOLUME')!.observation.quantity.value).toBe(0.025);
    unsupported.dispose();
  });

  it('reports an empty source as zero and never supplies ambient pH through an unimmersed probe', async () => {
    const setup = fixture();
    const scene = { ...setup.scene, containerStates: {
      ...setup.scene.containerStates, [setup.ids.buretteId]: prepared('naoh', 0.0002),
    } };
    const runtime = await createLabRuntime({ ...dependencies, initialScene: scene, runId: setup.runId });
    expect(selectProbeObservation(runtime.reader.getSnapshot(), setup.ids.probeId)).toBeUndefined();
    await resume(runtime, setup.ids.stationId, 1400);
    await runtime.actions.dispatch(action(runtime, 1401, setup.ids.buretteId, 'SET_VALVE', { openingFraction: 1 }));
    await runtime.advanceStation(setup.ids.stationId, 3);
    expect(selectCurrentObservation(runtime.reader.getSnapshot(), setup.ids.buretteId, 'VOLUME')!.observation.quantity.value).toBe(0);
    expect(selectCurrentObservation(runtime.reader.getSnapshot(), setup.ids.buretteId, 'PH')).toBeUndefined();
    expect(runtime.reader.getSnapshot().apparatusStates[setup.ids.buretteId]!.valveOpeningFraction).toBe(0);
    runtime.dispose();
  });
});
