import type { ObservationRecord } from '@matterlab/contracts';
import { acceptedDelivery, appliedActions, endpointCandidates, preparationEvents, sensorEvidence } from './evidence.ts';
import { hasRoleConnection, isUpright, roleInstance, trialGraphIssues } from './graph.ts';
import { endpointTarget } from './reference.ts';
import type { ChallengeDefinition, GoalPredicate, GoalResult, TrialEvidence, TrialStatistics } from './types.ts';

type PredicateResult = Pick<GoalResult, 'state' | 'reasons' | 'observationIds' | 'actionIds'>;
const pending = (reason: string, unsupported = false): PredicateResult => ({
  state: unsupported ? 'unsupported' : 'pending', reasons: [reason], observationIds: [], actionIds: [],
});
const complete = (observationIds: readonly string[] = [], actionIds: readonly string[] = []): PredicateResult => ({
  state: 'complete', reasons: [], observationIds, actionIds,
});
function combine(results: readonly PredicateResult[], any = false): PredicateResult {
  if (any) {
    const success = results.find((result) => result.state === 'complete');
    if (success) return success;
  }
  return {
    state: results.every((result) => result.state === 'complete') ? 'complete'
      : results.some((result) => result.state === 'unsupported') ? 'unsupported' : 'pending',
    reasons: [...new Set(results.flatMap((result) => result.reasons))],
    observationIds: [...new Set(results.flatMap((result) => result.observationIds))],
    actionIds: [...new Set(results.flatMap((result) => result.actionIds))],
  };
}

export function classifyEndpoint(
  trial: TrialEvidence, definition: ChallengeDefinition, target: 'equivalence' | 'endpoint' = 'equivalence',
): 'before' | 'within' | 'after' | 'unavailable' {
  if (!trial.endpoint || trial.reference.status !== 'SUPPORTED') return 'unavailable';
  const reference = target === 'equivalence' ? trial.reference.equivalenceVolume : endpointTarget(trial.reference);
  if (!reference) return 'unavailable';
  const deviation = trial.endpoint.deliveredVolume.value - reference.value;
  return Math.abs(deviation) <= definition.rubric.endpointToleranceL + 1e-12 ? 'within' : deviation > 0 ? 'after' : 'before';
}

