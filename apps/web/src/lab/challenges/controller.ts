import { parseLabContract, validateLabContract } from '@matterlab/contracts';
import type { LabRuntimeEvent, ObservationRecord, RuntimeSnapshot } from '@matterlab/contracts';
import { appliedActions, sameScope, supportedObservation } from './evidence.ts';
import { resolveRoleBindings } from './graph.ts';
import { canonicalJson, copyJson, freezeJson } from './json.ts';
import { parseChallengeAttempt, parseChallengeDefinition, parseLearningReference } from './persistence.ts';
import { captureProblems } from './predicates.ts';
import { LEARNING_STATE_LIMITS } from './schema.ts';
import { evaluateTrial } from './scoring.ts';
import type {
  AppliedActionEvent, ChallengeAttempt, ChallengeController, ChallengeControllerOptions, ChallengeView,
  LearningCommandResult, RuntimeEvidenceFrame, TrialEvidence, TrialScope,
} from './types.ts';

export function evidenceFrame(snapshot: RuntimeSnapshot): RuntimeEvidenceFrame {
  const { observations: _observations, ...frame } = snapshot;
  return frame;
}

function snapshotScope(snapshot: RuntimeSnapshot, stationId: string): TrialScope {
  const station = snapshot.stationStates[stationId];
  if (!station) throw new Error('The learning station is not present in this runtime.');
  return { runId: snapshot.runId, stationId, epoch: station.epoch };
}

