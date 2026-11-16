import type { LabAction, LabActionPayloads, LabActionType } from '@matterlab/contracts';
import { SCIENCE_METHOD_ID } from '@matterlab/lab-science';
import { describe, expect, it } from 'vitest';
import { createStandardLabRuntime, isProbeImmersed, restoreLabRuntime, standardRuntimeDependencies } from '../../../../../packages/lab-runtime/src/index.ts';
import { apparatusRegistry } from '../apparatus/registry.ts';
import { createTitrationSetup } from '../apparatus/seeds.ts';
import { createChallengeController } from './controller.ts';
import { TITRATION_CHALLENGE } from './definition.ts';
import { buildTrialNotebook, compareTrialPair } from './notebook.ts';
import { parseLearningStateJson, serializeLearningState } from './persistence.ts';
import { evaluateTrial } from './scoring.ts';
import { idFactory, preparedReference } from './test-fixtures.ts';
import type { ChallengeMode } from './types.ts';

async function realHarness(mode: ChallengeMode = 'guided') {
  const makeId = idFactory();
  const { scene, ids } = createTitrationSetup(SCIENCE_METHOD_ID, makeId);
  const runtime = await createStandardLabRuntime({ initialScene: scene, runId: makeId(), definitions: apparatusRegistry });
  const { reference, aliquot, titrant, truth } = preparedReference();
  const options = {
    reader: runtime.reader, definitions: apparatusRegistry, definition: TITRATION_CHALLENGE,
    stationId: ids.stationId, reference, mode, createId: makeId, now: () => '2026-11-16T16:00:00.000Z',
    bindings: { stand: ids.standId, clamp: ids.clampId, burette: ids.buretteId, receiver: ids.flaskId, probe: ids.probeId },
    getSupport: () => runtime.getModelSupport(ids.stationId),
  };
  const controller = createChallengeController(options);
  async function dispatch<Type extends LabActionType>(targetInstanceId: string, type: Type, payload: LabActionPayloads[Type]) {
    const station = runtime.reader.getSnapshot().stationStates[ids.stationId]!;
    const action = {
      actionId: makeId(), atSimulationS: station.simulationTimeS, targetInstanceId, type, payload, expectedEpoch: station.epoch,
    } as LabAction;
    const receipt = await runtime.actions.dispatch(action);
    if (receipt.status !== 'APPLIED') throw new Error(`${type}: ${receipt.error.detail}`);
    return { action, receipt };
  }
  async function prepare() {
    await dispatch(ids.flaskId, 'FILL', { contents: aliquot.contents, preparation: { kind: 'INITIAL', sourceId: 'hcl' } });
    await dispatch(ids.buretteId, 'FILL', { contents: titrant.contents, preparation: { kind: 'INITIAL', sourceId: 'naoh' } });
    const current = runtime.reader.getSnapshot();
    const receiver = current.scene.apparatus.find((instance) => instance.id === ids.flaskId)!;
    const probe = current.scene.apparatus.find((instance) => instance.id === ids.probeId)!;
    const receiverDefinition = apparatusRegistry.getDefinition(receiver.definitionId)!;
    const sensorSocket = receiverDefinition.sockets.find((socket) => socket.kind === 'SENSOR')!;
    const tipSocket = apparatusRegistry.getDefinition(probe.definitionId)!.sockets.find((socket) => socket.kind === 'SENSOR')!;
    const tipLocalY = receiverDefinition.vesselCalibration!.interiorProfile[0]!.yM + 0.001;
    const transform = {
      positionM: [receiver.transform.positionM[0], receiver.transform.positionM[1] + tipLocalY - tipSocket.localTransform.positionM[1], receiver.transform.positionM[2]] as const,
      quaternion: [0, 0, 0, 1] as const,
    };
    await dispatch(ids.probeId, 'MOVE', { transform });
    await dispatch(ids.probeId, 'ATTACH', { connection: {
      id: makeId(), kind: 'SENSOR', enabled: true,
      from: { instanceId: ids.probeId, socketId: tipSocket.id }, to: { instanceId: ids.flaskId, socketId: sensorSocket.id },
    } });
    expect(isProbeImmersed(runtime.reader.getSnapshot(), ids.probeId, ids.flaskId, apparatusRegistry)).toBe(true);
    await dispatch(ids.probeId, 'SET_PROBE', { containerInstanceId: ids.flaskId });
    await dispatch(ids.buretteId, 'SET_VALVE', { openingFraction: 1 });
  }
  async function resume() {
    const station = runtime.reader.getSnapshot().stationStates[ids.stationId]!;
    const result = await runtime.actions.control({
      controlId: makeId(), stationId: ids.stationId, expectedEpoch: station.epoch,
      atSimulationS: station.simulationTimeS, type: 'RESUME', payload: {},
    });
    if (result.status !== 'APPLIED') throw new Error(result.error.detail);
  }
  function currentPH() {
    const snapshot = runtime.reader.getSnapshot();
    return snapshot.observations.filter((record) => record.runId === snapshot.runId && record.stationId === ids.stationId &&
      record.epoch === snapshot.stationStates[ids.stationId]!.epoch && record.observation.type === 'PH' &&
      record.observation.apparatusId === ids.flaskId).at(-1)!;
  }
  async function closeAndCapture() {
    await dispatch(ids.buretteId, 'SET_VALVE', { openingFraction: 0 });
    const record = currentPH();
    expect(controller.recordReading(record.id, record.observation.titration!.deliveredVolumeL).ok).toBe(true);
    const captured = controller.captureEndpoint({ observationId: record.id, basis: 'instrument-reading' });
    expect(captured, captured.reason).toMatchObject({ ok: true });
    return record;
  }
  function conclude(position: 'before' | 'within' | 'after' = 'within') {
    const record = controller.getSnapshot().trial.endpoint!;
    expect(controller.recordConclusion({
      text: 'The recorded endpoint is an operational choice, compared with the supplied equivalence reference. Repeated model outputs alone do not establish physical uncertainty.',
      citedObservationIds: [record.observationId], equivalenceAndEndpoint: 'distinct', endpointPosition: position,
      concentration: truth.initialConcentration, acknowledgesModelLimits: true,
    }).ok).toBe(true);
  }
  const dispose = () => { controller.dispose(); runtime.dispose(); };
  return { runtime, controller, options, ids, reference, dispatch, prepare, resume, currentPH, closeAndCapture, conclude, dispose };
}