export function evaluatePredicate(
  trial: TrialEvidence, definition: ChallengeDefinition, predicate: GoalPredicate, statistics?: TrialStatistics,
): PredicateResult {
  const events = appliedActions(trial);
  const graphIssues = trialGraphIssues(trial);
  const usedGraph = events.some((event) => ['PLACE', 'MOVE', 'ATTACH', 'FILL', 'TRANSFER', 'SET_PROBE'].includes(event.action.type));
  const graphReady = () => graphIssues.length ? pending(graphIssues[0]!, true) : !usedGraph ? pending('Use the apparatus through an accepted runtime action; display state alone is not evidence.') : null;
  switch (predicate.kind) {
    case 'all': case 'any':
      return combine(predicate.predicates.map((child) => evaluatePredicate(trial, definition, child, statistics)), predicate.kind === 'any');
    case 'capability': {
      const instance = roleInstance(trial, predicate.role);
      if (!instance) return pending(`Choose one ${definition.roles[predicate.role]?.label ?? predicate.role} in this station.`);
      const registered = trial.definitions.find((entry) => entry.id === instance.definitionId);
      if (!registered || !predicate.capabilities.every((capability) => registered.capabilities.includes(capability) && instance.capabilities.includes(capability))) return pending('The registered apparatus lacks the required capabilities.', true);
      return graphReady() ?? complete([], events.map((event) => event.action.actionId));
    }
    case 'connection':
      return graphReady() ?? (hasRoleConnection(trial, predicate.from, predicate.to, predicate.connectionKind)
        ? complete([], events.map((event) => event.action.actionId)) : pending('Make the required enabled, compatible socket connection.'));
    case 'mounted': {
      if (predicate.chain.some((role) => !roleInstance(trial, role))) return pending('Place or explicitly select all apparatus in the mounting chain.');
      const valid = predicate.chain.slice(1).every((role, index) => hasRoleConnection(trial, predicate.chain[index]!, role, 'MECHANICAL'));
      return graphReady() ?? (valid ? complete([], events.map((event) => event.action.actionId)) : pending('The mounting chain is incomplete or its sockets are not aligned.'));
    }
    case 'receiverAligned': {
      const source = roleInstance(trial, predicate.source);
      const receiver = roleInstance(trial, predicate.receiver);
      if (!source || !receiver) return pending('Select a source and receiver in this station.');
      const caps = evaluatePredicate(trial, definition, { kind: 'all', predicates: [
        { kind: 'capability', role: predicate.source, capabilities: ['CONTAINER', 'FLOW_SOURCE'] },
        { kind: 'capability', role: predicate.receiver, capabilities: ['CONTAINER', 'FLOW_RECEIVER'] },
      ] });
      if (caps.state !== 'complete') return caps;
      if (!isUpright(source) || !isUpright(receiver)) return pending('The declared liquid calibration supports upright vessels only.', true);
      return graphReady() ?? (hasRoleConnection(trial, predicate.source, predicate.receiver, 'FLUID')
        ? complete([], events.map((event) => event.action.actionId)) : pending('Align and connect the receiver inlet below the burette outlet.'));
    }
    case 'prepared': {
      if (trial.reference.status !== 'SUPPORTED') return pending('No supported preparation target is available.', true);
      const matches = preparationEvents(trial, definition, predicate.role);
      return matches.length ? complete([], matches.map((event) => event.action.actionId))
        : pending('An accepted, exact science-approved FILL into an initially empty vessel is required. Extra fills or foreign transfers require a new trial.');
    }
    case 'sensorUsed': {
      const sensor = sensorEvidence(trial, definition, predicate.sensor, predicate.receiver);
      return graphReady() ?? (sensor ? complete(sensor.observations.map((record) => record.id), sensor.actions.map((event) => event.action.actionId))
        : pending('Connect the capable probe to this receiver, apply SET_PROBE, and obtain a subsequent supported pH observation.'));
    }
    case 'instrumentRead': {
      const source = roleInstance(trial, predicate.source);
      const calibration = trial.definitions.find((entry) => entry.id === source?.definitionId)?.vesselCalibration;
      if (!calibration?.graduations || calibration.graduations.reading !== 'DELIVERED') return pending('This instrument has no declared delivered-volume scale.', true);
      const reading = trial.readings.find((entry) => {
        const observed = trial.observations.find((record) => record.id === entry.observationId);
        const delivered = observed && acceptedDelivery(trial, definition, observed, true);
        return delivered && entry.recordedAtSequence >= observed!.sequence &&
          Math.abs(entry.enteredDeliveredVolume.value - delivered.volumeL) <= definition.rubric.readingToleranceL + 1e-12;
      });
      if (!reading) return pending(`Enter the current delivered-volume scale reading at the ${calibration.meniscus.reference.toLowerCase()} meniscus reference. Volume remaining is not delivered volume.`);
      return complete([reading.observationId]);
    }
    case 'actionApplied': {
      const roleId = trial.bindings[predicate.role];
      const matching = events.filter((event) => {
        const action = event.action;
        if (!roleId || action.targetInstanceId !== roleId || action.type !== predicate.actionType) return false;
        if (predicate.setting && action.type !== 'SET_VALVE') return false;
        if (action.type === 'SET_VALVE' && predicate.setting) return predicate.setting === 'zero' ? action.payload.openingFraction === 0 : action.payload.openingFraction > 0;
        if (action.type === 'TRANSFER') return action.payload.sourceInstanceId === trial.bindings[definition.sourceRole] &&
          action.payload.targetInstanceId === trial.bindings[definition.receiverRole] && action.payload.volumeL > 0;
        return true;
      });
      return matching.length ? complete([], matching.map((event) => event.action.actionId)) : pending(`Apply ${predicate.actionType} to the correct apparatus in this trial.`);
    }
    case 'endpointCaptured': {
      if (!trial.endpoint) return pending('Capture the current supported reading after stopping delivery.');
      const observed = trial.observations.find((record) => record.id === trial.endpoint!.observationId);
      return observed && acceptedDelivery(trial, definition, observed, true) ? complete([observed.id]) : pending('Endpoint evidence is stale, unsupported or not backed by accepted delivery.', true);
    }
    case 'deliveredVolumeWithin': {
      if (trial.reference.status !== 'SUPPORTED') return pending('No supported reference volume is available.', true);
      const record = trial.endpoint ? trial.observations.find((entry) => entry.id === trial.endpoint!.observationId) : endpointCandidates(trial, definition)[0];
      const delivered = record && acceptedDelivery(trial, definition, record, true);
      const target = predicate.target === 'equivalence' ? trial.reference.equivalenceVolume : endpointTarget(trial.reference);
      if (!delivered || !target) return pending('A supported observed delivery and supplied reference target are required.');
      const deviation = delivered.volumeL - target.value;
      return Math.abs(deviation) <= definition.rubric.endpointToleranceL + 1e-12 ? complete([record!.id], delivered.actionIds)
        : pending(deviation > 0 ? 'Overshoot: the observed delivery exceeds the model-reference learning window. Preserve this result and repeat.'
          : 'The observed delivery is below the model-reference learning window. This is not an equivalence determination.');
    }
    case 'repeatTrials':
      return (statistics?.count ?? 0) >= predicate.minimum ? complete()
        : pending(`Capture ${predicate.minimum} independent, valid trials in this run and station. Reset epochs count once; replay does not.`);
    case 'repeatabilityWithin':
      return statistics && statistics.count >= definition.rubric.minimumTrials && statistics.sampleStandardDeviationL !== null &&
        statistics.sampleStandardDeviationL <= definition.rubric.repeatabilityToleranceL + 1e-12
        ? complete() : pending('Use at least three valid trials and compare the sample standard deviation with the declared learning tolerance. This spread is not experimental uncertainty.');
    case 'interpretation': {
      const conclusion = trial.conclusion;
      const endpoint = trial.endpoint;
      if (!endpoint || !conclusion || trial.reference.status !== 'SUPPORTED') return pending('Record an evidence-linked conclusion after capturing an endpoint.');
      const observed = trial.observations.find((entry) => entry.id === endpoint.observationId);
      if (!observed || !acceptedDelivery(trial, definition, observed, true) || !conclusion.citedObservationIds.includes(endpoint.observationId)) return pending('Cite the endpoint observation from this trial, not another station or run.');
      if (!conclusion.text.trim() || conclusion.equivalenceAndEndpoint !== 'distinct' ||
        conclusion.endpointPosition !== classifyEndpoint(trial, definition) || !conclusion.acknowledgesModelLimits) return pending('Distinguish endpoint from equivalence, classify the observed volume against its reference window, and acknowledge the model limits. Free-text prose is not automatically fact-checked.');
      const target = trial.reference.initialConcentration;
      if (!target) return pending('This reference does not support a concentration-answer comparison.', true);
      if (!conclusion.concentration || conclusion.concentration.unit !== 'mol/L' ||
        !Number.isFinite(conclusion.concentration.value) ||
        Math.abs(conclusion.concentration.value - target.value) > definition.rubric.concentrationToleranceMolL + 1e-12) return pending('Compare a concentration answer in mol/L with the explicitly supplied science reference; gameplay does not solve unknown chemistry.');
      return complete(conclusion.citedObservationIds);
    }
  }
}

