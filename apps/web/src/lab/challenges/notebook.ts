import { parseLabContract } from '@matterlab/contracts';
import type { ExperimentAssembly, ObservationRecord } from '@matterlab/contracts';
import { acceptedDelivery, appliedActions, preparationEvents, sameScope, supportedObservations } from './evidence.ts';
import { trialGraphIssues } from './graph.ts';
import { copyJson } from './json.ts';
import { parseChallengeAttempt } from './persistence.ts';
import { capturedTrialIsEligible } from './predicates.ts';
import { endpointTarget, referenceExplanation } from './reference.ts';
import { areTrialsComparable, deriveAchievements, evaluateTrial, summarizeTrials } from './scoring.ts';
import type { ChallengeAttempt, ChallengeDefinition, TrialEvidence } from './types.ts';

export interface TrialPlotPoint {
  readonly observationId: string;
  readonly sequence: number;
  readonly timeS: number;
  readonly deliveredVolumeL: number;
  readonly pH: number;
  readonly evidence: ObservationRecord['observation']['evidence'];
}

export function trialPlotPoints(trial: TrialEvidence, definition: ChallengeDefinition): readonly TrialPlotPoint[] {
  return supportedObservations(trial, definition).flatMap((record) => {
    const observation = record.observation;
    if (observation.type !== 'PH' || !observation.titration) return [];
    const delivery = acceptedDelivery(trial, definition, record);
    const initial = observation.titration.deliveredVolumeL === 0 &&
      observation.titration.sourceInstanceId === trial.bindings[definition.sourceRole] &&
      observation.titration.receiverInstanceId === trial.bindings[definition.receiverRole] &&
      preparationEvents(trial, definition, definition.receiverRole).some((event) => event.sequence < record.sequence);
    if (!delivery && !initial) return [];
    return [{
      observationId: record.id, sequence: record.sequence, timeS: observation.timeS,
      deliveredVolumeL: observation.titration.deliveredVolumeL, pH: observation.quantity.value, evidence: observation.evidence,
    }];
  });
}

export function trialNotebookRows(attempt: ChallengeAttempt) {
  return attempt.trials.map((trial, index) => {
    const validCapture = capturedTrialIsEligible(trial, attempt.definition);
    const endpoint = validCapture ? trial.endpoint : null;
    const endpointRecord = endpoint && trial.observations.find((record) => record.id === endpoint.observationId);
    const pH = endpointRecord && supportedObservations(trial, attempt.definition).find((record) =>
      record.observation.type === 'PH' && record.sequence === endpointRecord.sequence &&
      record.observation.timeS === endpointRecord.observation.timeS);
    const target = endpointTarget(trial.reference);
    return {
      trialId: trial.id, number: index + 1, scope: trial.scope, status: trial.status, validCapture,
      deliveredVolumeL: endpoint?.deliveredVolume.value ?? null,
      pH: pH?.observation.quantity.value ?? null,
      endpointObservationId: endpoint?.observationId ?? null,
      referenceVolumeL: target?.value ?? null,
      deviationL: endpoint && target ? endpoint.deliveredVolume.value - target.value : null,
      methodId: trial.reference.methodId, methodVersion: trial.reference.methodVersion,
      evidence: endpoint?.evidence ?? null, sourceIds: endpointRecord?.observation.sourceIds ?? [],
      score: evaluateTrial(attempt, trial.id).score,
      notes: trial.notes, conclusion: trial.conclusion,
    };
  });
}

export interface EvidenceReplayFrame {
  readonly sequence: number;
  readonly timeS: number;
  readonly actions: readonly { readonly actionId: string; readonly type: string; readonly targetInstanceId: string }[];
  readonly observations: readonly ObservationRecord[];
}

/** A ledger replay is read-only: it does not reapply actions to a live station or award a repeat. */
export function trialReplayFrames(trial: TrialEvidence): readonly EvidenceReplayFrame[] {
  const frames = new Map<number, EvidenceReplayFrame>();
  for (const event of appliedActions(trial)) {
    frames.set(event.sequence, {
      sequence: event.sequence, timeS: event.action.atSimulationS,
      actions: [{ actionId: event.action.actionId, type: event.action.type, targetInstanceId: event.action.targetInstanceId }],
      observations: [],
    });
  }
  const ids = new Set<string>();
  for (const record of trial.observations) {
    if (!sameScope(record, trial.scope) || ids.has(record.id)) continue;
    ids.add(record.id);
    const frame = frames.get(record.sequence) ?? { sequence: record.sequence, timeS: record.observation.timeS, actions: [], observations: [] };
    frames.set(record.sequence, { ...frame, observations: [...frame.observations, record] });
  }
  return [...frames.values()].sort((left, right) => left.sequence - right.sequence);
}