describe('actual Agent07/Agent06 runtime-to-learning integration', () => {
  it('scores accepted 250-tick delivery, freezes capture, and reproduces scores from verified checkpoint plus JSON restore', async () => {
    const started = performance.now();
    const mark = (stage: string) => console.info(`learning integration ${stage}: ${Math.round(performance.now() - started)} ms`);
    const harness = await realHarness();
    mark('created');
    try {
      await harness.prepare();
      await harness.resume();
      mark('prepared');
      let notifications = 0;
      const unsubscribe = harness.controller.subscribe(() => { notifications++; });
      await harness.runtime.advanceStation(harness.ids.stationId, 250);
      mark('advanced');
      unsubscribe();
      expect(notifications).toBe(1);
      expect(harness.controller.getSnapshot().trial.appliedEvents.filter((event) => event.action.type === 'TRANSFER')).toHaveLength(250);
      const record = await harness.closeAndCapture();
      mark('captured');
      expect(record.observation.quantity.value).toBeCloseTo(7, 6);
      expect(record.observation.titration!.deliveredVolumeL).toBeCloseTo(0.025, 12);
      harness.conclude();
      expect(harness.controller.getSnapshot().evaluation.score.complete).toBe(true);
      const attempt = harness.controller.exportAttempt();
      const persisted = serializeLearningState({ schemaVersion: 1, kind: 'MATTERLAB_LEARNING_STATE', attempts: [attempt] });
      mark('serialized');
      const checkpoint = await harness.runtime.getCheckpoint();
      mark('checkpoint');
      const restoredRuntime = await restoreLabRuntime(checkpoint, standardRuntimeDependencies(apparatusRegistry));
      mark('runtime restored');
      const restored = createChallengeController({
        ...harness.options, reader: restoredRuntime.reader,
        getSupport: () => restoredRuntime.getModelSupport(harness.ids.stationId),
        attempt: parseLearningStateJson(persisted).attempts[0],
      });
      mark('controller restored');
      try {
        expect(restored.getSnapshot().evaluation).toEqual(harness.controller.getSnapshot().evaluation);
        expect(restored.exportAttempt().trials[0]!.observations).toEqual(attempt.trials[0]!.observations);
        const replayed = checkpoint.events.find((event) => event.type === 'ACTION' && event.action.type === 'SET_VALVE');
        if (!replayed || replayed.type !== 'ACTION') throw new Error('Expected a real accepted valve action.');
        await restoredRuntime.actions.dispatch(replayed.action);
        expect(restored.exportAttempt()).toEqual(attempt);
      } finally { restored.dispose(); restoredRuntime.dispose(); }
    } finally { harness.dispose(); }
  }, 120_000);

  it('refuses an old near-equivalence sample after a real overshoot and records the poorer accuracy honestly', async () => {
    const harness = await realHarness();
    try {
      await harness.prepare();
      await harness.resume();
      const edge = harness.runtime.reader.getSnapshot().scene.connections.find((connection) => connection.kind === 'FLUID' && connection.from.instanceId === harness.ids.buretteId)!;
      const transfer = async (volumeL: number) => harness.dispatch(harness.ids.buretteId, 'TRANSFER', {
        sourceInstanceId: harness.ids.buretteId, targetInstanceId: harness.ids.flaskId, volumeL, connectionId: edge.id,
      });
      await transfer(0.025);
      const earlier = harness.currentPH();
      await transfer(0.001);
      await harness.dispatch(harness.ids.buretteId, 'SET_VALVE', { openingFraction: 0 });
      expect(harness.controller.captureEndpoint({ observationId: earlier.id, basis: 'instrument-reading' }).ok).toBe(false);
      await harness.closeAndCapture();
      harness.conclude('after');
      const view = harness.controller.getSnapshot();
      expect(view.evaluation.endpointPosition).toBe('after');
      expect(view.evaluation.score.complete).toBe(false);
      expect(view.evaluation.goals.find((goal) => goal.id === 'target')?.state).toBe('pending');
    } finally { harness.dispose(); }
  }, 120_000);

  it('uses the actual current probe binding, not an old SET_PROBE receipt after the tip leaves the liquid', async () => {
    const harness = await realHarness();
    try {
      await harness.prepare();
      const probe = harness.runtime.reader.getSnapshot().scene.apparatus.find((instance) => instance.id === harness.ids.probeId)!;
      await harness.dispatch(harness.ids.probeId, 'MOVE', { transform: {
        ...probe.transform, positionM: [probe.transform.positionM[0], probe.transform.positionM[1] + 0.1, probe.transform.positionM[2]],
      } });
      expect(isProbeImmersed(harness.runtime.reader.getSnapshot(), harness.ids.probeId, harness.ids.flaskId, apparatusRegistry)).toBe(false);
      expect(harness.runtime.reader.getSnapshot().apparatusStates[harness.ids.probeId]?.probe?.containerInstanceId).toBeNull();
      await harness.resume();
      await harness.runtime.advanceStation(harness.ids.stationId, 1);
      await harness.dispatch(harness.ids.buretteId, 'SET_VALVE', { openingFraction: 0 });
      expect(harness.controller.captureEndpoint({ observationId: harness.currentPH().id, basis: 'instrument-reading' }).ok).toBe(false);
      expect(harness.controller.getSnapshot().evaluation.goals.find((goal) => goal.id === 'probe')?.state).toBe('pending');
    } finally { harness.dispose(); }
  }, 120_000);

  it('preserves three real independent reset trials and computes reproducible descriptive statistics', async () => {
    const harness = await realHarness('precision');
    try {
      for (const [index, volumeL] of [0.0249, 0.025, 0.0251].entries()) {
        if (index) await harness.dispatch(harness.ids.buretteId, 'RESET', { scope: 'STATION' });
        await harness.prepare();
        await harness.resume();
        const edge = harness.runtime.reader.getSnapshot().scene.connections.find((connection) => connection.kind === 'FLUID' && connection.from.instanceId === harness.ids.buretteId)!;
        await harness.dispatch(harness.ids.buretteId, 'TRANSFER', {
          sourceInstanceId: harness.ids.buretteId, targetInstanceId: harness.ids.flaskId, volumeL, connectionId: edge.id,
        });
        await harness.closeAndCapture();
        harness.conclude();
      }
      const view = harness.controller.getSnapshot();
      expect(view.attempt.trials.map((trial) => trial.scope.epoch)).toEqual([0, 1, 2]);
      expect(view.evaluation.statistics.count).toBe(3);
      expect(view.evaluation.statistics.meanVolumeL).toBeCloseTo(0.025, 12);
      expect(view.evaluation.statistics.sampleStandardDeviationL).toBeCloseTo(0.0001, 12);
      expect(view.evaluation.score.complete).toBe(true);
      const first = view.attempt.trials[0]!;
      const firstScore = evaluateTrial(view.attempt, first.id);
      expect(compareTrialPair(view.attempt, first.id, view.trial.id).comparable).toBe(true);
      const notebook = buildTrialNotebook(harness.controller.exportAttempt());
      expect(notebook.rows).toHaveLength(3);
      harness.controller.setInstructionIndex(0);
      expect(evaluateTrial(harness.controller.exportAttempt(), first.id)).toEqual(firstScore);
      expect(harness.controller.beginTrial().ok).toBe(false);
      expect(harness.controller.getSnapshot().evaluation.statistics.count).toBe(3);
    } finally { harness.dispose(); }
  }, 120_000);
});