export function evaluateGoals(trial: TrialEvidence, definition: ChallengeDefinition, statistics?: TrialStatistics): readonly GoalResult[] {
  const evaluated = new Map<string, GoalResult>();
  const visiting = new Set<string>();
  const evaluate = (id: string): GoalResult => {
    const prior = evaluated.get(id);
    if (prior) return prior;
    const goal = definition.goals.find((entry) => entry.id === id);
    if (!goal || visiting.has(id)) throw new Error('Invalid declarative goal dependency.');
    visiting.add(id);
    const dependencies = goal.requires.map(evaluate);
    const own = evaluatePredicate(trial, definition, goal.predicate, statistics);
    const result: GoalResult = {
      id, label: goal.label, category: goal.category,
      ...combine([...dependencies, own]),
    };
    evaluated.set(id, result);
    visiting.delete(id);
    return result;
  };
  return definition.goals.map((goal) => evaluate(goal.id));
}

export function captureProblems(trial: TrialEvidence, definition: ChallengeDefinition, observationId: string): readonly string[] {
  const issues = [...trialGraphIssues(trial)];
  if (trial.reference.status !== 'SUPPORTED' || trial.support.status !== 'SUPPORTED') issues.push('The current model or reference is unsupported.');
  const goals = evaluateGoals(trial, definition);
  definition.captureRequires.forEach((id) => {
    const goal = goals.find((entry) => entry.id === id);
    if (!goal || goal.state !== 'complete') issues.push(...(goal?.reasons ?? [`Missing capture prerequisite ${id}.`]));
  });
  const candidate = endpointCandidates(trial, definition).find((record) => record.id === observationId);
  if (!candidate) issues.push('Only the latest supported receiver solve at the current accepted delivered volume can be captured.');
  const sourceId = trial.bindings[definition.sourceRole];
  const actions = appliedActions(trial);
  const lastValve = actions.filter((event) => event.action.type === 'SET_VALVE' && event.action.targetInstanceId === sourceId).at(-1);
  const lastTransfer = actions.filter((event) => event.action.type === 'TRANSFER' && event.action.payload.sourceInstanceId === sourceId).at(-1);
  if (trial.frame.apparatusStates[sourceId ?? '']?.valveOpeningFraction !== 0 || !lastValve ||
    lastValve.action.type !== 'SET_VALVE' || lastValve.action.payload.openingFraction !== 0 ||
    (lastTransfer && lastValve.sequence < lastTransfer.sequence)) issues.push('Close the stopcock through an accepted runtime action after delivery and before capturing.');
  return [...new Set(issues)];
}

export function capturedTrialIsEligible(trial: TrialEvidence, definition: ChallengeDefinition): boolean {
  const endpoint = trial.endpoint;
  if (trial.status !== 'captured' || !endpoint || endpoint.capturedAtSequence !== trial.cursorSequence) return false;
  const record: ObservationRecord | undefined = trial.observations.find((entry) => entry.id === endpoint.observationId);
  const basisSupported = endpoint.basis === 'instrument-reading' ? record?.observation.type === 'PH'
    : record?.observation.type === 'INDICATOR' && trial.reference.status === 'SUPPORTED' &&
      trial.reference.indicatorEndpoint?.indicatorId === record.observation.indicatorId;
  return Boolean(record && basisSupported && record.observation.evidence === endpoint.evidence &&
    record.observation.titration?.deliveredVolumeL === endpoint.deliveredVolume.value &&
    captureProblems(trial, definition, endpoint.observationId).length === 0);
}
