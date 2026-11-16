import type { LabRuntimeEvent, ObservationRecord, RuntimeSnapshot } from '@matterlab/contracts';
import { createTitrationSetup } from '../apparatus/seeds';

export function fixture() {
  let id = 0;
  const { scene, ids } = createTitrationSetup('test:visual-fixture-not-science', () =>
    `00000000-0000-4000-8000-${(++id).toString().padStart(12, '0')}`);
  const snapshot: RuntimeSnapshot = {
    schemaVersion: 1, runId: '10000000-0000-4000-8000-000000000001', revision: 0,
    scene: {
      ...scene,
      containerStates: {
        [ids.buretteId]: { volumeL: 0.05, species: [], temperatureK: 298.15, mixing: 'WELL_MIXED', modelId: 'test:visual-fixture-not-science' },
        [ids.flaskId]: { volumeL: 0.025, species: [], temperatureK: 298.15, mixing: 'WELL_MIXED', modelId: 'test:visual-fixture-not-science' },
      },
    },
    stationStates: {
      [ids.stationId]: { stationId: ids.stationId, epoch: 0, status: 'RUNNING', simulationTimeS: 0, tick: 0, speed: 1 },
      [ids.blankStationId]: { stationId: ids.blankStationId, epoch: 0, status: 'PREPARING', simulationTimeS: 0, tick: 0, speed: 1 },
    },
    apparatusStates: { [ids.buretteId]: { valveOpeningFraction: 1, deliveredVolumeL: 0 } },
    transferTotals: [], observations: [], lastSequence: 0,
  };
  return { snapshot, ids };
}

export function transferOperation(before: RuntimeSnapshot, volumeL: number) {
  const edge = before.scene.connections.find((connection) => connection.kind === 'FLUID')!;
  const source = before.scene.apparatus.find((instance) => instance.id === edge.from.instanceId)!;
  const receiver = before.scene.apparatus.find((instance) => instance.id === edge.to.instanceId)!;
  const station = before.stationStates[source.stationId]!;
  const sourceContents = before.scene.containerStates[source.id]!;
  const receiverContents = before.scene.containerStates[receiver.id]!;
  const cumulative = before.transferTotals.find((total) => total.sourceInstanceId === source.id && total.receiverInstanceId === receiver.id);
  const snapshot: RuntimeSnapshot = {
    ...before, revision: before.revision + 1, lastSequence: before.lastSequence + 2,
    stationStates: {
      ...before.stationStates,
      [station.stationId]: { ...station, simulationTimeS: station.simulationTimeS + 0.1, tick: station.tick + 1 },
    },
    scene: { ...before.scene, containerStates: {
      ...before.scene.containerStates,
      [source.id]: { ...sourceContents, volumeL: sourceContents.volumeL - volumeL },
      [receiver.id]: { ...receiverContents, volumeL: receiverContents.volumeL + volumeL },
    } },
    apparatusStates: { ...before.apparatusStates, [source.id]: {
      ...before.apparatusStates[source.id], deliveredVolumeL: (before.apparatusStates[source.id]?.deliveredVolumeL ?? 0) + volumeL,
    } },
    transferTotals: [{ sourceInstanceId: source.id, receiverInstanceId: receiver.id, deliveredVolumeL: (cumulative?.deliveredVolumeL ?? 0) + volumeL }],
  };
  const advance: LabRuntimeEvent = {
    type: 'ADVANCE', runId: before.runId, stationId: station.stationId, epoch: station.epoch,
    sequence: before.lastSequence + 1, fromSimulationS: station.simulationTimeS, toSimulationS: station.simulationTimeS + 0.1, ticks: 1,
  };
  const actionId = `20000000-0000-4000-8000-${snapshot.lastSequence.toString().padStart(12, '0')}`;
  const transfer: LabRuntimeEvent = {
    type: 'ACTION', runId: before.runId, stationId: station.stationId, epoch: station.epoch, sequence: snapshot.lastSequence,
    action: {
      actionId, type: 'TRANSFER', targetInstanceId: source.id, atSimulationS: station.simulationTimeS + 0.1,
      payload: { sourceInstanceId: source.id, targetInstanceId: receiver.id, connectionId: edge.id, volumeL },
    },
    receipt: { status: 'APPLIED', actionId, sequence: snapshot.lastSequence, runtimeRevision: snapshot.revision, stationId: station.stationId, epoch: station.epoch },
  };
  return { snapshot, advance, transfer, source, receiver };
}

export function idleAdvance(before: RuntimeSnapshot, stationId: string) {
  const station = before.stationStates[stationId]!;
  const snapshot: RuntimeSnapshot = {
    ...before, revision: before.revision + 1, lastSequence: before.lastSequence + 1,
    stationStates: { ...before.stationStates, [stationId]: { ...station, simulationTimeS: station.simulationTimeS + 0.1, tick: station.tick + 1 } },
  };
  const event: LabRuntimeEvent = {
    type: 'ADVANCE', runId: before.runId, stationId, epoch: station.epoch, sequence: snapshot.lastSequence,
    fromSimulationS: station.simulationTimeS, toSimulationS: station.simulationTimeS + 0.1, ticks: 1,
  };
  return { snapshot, event };
}

export function observationsFor(snapshot: RuntimeSnapshot, apparatusId: string, sequence = 10): readonly ObservationRecord[] {
  const instance = snapshot.scene.apparatus.find((item) => item.id === apparatusId)!;
  const station = snapshot.stationStates[instance.stationId]!;
  const scope = { runId: snapshot.runId, stationId: instance.stationId, epoch: station.epoch, sequence };
  const common = { apparatusId, stationId: instance.stationId, timeS: station.simulationTimeS, methodId: 'test:recorded-result', methodVersion: '1', sourceIds: ['test:source'] };
  return [
    { ...scope, id: '30000000-0000-4000-8000-000000000001', observation: {
      ...common, type: 'PH', quantity: { value: 8.2, unit: 'pH' }, evidence: 'MODEL_CALCULATED',
    } },
    { ...scope, id: '30000000-0000-4000-8000-000000000002', observation: {
      ...common, type: 'INDICATOR', quantity: { value: 0.35, unit: '1' }, evidence: 'MODEL_CALCULATED',
      indicatorId: 'test:indicator', indicatorState: {
        indicatorId: 'test:indicator', baseFraction: 0.35, colorSrgb: [0.91, 0.42, 0.63],
        colorEvidence: 'ILLUSTRATIVE', sourceIds: ['test:source'],
      },
    } },
  ];
}