export function replayCursorForKey(current: number, key: string, count: number): number | null {
  if (count <= 0) return null;
  const last = count - 1;
  const next = key === 'Home' ? 0 : key === 'End' ? last
    : key === 'ArrowRight' || key === 'ArrowUp' ? current + 1
      : key === 'ArrowLeft' || key === 'ArrowDown' ? current - 1 : null;
  return next === null ? null : Math.max(0, Math.min(last, next));
}

export function compareTrialPair(attempt: ChallengeAttempt, leftId: string, rightId: string) {
  const left = attempt.trials.find((trial) => trial.id === leftId);
  const right = attempt.trials.find((trial) => trial.id === rightId);
  let reason: string | null = null;
  if (!left || !right || left.id === right.id || sameScope(left.scope, right.scope)) reason = 'Choose two distinct runtime trial scopes, not the same replay twice.';
  else if (!areTrialsComparable(left, right)) reason = 'Science method, preparation or target metadata differ; these trials are not a like-for-like comparison.';
  else if (!capturedTrialIsEligible(left, attempt.definition) || !capturedTrialIsEligible(right, attempt.definition)) reason = 'Both trials need eligible captured endpoints.';
  if (reason || !left || !right) return { comparable: false as const, reason: reason ?? 'Unknown trial.' };
  return {
    comparable: true as const,
    leftTrialId: left.id, rightTrialId: right.id,
    differenceL: right.endpoint!.deliveredVolume.value - left.endpoint!.deliveredVolume.value,
    statistics: summarizeTrials([left, right], attempt.definition),
    countsTowardSameStationProgress: left.scope.runId === right.scope.runId && left.scope.stationId === right.scope.stationId,
  };
}

export function buildTrialNotebook(input: ChallengeAttempt) {
  const attempt = parseChallengeAttempt(input);
  return copyJson({
    schemaVersion: 1 as const, kind: 'MATTERLAB_TRIAL_NOTEBOOK' as const,
    exportedAt: attempt.updatedAt,
    evidencePolicy: 'CLIENT_DRAFT_NOT_AUTHENTICATED_RUN_RESULTS',
    learningState: { schemaVersion: 1 as const, kind: 'MATTERLAB_LEARNING_STATE' as const, attempts: [attempt] },
    rows: trialNotebookRows(attempt),
    plots: attempt.trials.map((trial) => ({ trialId: trial.id, points: trialPlotPoints(trial, attempt.definition) })),
    explanations: attempt.trials.map((trial) => ({ trialId: trial.id, statements: referenceExplanation(trial.reference) })),
    achievements: deriveAchievements(attempt),
  });
}
export type TrialNotebookExport = ReturnType<typeof buildTrialNotebook>;

export function createGuidedTemplate(
  attempt: ChallengeAttempt,
  input: { readonly id: string; readonly sceneId: string; readonly name: string; readonly trialId?: string },
): ExperimentAssembly {
  const trial = attempt.trials.find((entry) => entry.id === (input.trialId ?? attempt.activeTrialId));
  if (!trial || trialGraphIssues(trial).length) throw new Error('A template needs a valid registered apparatus graph.');
  const localIds = new Set(trial.frame.scene.apparatus.filter((instance) => instance.stationId === trial.scope.stationId).map((instance) => instance.id));
  return parseLabContract('ExperimentAssembly', {
    id: input.id, schemaVersion: 1, name: input.name,
    description: 'Reusable virtual guided apparatus layout. Containers are empty; prepare fresh science-approved solutions through the runtime. No observations, attempts or scores are included.',
    scene: {
      ...trial.frame.scene, id: input.sceneId, revision: 0,
      stations: trial.frame.scene.stations.filter((station) => station.id === trial.scope.stationId),
      apparatus: trial.frame.scene.apparatus.filter((instance) => localIds.has(instance.id)),
      connections: trial.frame.scene.connections.filter((connection) => localIds.has(connection.from.instanceId) && localIds.has(connection.to.instanceId)),
      containerStates: {},
    },
    sourceIds: trial.reference.sourceIds,
  });
}
