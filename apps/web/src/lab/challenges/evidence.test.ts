import type { LabAction, LabRuntimeEvent, ObservationRecord, RuntimeSnapshot } from '@matterlab/contracts';
import { describe, expect, it } from 'vitest';
import { createChallengeController } from './controller.ts';
import { assessConnection, definitionReader, trialGraphIssues } from './graph.ts';
import { createGuidedTemplate, trialPlotPoints, trialReplayFrames } from './notebook.ts';
import { evaluatePredicate } from './predicates.ts';
import { createEmptyHarness } from './test-fixtures.ts';

describe('receipt and graph false-positive guards', () => {
  it('never treats a plausible reference pH or claimed tally as an endpoint without applied delivery evidence', () => {
    const { controller, reader, ids, makeId, truth } = createEmptyHarness();
    // Deliberately forged input: a reference target is not an actual runtime observation.
    const claimedRecord: ObservationRecord = {
      id: makeId(), runId: reader.snapshot.runId, stationId: ids.stationId, epoch: 0, sequence: 1,
      observation: {
        type: 'PH', apparatusId: ids.flaskId, stationId: ids.stationId, timeS: 0,
        quantity: truth.equivalencePH, evidence: 'MODEL_CALCULATED',
        methodId: truth.methodId, methodVersion: truth.methodVersion, sourceIds: truth.sourceIds,
        titration: { sourceInstanceId: ids.buretteId, receiverInstanceId: ids.flaskId, deliveredVolumeL: truth.equivalenceVolume.value },
      },
    };
    const snapshot = { ...reader.snapshot, lastSequence: 1, observations: [claimedRecord], transferTotals: [claimedRecord.observation.titration!] };
    reader.emit(snapshot, {
      type: 'OBSERVATIONS', runId: snapshot.runId, stationId: ids.stationId, epoch: 0, sequence: 1, observations: [claimedRecord],
    });
    expect(controller.getSnapshot().evaluation.eligibleObservationIds).toEqual([]);
    expect(controller.getSnapshot().evaluation.score.total).toBe(0);
    expect(controller.captureEndpoint({ observationId: claimedRecord.id, basis: 'instrument-reading' }).ok).toBe(false);
    expect(controller.getSnapshot().trial.endpoint).toBeNull();
    controller.dispose();
  });

  it('does not credit prefilled display state when the corresponding action was rejected', () => {
    const harness = createEmptyHarness();
    const { controller, reader, ids, makeId, aliquot } = harness;
    const action: LabAction = {
      actionId: makeId(), type: 'FILL', atSimulationS: 0, targetInstanceId: ids.flaskId,
      payload: { contents: aliquot.contents, preparation: { kind: 'INITIAL', sourceId: 'hcl' } },
    };
    const snapshot: RuntimeSnapshot = {
      ...reader.snapshot, lastSequence: 1,
      scene: { ...reader.snapshot.scene, containerStates: { [ids.flaskId]: aliquot.contents } },
    };
    const event: LabRuntimeEvent = {
      type: 'ACTION', runId: snapshot.runId, stationId: ids.stationId, epoch: 0, sequence: 1, action,
      receipt: { status: 'REJECTED', actionId: action.actionId, stationId: ids.stationId, epoch: 0, sequence: 1, runtimeRevision: 0,
        error: { type: 'urn:matterlab:test:rejected', status: 422, code: 'INVALID_ACTION', title: 'Rejected fixture', detail: 'No accepted preparation.' } },
    };
    reader.emit(snapshot, event);
    const view = controller.getSnapshot();
    expect(view.trial.appliedEvents).toEqual([]);
    expect(view.evaluation.goals.find((goal) => goal.id === 'aliquot')?.state).not.toBe('complete');
    expect(view.evaluation.score.total).toBe(0);
    controller.dispose();
  });

  it('ignores foreign run/station/epoch events and receipt identity mismatches', () => {
    const { controller, reader, ids, makeId, aliquot } = createEmptyHarness();
    const action: LabAction = {
      actionId: makeId(), type: 'FILL', atSimulationS: 0, targetInstanceId: ids.flaskId,
      payload: { contents: aliquot.contents, preparation: { kind: 'INITIAL', sourceId: 'hcl' } },
    };
    const snapshot = { ...reader.snapshot, revision: 1, lastSequence: 10 };
    const original = controller.exportAttempt();
    for (const scope of [
      { runId: makeId(), stationId: ids.stationId, epoch: 0 },
      { runId: snapshot.runId, stationId: ids.blankStationId, epoch: 0 },
      { runId: snapshot.runId, stationId: ids.stationId, epoch: 1 },
    ]) {
      reader.emit(snapshot, {
        type: 'ACTION', ...scope, sequence: 1, action,
        receipt: { status: 'APPLIED', actionId: action.actionId, stationId: scope.stationId, epoch: scope.epoch, sequence: 1, runtimeRevision: 1 },
      });
    }
    reader.emit(snapshot, {
      type: 'ACTION', runId: snapshot.runId, stationId: ids.stationId, epoch: 0, sequence: 1, action,
      receipt: { status: 'APPLIED', actionId: makeId(), stationId: ids.stationId, epoch: 0, sequence: 1, runtimeRevision: 1 },
    });
    expect(controller.exportAttempt()).toEqual(original);
    controller.dispose();
  });

  it('does not count repeated action IDs twice or accept a typed FILL as evidence for the wrong preparation', () => {
    const { controller, reader, ids, makeId, aliquot, titrant } = createEmptyHarness();
    const action: LabAction = {
      actionId: makeId(), type: 'FILL', atSimulationS: 0, targetInstanceId: ids.flaskId,
      payload: { contents: titrant.contents, preparation: { kind: 'INITIAL', sourceId: 'hcl' } },
    };
    for (const sequence of [1, 1, 2]) {
      const snapshot = { ...reader.snapshot, revision: 1, lastSequence: sequence };
      reader.emit(snapshot, {
        type: 'ACTION', runId: snapshot.runId, stationId: ids.stationId, epoch: 0, sequence, action,
        receipt: { status: 'APPLIED', actionId: action.actionId, stationId: ids.stationId, epoch: 0, sequence, runtimeRevision: 1 },
      });
    }
    const view = controller.getSnapshot();
    expect(view.trial.appliedEvents).toHaveLength(1);
    expect(evaluatePredicate(view.trial, view.attempt.definition, { kind: 'prepared', role: 'receiver' }).state).toBe('pending');
    expect(aliquot.contents).not.toEqual(titrant.contents);
    expect(controller.beginTrial().ok).toBe(false);
    expect(controller.exportAttempt().trials).toHaveLength(1);
    controller.dispose();
  });

  it('rejects geometry, capabilities, disabled sockets and crossing stations instead of trusting apparatus kinds', () => {
    const { controller, ids } = createEmptyHarness();
    const trial = controller.getSnapshot().trial;
    expect(trialGraphIssues(trial)).toEqual([]);
    const fluid = trial.frame.scene.connections.find((edge) => edge.kind === 'FLUID')!;
    const definitions = definitionReader(trial.definitions);
    expect(assessConnection(trial.frame, { ...fluid, enabled: false }, definitions, ids.stationId).valid).toBe(false);
    const moved = {
      ...trial, frame: { ...trial.frame, scene: { ...trial.frame.scene, apparatus: trial.frame.scene.apparatus.map((instance) =>
        instance.id === ids.flaskId ? { ...instance, transform: { ...instance.transform, positionM: [1, 2, 3] as const } } : instance) } },
    };
    expect(trialGraphIssues(moved)).toContain('Socket positions exceed their declared alignment tolerance.');
    const spoof = {
      ...trial, frame: { ...trial.frame, scene: { ...trial.frame.scene, apparatus: trial.frame.scene.apparatus.map((instance) =>
        instance.id === ids.buretteId ? { ...instance, capabilities: [] } : instance) } },
    };
    expect(trialGraphIssues(spoof).some((issue) => issue.includes('registered definition'))).toBe(true);
    expect(assessConnection(trial.frame, { ...fluid, to: { ...fluid.to, instanceId: ids.blankBenchId } }, definitions, ids.stationId).valid).toBe(false);
    controller.dispose();
  });

  it('exports only this station’s empty apparatus template and never changes runtime inventory or trial evidence', () => {
    const { controller, makeId, reader, ids } = createEmptyHarness();
    const before = reader.getSnapshot();
    const attempt = controller.exportAttempt();
    const template = createGuidedTemplate(attempt, { id: makeId(), sceneId: makeId(), name: 'Practice titration layout' });
    expect(template.scene.stations.map((station) => station.id)).toEqual([ids.stationId]);
    expect(template.scene.containerStates).toEqual({});
    expect(template.scene.apparatus.some((instance) => instance.stationId === ids.blankStationId)).toBe(false);
    expect(reader.getSnapshot()).toBe(before);
    expect(controller.exportAttempt()).toEqual(attempt);
    expect(trialPlotPoints(attempt.trials[0]!, attempt.definition)).toEqual([]);
    expect(trialReplayFrames(attempt.trials[0]!)).toEqual([]);
    controller.dispose();
  });

  it('keeps unsupported science honest even when reference/display preparation data are present', () => {
    const { controller: first, options } = createEmptyHarness();
    first.dispose();
    const controller = createChallengeController({
      ...options, getSupport: () => ({ status: 'UNSUPPORTED', reasons: ['No supported model for this station.'], methodId: options.reference.methodId }),
    });
    expect(controller.getSnapshot().evaluation.score.eligible).toBe(false);
    expect(controller.getSnapshot().evaluation.issues).toContain('No supported model for this station.');
    expect(controller.captureEndpoint({ observationId: options.createId(), basis: 'instrument-reading' }).ok).toBe(false);
    controller.dispose();
  });
});
