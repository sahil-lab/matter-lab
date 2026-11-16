import type { ContainerContents, LabAction, ObservationRecord, RuntimeSnapshot } from '@matterlab/contracts';
import { DEFAULT_ASSUMPTIONS, prepareSolution, solveEquilibrium } from '@matterlab/lab-science';
import { apparatusRegistry } from '../apparatus/registry.ts';
import { createEmptyHarness } from './test-fixtures.ts';
import type { ChallengeMode } from './types.ts';

/**
 * Test-only canonical event fixture, not a production reducer or an integration-test runtime.
 * Chemistry quantities are actual Agent06 solver outputs. APPLIED receipts are injected fixtures.
 */
export function recordedTrialFixture(mode: ChallengeMode = 'precision') {
  const harness = createEmptyHarness(mode);
  const { reader, controller, ids, makeId, aliquot, titrant, truth } = harness;
  const emptyScene = reader.snapshot.scene;
  const emitAction = (action: LabAction, changes: Partial<RuntimeSnapshot> = {}) => {
    const sequence = reader.snapshot.lastSequence + 1;
    const snapshot = { ...reader.snapshot, ...changes, lastSequence: sequence, revision: reader.snapshot.revision + 1 };
    reader.emit(snapshot, {
      type: 'ACTION', action, runId: snapshot.runId, stationId: ids.stationId,
      epoch: snapshot.stationStates[ids.stationId]!.epoch, sequence,
      receipt: {
        status: 'APPLIED', actionId: action.actionId, stationId: ids.stationId,
        epoch: snapshot.stationStates[ids.stationId]!.epoch, sequence, runtimeRevision: snapshot.revision,
      },
    });
  };
  const actionBase = (targetInstanceId: string) => ({
    actionId: makeId(), targetInstanceId, atSimulationS: 0, expectedEpoch: reader.snapshot.stationStates[ids.stationId]!.epoch,
  });
  function observe(apparatusId = ids.flaskId, claimedEvidence?: ObservationRecord['observation']['evidence']): ObservationRecord {
    const snapshot = reader.snapshot;
    const contents = snapshot.scene.containerStates[apparatusId]!;
    const solved = solveEquilibrium({ contents, methodId: truth.methodId, assumptions: DEFAULT_ASSUMPTIONS });
    if (solved.status !== 'SUCCEEDED') throw new Error(`Unsupported scientific fixture: ${solved.error.detail}`);
    const total = snapshot.transferTotals.find((entry) => entry.receiverInstanceId === apparatusId);
    const sequence = snapshot.lastSequence + 1;
    const record: ObservationRecord = {
      id: makeId(), runId: snapshot.runId, stationId: ids.stationId,
      epoch: snapshot.stationStates[ids.stationId]!.epoch, sequence,
      observation: {
        type: 'PH', apparatusId, stationId: ids.stationId, timeS: 0,
        quantity: solved.pH, evidence: claimedEvidence ?? solved.evidence,
        methodId: solved.methodId, methodVersion: solved.methodVersion, sourceIds: solved.sourceIds,
        ...(apparatusId === ids.flaskId ? {
          titration: total ?? { sourceInstanceId: ids.buretteId, receiverInstanceId: ids.flaskId, deliveredVolumeL: 0 },
        } : {}),
      },
    };
    reader.emit({ ...snapshot, lastSequence: sequence, observations: [...snapshot.observations, record] }, {
      type: 'OBSERVATIONS', runId: snapshot.runId, stationId: ids.stationId, epoch: record.epoch, sequence, observations: [record],
    });
    return record;
  }
  function prepare(connectProbe = true) {
    const snapshot = reader.snapshot;
    const probe = snapshot.scene.apparatus.find((instance) => instance.id === ids.probeId)!;
    const receiver = snapshot.scene.apparatus.find((instance) => instance.id === ids.flaskId)!;
    const probeSocket = apparatusRegistry.getDefinition(probe.definitionId)!.sockets.find((socket) => socket.kind === 'SENSOR')!;
    const receiverDefinition = apparatusRegistry.getDefinition(receiver.definitionId)!;
    const receiverSocket = receiverDefinition.sockets.find((socket) => socket.kind === 'SENSOR')!;
    const tipY = receiverDefinition.vesselCalibration!.interiorProfile[0]!.yM + 0.001;
    const transform = {
      positionM: [
        receiver.transform.positionM[0] - probeSocket.localTransform.positionM[0],
        receiver.transform.positionM[1] + tipY - probeSocket.localTransform.positionM[1],
        receiver.transform.positionM[2] - probeSocket.localTransform.positionM[2],
      ] as const, quaternion: [0, 0, 0, 1] as const,
    };
    emitAction({ ...actionBase(ids.probeId), type: 'MOVE', payload: { transform } }, {
      scene: { ...snapshot.scene, apparatus: snapshot.scene.apparatus.map((instance) => instance.id === ids.probeId ? { ...instance, transform } : instance) },
    });
    const connection = {
      id: makeId(), kind: 'SENSOR' as const, enabled: true,
      from: { instanceId: ids.probeId, socketId: probeSocket.id }, to: { instanceId: ids.flaskId, socketId: receiverSocket.id },
    };
    emitAction({ ...actionBase(ids.probeId), type: 'ATTACH', payload: { connection } }, {
      scene: { ...reader.snapshot.scene, connections: [...reader.snapshot.scene.connections, connection] },
    });
    for (const [id, contents, sourceId] of [[ids.flaskId, aliquot.contents, 'hcl'], [ids.buretteId, titrant.contents, 'naoh']] as const) {
      emitAction({ ...actionBase(id), type: 'FILL', payload: { contents, preparation: { kind: 'INITIAL', sourceId } } }, {
        scene: { ...reader.snapshot.scene, containerStates: { ...reader.snapshot.scene.containerStates, [id]: contents } },
      });
    }
    if (connectProbe) {
      emitAction({ ...actionBase(ids.probeId), type: 'SET_PROBE', payload: { containerInstanceId: ids.flaskId } }, {
        apparatusStates: { ...reader.snapshot.apparatusStates, [ids.probeId]: { probe: { containerInstanceId: ids.flaskId } } },
      });
    }
    observe();
    emitAction({ ...actionBase(ids.buretteId), type: 'SET_VALVE', payload: { openingFraction: 1 } }, {
      apparatusStates: { ...reader.snapshot.apparatusStates, [ids.buretteId]: { valveOpeningFraction: 1, deliveredVolumeL: 0 } },
    });
  }
  function deliver(cumulativeVolumeL: number) {
    const previous = reader.snapshot.transferTotals.find((entry) => entry.sourceInstanceId === ids.buretteId)?.deliveredVolumeL ?? 0;
    const delivered = prepareSolution({ reagentId: 'naoh', volumeL: cumulativeVolumeL, concentrationMolL: 0.1 });
    const remaining = prepareSolution({ reagentId: 'naoh', volumeL: 0.05 - cumulativeVolumeL, concentrationMolL: 0.1 });
    if (delivered.status !== 'SUCCEEDED' || remaining.status !== 'SUCCEEDED') throw new Error('Invalid test preparation.');
    const receiver: ContainerContents = {
      ...aliquot.contents, volumeL: aliquot.contents.volumeL + delivered.contents.volumeL,
      species: [...aliquot.contents.species, ...delivered.contents.species],
    };
    const connection = reader.snapshot.scene.connections.find((edge) => edge.kind === 'FLUID' && edge.from.instanceId === ids.buretteId)!;
    const total = { sourceInstanceId: ids.buretteId, receiverInstanceId: ids.flaskId, deliveredVolumeL: cumulativeVolumeL };
    emitAction({
      ...actionBase(ids.buretteId), type: 'TRANSFER',
      payload: { sourceInstanceId: ids.buretteId, targetInstanceId: ids.flaskId, volumeL: cumulativeVolumeL - previous, connectionId: connection.id },
    }, {
      scene: { ...reader.snapshot.scene, containerStates: { ...reader.snapshot.scene.containerStates, [ids.flaskId]: receiver, [ids.buretteId]: remaining.contents } },
      transferTotals: [total],
      apparatusStates: { ...reader.snapshot.apparatusStates, [ids.buretteId]: { ...reader.snapshot.apparatusStates[ids.buretteId], deliveredVolumeL: cumulativeVolumeL } },
    });
    return observe();
  }
  function close() {
    emitAction({ ...actionBase(ids.buretteId), type: 'SET_VALVE', payload: { openingFraction: 0 } }, {
      apparatusStates: { ...reader.snapshot.apparatusStates, [ids.buretteId]: { ...reader.snapshot.apparatusStates[ids.buretteId], valveOpeningFraction: 0 } },
    });
    const receiver = observe();
    observe(ids.buretteId);
    return receiver;
  }
  function capture(record: ObservationRecord, readingVolumeL = record.observation.titration!.deliveredVolumeL) {
    const reading = controller.recordReading(record.id, readingVolumeL);
    if (!reading.ok) throw new Error(reading.reason);
    return controller.captureEndpoint({ observationId: record.id, basis: 'instrument-reading' });
  }
  function conclude(position: 'before' | 'within' | 'after' = 'within') {
    const trial = controller.getSnapshot().trial;
    return controller.recordConclusion({
      text: 'The endpoint is an operational observation compared with the supplied model equivalence volume. These simulated data do not establish physical measurement uncertainty.',
      citedObservationIds: [trial.endpoint!.observationId], equivalenceAndEndpoint: 'distinct', endpointPosition: position,
      concentration: truth.initialConcentration, acknowledgesModelLimits: true,
    });
  }
  function reset() {
    const snapshot = reader.snapshot;
    const prior = snapshot.stationStates[ids.stationId]!;
    const action: LabAction = { ...actionBase(ids.buretteId), type: 'RESET', payload: { scope: 'STATION' } };
    const sequence = snapshot.lastSequence + 1;
    reader.emit({
      ...snapshot, scene: emptyScene, revision: snapshot.revision + 1, lastSequence: sequence,
      stationStates: { ...snapshot.stationStates, [ids.stationId]: { ...prior, epoch: prior.epoch + 1, simulationTimeS: 0, tick: 0, status: 'PREPARING' } },
      apparatusStates: {}, transferTotals: [], observations: [],
    }, {
      type: 'ACTION', runId: snapshot.runId, stationId: ids.stationId, epoch: prior.epoch, sequence, action,
      receipt: { status: 'APPLIED', actionId: action.actionId, stationId: ids.stationId, epoch: prior.epoch, sequence, runtimeRevision: snapshot.revision + 1 },
    });
  }
  return { ...harness, prepare, deliver, close, observe, capture, conclude, reset };
}
