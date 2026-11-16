import { describe, expect, it } from 'vitest';
import type { LabRuntimeEvent, RuntimeSnapshot } from '@matterlab/contracts';
import { createTransferPresentation, transferPathSupported, transferPointM } from './transfers';
import { fluidScope } from './types';
import { fixture, idleAdvance, transferOperation } from './fixtures.test-support';

describe('accepted-transfer-only presentation', () => {
  it('does not infer flow from an open valve, unchanged totals, or historical initialization', () => {
    const { snapshot, ids } = fixture();
    let now = 0;
    const presentation = createTransferPresentation(snapshot, { nowS: () => now });
    const idle = idleAdvance(snapshot, ids.stationId);
    presentation.ingest(idle.snapshot, idle.event);
    const query = { sourceInstanceId: ids.buretteId, receiverInstanceId: ids.flaskId, scope: fluidScope(idle.snapshot, ids.stationId)! };
    expect(presentation.sample(query).drops).toHaveLength(0);
    const zero = transferOperation(idle.snapshot, 0);
    presentation.ingest(zero.snapshot, zero.advance);
    presentation.ingest(zero.snapshot, zero.transfer);
    now = 0.04;
    expect(presentation.sample({ ...query, scope: fluidScope(zero.snapshot, ids.stationId)! }).acceptedVolumeL).toBe(0);
    const historical = transferOperation(snapshot, 0.001);
    presentation.sync(historical.snapshot);
    presentation.ingest(historical.snapshot, historical.transfer);
    expect(presentation.sample({ ...query, scope: fluidScope(historical.snapshot, ids.stationId)! }).drops).toHaveLength(0);
  });

  it('waits for the applied event even when ADVANCE already exposes the final authoritative totals', () => {
    const { snapshot, ids } = fixture();
    let now = 1;
    const presentation = createTransferPresentation(snapshot, { nowS: () => now });
    const operation = transferOperation(snapshot, 0.0001);
    const query = { sourceInstanceId: ids.buretteId, receiverInstanceId: ids.flaskId, scope: fluidScope(operation.snapshot, ids.stationId)! };
    presentation.ingest(operation.snapshot, operation.advance);
    expect(presentation.sample(query).drops).toHaveLength(0);
    presentation.ingest(operation.snapshot, operation.transfer);
    now += 0.04;
    const sample = presentation.sample(query);
    expect(sample.drops.length).toBeGreaterThan(0);
    expect(sample.acceptedVolumeL).toBeCloseTo(0.0001, 12);
    expect(sample.acceptedFlowLPerS).toBeCloseTo(0.001, 12);
    presentation.ingest(operation.snapshot, operation.transfer);
    expect(presentation.sample(query)).toEqual(sample);
  });

  it('requires both an accepted receipt and a positive conserved ledger delta', () => {
    const { snapshot, ids } = fixture();
    const operation = transferOperation(snapshot, 0.0001);
    const query = { sourceInstanceId: ids.buretteId, receiverInstanceId: ids.flaskId, scope: fluidScope(operation.snapshot, ids.stationId)! };
    const rejected = createTransferPresentation(snapshot, { nowS: () => 0 });
    const event = operation.transfer;
    if (event.type !== 'ACTION') throw new Error('Invalid fixture');
    const rejection: LabRuntimeEvent = {
      ...event, receipt: { ...event.receipt, status: 'REJECTED', error: {
        type: 'urn:test:insufficient-volume', title: 'No transfer', status: 422,
        detail: 'No accepted liquid.', code: 'INSUFFICIENT_VOLUME',
      } },
    };
    rejected.ingest(operation.snapshot, operation.advance);
    rejected.ingest(operation.snapshot, rejection);
    expect(rejected.sample(query).acceptedVolumeL).toBe(0);
    const unchanged = createTransferPresentation(snapshot, { nowS: () => 0 });
    const noAcceptedTotals = { ...operation.snapshot, transferTotals: [] };
    unchanged.ingest(noAcceptedTotals, operation.advance);
    unchanged.ingest(noAcceptedTotals, operation.transfer);
    expect(unchanged.sample(query).drops).toHaveLength(0);
  });

  it('uses the actual delta when a manual request is clipped within the runtime tolerance', () => {
    const { snapshot, ids } = fixture();
    const operation = transferOperation(snapshot, 0.0001);
    const event = operation.transfer;
    if (event.type !== 'ACTION' || event.action.type !== 'TRANSFER') throw new Error('Invalid fixture');
    const clipped: LabRuntimeEvent = {
      ...event, action: { ...event.action, payload: { ...event.action.payload, volumeL: 0.0001 + 5e-13 } },
    };
    const presentation = createTransferPresentation(snapshot, { nowS: () => 0 });
    presentation.ingest(operation.snapshot, operation.advance);
    presentation.ingest(operation.snapshot, clipped);
    expect(presentation.sample({
      sourceInstanceId: ids.buretteId, receiverInstanceId: ids.flaskId, scope: fluidScope(operation.snapshot, ids.stationId)!,
    }).acceptedVolumeL).toBeCloseTo(0.0001, 14);
  });

  it('clears all in-flight drops immediately at a zero-accepted ADVANCE', () => {
    const { snapshot, ids } = fixture();
    let now = 0;
    const presentation = createTransferPresentation(snapshot, { nowS: () => now });
    const operation = transferOperation(snapshot, 0.0001);
    presentation.ingest(operation.snapshot, operation.advance);
    presentation.ingest(operation.snapshot, operation.transfer);
    now = 0.04;
    const query = { sourceInstanceId: ids.buretteId, receiverInstanceId: ids.flaskId, scope: fluidScope(operation.snapshot, ids.stationId)! };
    expect(presentation.sample(query).drops.length).toBeGreaterThan(0);
    const stopped = idleAdvance(operation.snapshot, ids.stationId);
    presentation.ingest(stopped.snapshot, stopped.event);
    expect(presentation.sample({ ...query, scope: fluidScope(stopped.snapshot, ids.stationId)! }).drops).toHaveLength(0);
    expect(presentation.sample(query).drops).toHaveLength(0);
  });

  it('clears on pause and never resumes a previous burst or an old-epoch reset event', () => {
    const { snapshot, ids } = fixture();
    let now = 0;
    const presentation = createTransferPresentation(snapshot, { nowS: () => now });
    const operation = transferOperation(snapshot, 0.0001);
    presentation.ingest(operation.snapshot, operation.advance);
    presentation.ingest(operation.snapshot, operation.transfer);
    let current = operation.snapshot;
    for (const status of ['PAUSED', 'RUNNING'] as const) {
      current = {
        ...current, revision: current.revision + 1, lastSequence: current.lastSequence + 1,
        stationStates: { ...current.stationStates, [ids.stationId]: { ...current.stationStates[ids.stationId]!, status } },
      };
      const type = status === 'PAUSED' ? 'PAUSE' : 'RESUME';
      const controlId = `40000000-0000-4000-8000-${current.lastSequence.toString().padStart(12, '0')}`;
      presentation.ingest(current, {
        type: 'CONTROL', runId: current.runId, stationId: ids.stationId, epoch: 0, sequence: current.lastSequence,
        control: { controlId, stationId: ids.stationId, atSimulationS: 0.1, type, payload: {} },
        receipt: { controlId, stationId: ids.stationId, epoch: 0, sequence: current.lastSequence, runtimeRevision: current.revision, status: 'APPLIED' },
      });
      now += 0.01;
      expect(presentation.sample({ sourceInstanceId: ids.buretteId, receiverInstanceId: ids.flaskId,
        scope: fluidScope(current, ids.stationId)! }).drops).toHaveLength(0);
    }
    const reset: RuntimeSnapshot = {
      ...snapshot, revision: current.revision + 1, lastSequence: current.lastSequence + 1,
      stationStates: { ...snapshot.stationStates, [ids.stationId]: { ...snapshot.stationStates[ids.stationId]!, epoch: 1 } },
    };
    const resetId = '50000000-0000-4000-8000-000000000001';
    presentation.ingest(reset, {
      type: 'ACTION', runId: reset.runId, stationId: ids.stationId, epoch: 0, sequence: reset.lastSequence,
      action: { type: 'RESET', actionId: resetId, targetInstanceId: ids.buretteId, atSimulationS: 0.1, payload: { scope: 'STATION' } },
      receipt: { actionId: resetId, status: 'APPLIED', stationId: ids.stationId, epoch: 0, sequence: reset.lastSequence, runtimeRevision: reset.revision },
    });
    presentation.ingest(operation.snapshot, operation.transfer);
    expect(presentation.sample({ sourceInstanceId: ids.buretteId, receiverInstanceId: ids.flaskId,
      scope: fluidScope(reset, ids.stationId)! }).drops).toHaveLength(0);
  });

  it('does not show flow for an empty source or full receiver with an open valve and zero accepted transfer', () => {
    const { snapshot, ids } = fixture();
    for (const states of [
      { ...snapshot.scene.containerStates, [ids.buretteId]: { ...snapshot.scene.containerStates[ids.buretteId]!, volumeL: 0 } },
      { ...snapshot.scene.containerStates, [ids.flaskId]: { ...snapshot.scene.containerStates[ids.flaskId]!, volumeL: 0.25 } },
    ]) {
      const baseline = { ...snapshot, scene: { ...snapshot.scene, containerStates: states } };
      const presentation = createTransferPresentation(baseline, { nowS: () => 0 });
      const operation = idleAdvance(baseline, ids.stationId);
      presentation.ingest(operation.snapshot, operation.event);
      expect(presentation.sample({ sourceInstanceId: ids.buretteId, receiverInstanceId: ids.flaskId,
        scope: fluidScope(operation.snapshot, ids.stationId)! }).drops).toHaveLength(0);
    }
  });

  it('keeps station scopes isolated and rejects wrong run, epoch and future view cursors', () => {
    const { snapshot, ids } = fixture();
    const presentation = createTransferPresentation(snapshot, { nowS: () => 0.01 });
    const operation = transferOperation(snapshot, 0.0001);
    presentation.ingest(operation.snapshot, operation.advance);
    presentation.ingest(operation.snapshot, operation.transfer);
    const other = idleAdvance(operation.snapshot, ids.blankStationId);
    presentation.ingest(other.snapshot, other.event);
    const query = { sourceInstanceId: ids.buretteId, receiverInstanceId: ids.flaskId, scope: fluidScope(other.snapshot, ids.stationId)! };
    expect(presentation.sample(query).drops.length).toBeGreaterThan(0);
    for (const scope of [
      { ...query.scope, runId: 'another-run' },
      { ...query.scope, stationId: ids.blankStationId },
      { ...query.scope, epoch: 1 },
      { ...query.scope, lastSequence: other.snapshot.lastSequence + 1 },
      { ...query.scope, lastSequence: 0 },
    ]) expect(presentation.sample({ ...query, scope }).drops).toHaveLength(0);
    expect(presentation.sample(query).drops.length).toBeGreaterThan(0);
  });

  it('reduces presentation density, suppresses reduced motion and cannot replay suppressed transfers', () => {
    const { snapshot, ids } = fixture();
    let now = 0;
    const presentation = createTransferPresentation(snapshot, { nowS: () => now });
    const operation = transferOperation(snapshot, 0.001);
    presentation.ingest(operation.snapshot, operation.advance);
    presentation.ingest(operation.snapshot, operation.transfer);
    now = 0.1;
    const query = { sourceInstanceId: ids.buretteId, receiverInstanceId: ids.flaskId, scope: fluidScope(operation.snapshot, ids.stationId)! };
    expect(presentation.sample({ ...query, settings: { quality: 'high' } }).drops).toHaveLength(48);
    const low = presentation.sample({ ...query, settings: { lowPower: true } });
    expect(low.drops.length).toBeLessThanOrEqual(8);
    expect(low.pouring).toBe(false);
    expect(presentation.sample({ ...query, settings: { reducedMotion: true } }).drops).toHaveLength(0);
    expect(presentation.sample(query).drops).toHaveLength(0);
    presentation.setMotionEnabled(false);
    const suppressed = transferOperation(operation.snapshot, 0.0001);
    presentation.ingest(suppressed.snapshot, suppressed.advance);
    presentation.ingest(suppressed.snapshot, suppressed.transfer);
    presentation.setMotionEnabled(true);
    expect(presentation.sample({ ...query, scope: fluidScope(suppressed.snapshot, ids.stationId)! }).drops).toHaveLength(0);
  });

  it('accumulates small accepted amounts without queuing fake drops or replaying background time', () => {
    const { snapshot, ids } = fixture();
    let now = 0;
    let current = snapshot;
    const presentation = createTransferPresentation(snapshot, { nowS: () => now });
    for (let i = 0; i < 5; i++) {
      const operation = transferOperation(current, 0.000002);
      current = operation.snapshot;
      presentation.ingest(current, operation.advance);
      presentation.ingest(current, operation.transfer);
      const sample = presentation.sample({ sourceInstanceId: ids.buretteId, receiverInstanceId: ids.flaskId, scope: fluidScope(current, ids.stationId)! });
      expect(sample.drops.length).toBe(i === 4 ? 1 : 0);
      now += 0.1;
    }
    now += 60;
    expect(presentation.sample({ sourceInstanceId: ids.buretteId, receiverInstanceId: ids.flaskId,
      scope: fluidScope(current, ids.stationId)! }).drops).toHaveLength(0);
    presentation.dispose();
    const late = transferOperation(current, 0.0001);
    presentation.ingest(late.snapshot, late.transfer);
    expect(presentation.sample({ sourceInstanceId: ids.buretteId, receiverInstanceId: ids.flaskId,
      scope: fluidScope(late.snapshot, ids.stationId)! }).drops).toHaveLength(0);
  });

  it('restricts illustrative paths to bounded downhill transfers with exact endpoint positions', () => {
    expect(transferPathSupported([0, 1.18, 0], [0, 1.15, 0])).toBe(true);
    expect(transferPathSupported([0, 1, 0], [0, 2, 0])).toBe(false);
    expect(transferPathSupported([0, 1, 0], [0, 1, 0])).toBe(false);
    expect(transferPathSupported([0, 5, 0], [0, 0, 0])).toBe(false);
    expect(transferPointM([0, 1, 0], [0.1, 0.9, 0], 0)).toEqual([0, 1, 0]);
    expect(transferPointM([0, 1, 0], [0.1, 0.9, 0], 1)).toEqual([0.1, 0.9, 0]);
  });
});