/** Creates a reader-only sidecar. It never dispatches actions or writes runtime inventories. */
export function createChallengeController(options: ChallengeControllerOptions): ChallengeController {
  const makeId = options.createId ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => new Date().toISOString());
  const restored = options.attempt ? parseChallengeAttempt(options.attempt) : undefined;
  const definition = restored?.definition ?? parseChallengeDefinition(options.definition);
  if (restored && restored.definition.id !== options.definition.id) throw new Error('Restore belongs to a different challenge.');
  const reference = parseLearningReference(options.reference);
  const requestedBindings = restored?.requestedBindings ?? options.bindings ?? {};
  const definitionSnapshot = (snapshot: RuntimeSnapshot) => {
    const ids = new Set(snapshot.scene.apparatus.filter((instance) => instance.stationId === options.stationId).map((instance) => instance.definitionId));
    return [...ids].flatMap((id) => { const entry = options.definitions.getDefinition(id); return entry ? [entry] : []; });
  };
  function newTrial(snapshot: RuntimeSnapshot): TrialEvidence {
    const frame = evidenceFrame(snapshot);
    const bindings = resolveRoleBindings(frame, options.stationId, definition, options.definitions, requestedBindings);
    return copyJson({
      id: makeId(), scope: snapshotScope(snapshot, options.stationId), status: 'active', startedAt: now(),
      startedAtSequence: snapshot.lastSequence, cursorSequence: snapshot.lastSequence, bindings,
      initialContainerStates: Object.fromEntries(Object.entries(snapshot.scene.containerStates).filter(([id]) =>
        snapshot.scene.apparatus.some((instance) => instance.id === id && instance.stationId === options.stationId))),
      initialTransferVolumeL: snapshot.transferTotals.find((entry) => entry.sourceInstanceId === bindings[definition.sourceRole] &&
        entry.receiverInstanceId === bindings[definition.receiverRole])?.deliveredVolumeL ?? 0,
      frame, definitions: definitionSnapshot(snapshot), support: options.getSupport(snapshot, options.stationId), reference,
      appliedEvents: [], observations: [], readings: [], endpoint: null, conclusion: null, notes: '',
    });
  }
  const initialSnapshot = parseLabContract('RuntimeSnapshot', options.reader.getSnapshot());
  const firstTrial = restored ? undefined : newTrial(initialSnapshot);
  let attempt: ChallengeAttempt = restored ?? copyJson({
    schemaVersion: 1, kind: 'MATTERLAB_CHALLENGE_ATTEMPT', id: makeId(), definition,
    mode: options.mode ?? 'guided', createdAt: now(), updatedAt: now(), requestedBindings,
    activeTrialId: firstTrial!.id, progression: { instructionIndex: 0, dismissed: false, hintsRequested: [] }, trials: [firstTrial!],
  });
  const listeners = new Set<() => void>();
  let disposed = false;
  let view: ChallengeView;
  const active = () => attempt.trials.find((trial) => trial.id === attempt.activeTrialId)!;
  function publish(next: ChallengeAttempt, message: string | null = null, recompute = true): void {
    attempt = freezeJson(next);
    const trial = active();
    view = freezeJson({ attempt, trial, evaluation: recompute || !view ? evaluateTrial(attempt) : view.evaluation, lastMessage: message });
    listeners.forEach((listener) => listener());
  }
  function updateTrial(trial: TrialEvidence, message: string | null = null): void {
    publish({ ...attempt, updatedAt: now(), trials: attempt.trials.map((entry) => entry.id === trial.id ? copyJson(trial) : entry) }, message);
  }
  const result = (ok: boolean, reason?: string): LearningCommandResult => {
    if (reason) publish(attempt, reason, false);
    return reason ? { ok, reason } : { ok };
  };
  function switchScope(snapshot: RuntimeSnapshot): boolean {
    const trial = active();
    const scope = snapshotScope(snapshot, options.stationId);
    if (sameScope(scope, trial.scope)) return false;
    if (attempt.trials.some((entry) => sameScope(entry.scope, scope))) {
      publish(attempt, 'This runtime scope already has a notebook trial. Replaying it cannot create an independent repeat.', false);
      return false;
    }
    if (attempt.trials.length >= LEARNING_STATE_LIMITS.maxTrialsPerAttempt) {
      publish(attempt, 'Notebook trial limit reached. Export this evidence before starting a new attempt.', false);
      return false;
    }
    const next = newTrial(snapshot);
    const previous = trial.status === 'active'
      ? copyJson({ ...trial, status: 'interrupted' as const, interruptionReason: 'Runtime run or station epoch changed before endpoint capture.' })
      : trial;
    publish({
      ...attempt, updatedAt: now(), activeTrialId: next.id,
      trials: [...attempt.trials.map((entry) => entry.id === trial.id ? previous : entry), next],
    }, 'A new runtime scope started a fresh trial. Earlier trial evidence remains in the notebook.');
    return true;
  }
  publish(attempt);
  switchScope(initialSnapshot);

  function consume(snapshot: RuntimeSnapshot, inputEvent: LabRuntimeEvent): void {
    if (disposed || !snapshot.stationStates[options.stationId]) return;
    const parsed = validateLabContract('LabRuntimeEvent', inputEvent);
    if (!parsed.ok) return;
    const event = parsed.value;
    const currentScope = snapshotScope(snapshot, options.stationId);
    const priorTrial = active();
    if (!sameScope(currentScope, priorTrial.scope)) {
      // RESET receipts use the old epoch; the new frame, not that receipt, starts the next trial.
      const legitimateReset = event.type === 'ACTION' && event.action.type === 'RESET' && event.receipt.status === 'APPLIED' &&
        event.runId === priorTrial.scope.runId && event.stationId === priorTrial.scope.stationId && event.epoch === priorTrial.scope.epoch;
      if (!legitimateReset && !sameScope(event, currentScope)) return;
      if (switchScope(snapshot)) return;
    }
    const trial = active();
    if (trial.status !== 'active' || !sameScope(event, trial.scope) || !sameScope(currentScope, trial.scope) ||
      event.sequence <= trial.cursorSequence || event.sequence > snapshot.lastSequence) return;
    const frame = evidenceFrame(snapshot);
    const bindings = resolveRoleBindings(frame, options.stationId, definition, options.definitions, { ...requestedBindings, ...trial.bindings });
    let next: TrialEvidence = {
      ...trial, frame, bindings, cursorSequence: event.sequence,
      definitions: definitionSnapshot(snapshot), support: options.getSupport(snapshot, options.stationId),
    };
    if (event.type === 'ACTION' && event.receipt.status === 'APPLIED' && event.action.type !== 'RESET') {
      const localTarget = snapshot.scene.apparatus.some((instance) => instance.id === event.action.targetInstanceId && instance.stationId === options.stationId);
      const duplicate = trial.appliedEvents.some((entry) => entry.action.actionId === event.action.actionId);
      if (localTarget && !duplicate && event.receipt.runtimeRevision <= snapshot.revision &&
        (event.action.expectedEpoch === undefined || event.action.expectedEpoch === trial.scope.epoch)) {
        next = { ...next, appliedEvents: [...trial.appliedEvents, event as AppliedActionEvent] };
      }
    }
    if (event.type === 'OBSERVATIONS') {
      const ids = new Set(trial.observations.map((record) => record.id));
      const incoming: ObservationRecord[] = [];
      for (const record of event.observations) {
        const inSnapshot = snapshot.observations.find((entry) => entry.id === record.id);
        if (ids.has(record.id) || !inSnapshot || canonicalJson(inSnapshot) !== canonicalJson(record)) continue;
        if (record.observation.apparatusId && !snapshot.scene.apparatus.some((instance) =>
          instance.id === record.observation.apparatusId && instance.stationId === options.stationId)) continue;
        ids.add(record.id);
        incoming.push(record);
      }
      next = { ...next, observations: [...trial.observations, ...incoming] };
    }
    const totalEvents = attempt.trials.reduce((total, entry) => total + (entry.id === trial.id ? next.appliedEvents.length : entry.appliedEvents.length), 0);
    const totalObservations = attempt.trials.reduce((total, entry) => total + (entry.id === trial.id ? next.observations.length : entry.observations.length), 0);
    if (totalEvents > LEARNING_STATE_LIMITS.maxEvents || totalObservations > LEARNING_STATE_LIMITS.maxObservations) {
      updateTrial({ ...trial, status: 'interrupted', interruptionReason: 'Notebook evidence limit reached. Export and start another attempt; evidence was not silently dropped.' });
      return;
    }
    updateTrial(next);
  }

  const unsubscribe = options.reader.subscribe(consume);
  function annotationTrial(trialId?: string): TrialEvidence | undefined {
    return attempt.trials.find((trial) => trial.id === (trialId ?? attempt.activeTrialId));
  }
  return {
    getSnapshot: () => view,
    subscribe: (listener) => { if (disposed) return () => undefined; listeners.add(listener); return () => listeners.delete(listener); },
    setMode: (mode) => {
      if (disposed || !['guided', 'challenge', 'free', 'precision'].includes(mode)) return;
      publish({ ...attempt, mode, updatedAt: now() });
    },
    setInstructionIndex: (index) => {
      if (disposed || !Number.isFinite(index)) return;
      const instructionIndex = Math.max(0, Math.min(definition.instructions.length - 1, Math.trunc(index)));
      publish({ ...attempt, updatedAt: now(), progression: { ...attempt.progression, instructionIndex } }, null, false);
    },
    dismissGuide: (dismissed) => {
      if (disposed) return;
      publish({ ...attempt, updatedAt: now(), progression: { ...attempt.progression, dismissed } }, null, false);
    },
    requestHint: (goalId) => {
      if (disposed || !definition.goals.some((goal) => goal.id === goalId) || attempt.progression.hintsRequested.includes(goalId)) return;
      publish({ ...attempt, updatedAt: now(), progression: {
        ...attempt.progression, hintsRequested: [...attempt.progression.hintsRequested, goalId],
      } }, null, false);
    },
    recordReading: (observationId, enteredDeliveredVolumeL) => {
      const trial = active();
      if (disposed || trial.status !== 'active') return result(false, 'Readings belong to an active trial; captured evidence cannot be rewritten.');
      const record = trial.observations.find((entry) => entry.id === observationId);
      if (!record || !supportedObservation(record, trial, definition) || !record.observation.titration ||
        !Number.isFinite(enteredDeliveredVolumeL) || enteredDeliveredVolumeL < 0 || enteredDeliveredVolumeL > 1e12) return result(false, 'Enter a finite volume in liters and cite this trial’s supported observation.');
      const reading = {
        observationId, recordedAtSequence: trial.cursorSequence,
        enteredDeliveredVolume: { value: enteredDeliveredVolumeL, unit: 'L' as const },
      };
      updateTrial({ ...trial, readings: [...trial.readings.filter((entry) => entry.observationId !== observationId), reading] });
      const difference = Math.abs(record.observation.titration.deliveredVolumeL - enteredDeliveredVolumeL);
      return result(true, difference > definition.rubric.readingToleranceL + 1e-12
        ? 'The transcription differs from the calibrated delivered scale. Check meniscus reference and delivered versus remaining volume.'
        : 'Reading saved as a learner transcription, not a new scientific observation.');
    },
    captureEndpoint: ({ observationId, basis, note = '' }) => {
      const trial = active();
      if (disposed || trial.status !== 'active') return result(false, 'This trial is already captured or interrupted. Reset the runtime station for another trial.');
      const current = options.reader.getSnapshot();
      if (!sameScope(snapshotScope(current, options.stationId), trial.scope)) return result(false, 'The runtime scope changed; do not capture a stale reading.');
      const currentTrial: TrialEvidence = {
        ...trial, frame: evidenceFrame(current), support: options.getSupport(current, options.stationId),
        cursorSequence: current.lastSequence, definitions: definitionSnapshot(current),
      };
      const problems = [...captureProblems(currentTrial, definition, observationId)];
      const record = trial.observations.find((entry) => entry.id === observationId);
      const currentRecord = current.observations.find((entry) => entry.id === observationId);
      const latestSequence = Math.max(-1, ...current.observations.filter((entry) =>
        sameScope(entry, trial.scope) && entry.observation.apparatusId === trial.bindings[definition.receiverRole] &&
        ['PH', 'INDICATOR'].includes(entry.observation.type)).map((entry) => entry.sequence));
      if (!record || !currentRecord || canonicalJson(record) !== canonicalJson(currentRecord) || record.sequence !== latestSequence) problems.push('The chosen observation is not the current receiver solve; backdated endpoint capture is not allowed.');
      if (basis === 'instrument-reading' && record?.observation.type !== 'PH') problems.push('Instrument-reading capture requires the supported pH record.');
      if (basis === 'indicator-change' && (record?.observation.type !== 'INDICATOR' || trial.reference.status !== 'SUPPORTED' ||
        trial.reference.indicatorEndpoint?.indicatorId !== record.observation.indicatorId)) problems.push('Indicator capture requires a matching supported indicator criterion supplied by science.');
      if (!['instrument-reading', 'indicator-change'].includes(basis) || note.length > 2000) problems.push('Invalid endpoint annotation.');
      if (problems.length || !record?.observation.titration) return result(false, problems[0] ?? 'No accepted delivery record.');
      const endpoint = {
        observationId, capturedAtSequence: current.lastSequence, basis, note,
        deliveredVolume: { value: record.observation.titration.deliveredVolumeL, unit: 'L' as const },
        evidence: record.observation.evidence,
      };
      updateTrial({ ...currentTrial, status: 'captured', endpoint }, 'Endpoint evidence frozen. Later resets and display changes will not rewrite this trial.');
      return { ok: true };
    },
    recordConclusion: (conclusion, trialId) => {
      const trial = annotationTrial(trialId);
      if (disposed || !trial?.endpoint) return result(false, 'A conclusion must cite a captured trial.');
      if (conclusion.text.length > 2000 || conclusion.citedObservationIds.length > 256 ||
        conclusion.citedObservationIds.some((id) => !trial.observations.some((record) => record.id === id && supportedObservation(record, trial, definition))) ||
        (conclusion.concentration && (!Number.isFinite(conclusion.concentration.value) || conclusion.concentration.value < 0 || conclusion.concentration.unit !== 'mol/L'))) return result(false, 'Conclusion data or cited evidence is invalid for this trial.');
      updateTrial({ ...trial, conclusion: copyJson(conclusion) });
      return { ok: true };
    },
    setNotes: (notes, trialId) => {
      const trial = annotationTrial(trialId);
      if (disposed || !trial || notes.length > 4000) return result(false, 'Notes must belong to a known trial and fit 4,000 characters.');
      updateTrial({ ...trial, notes });
      return { ok: true };
    },
    beginTrial: () => {
      if (disposed) return { ok: false, reason: 'Controller is disposed.' };
      return switchScope(options.reader.getSnapshot()) ? { ok: true }
        : result(false, 'Reset the station through the runtime to obtain a fresh epoch. A button press alone cannot manufacture an independent trial.');
    },
    exportAttempt: () => parseChallengeAttempt(attempt),
    dispose: () => { if (!disposed) { disposed = true; unsubscribe(); listeners.clear(); } },
  };
}

export function acceptedActionCount(trial: TrialEvidence): number {
  return appliedActions(trial).length;
}
