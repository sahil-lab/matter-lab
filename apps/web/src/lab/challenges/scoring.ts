import { endpointCandidates } from './evidence.ts';
import { trialGraphIssues } from './graph.ts';
import { canonicalJson } from './json.ts';
import { capturedTrialIsEligible, classifyEndpoint, evaluateGoals } from './predicates.ts';
import { endpointTarget } from './reference.ts';
import type { ChallengeAttempt, ChallengeDefinition, ScoreCategory, TrialEvaluation, TrialEvidence, TrialStatistics } from './types.ts';

export const REPEATABILITY_STATEMENT = 'Sample standard deviation describes the spread of these simulated trial endpoints. It is not experimental uncertainty, accuracy, or a confidence interval.';
const CATEGORY_ORDER: readonly ScoreCategory[] = ['setup', 'operation', 'endpoint', 'repeatability', 'interpretation'];

export function areTrialsComparable(left: TrialEvidence, right: TrialEvidence): boolean {
  return canonicalJson(left.reference) === canonicalJson(right.reference) &&
    left.support.methodId === right.support.methodId;
}

export function summarizeTrials(trials: readonly TrialEvidence[], definition: ChallengeDefinition): TrialStatistics {
  const unique = new Map<string, TrialEvidence>();
  const referenceTrial = trials[0];
  for (const trial of trials) {
    if (referenceTrial && areTrialsComparable(referenceTrial, trial) && capturedTrialIsEligible(trial, definition)) {
      const scope = canonicalJson(trial.scope);
      if (!unique.has(scope)) unique.set(scope, trial);
    }
  }
  const accepted = [...unique.values()];
  const values = accepted.map((trial) => trial.endpoint!.deliveredVolume.value);
  let mean = 0;
  let squaredDeviations = 0;
  values.forEach((value, index) => {
    const delta = value - mean;
    mean += delta / (index + 1);
    squaredDeviations += delta * (value - mean);
  });
  const target = referenceTrial && endpointTarget(referenceTrial.reference);
  return {
    trialIds: accepted.map((trial) => trial.id),
    count: values.length,
    meanVolumeL: values.length ? mean : null,
    sampleStandardDeviationL: values.length >= 2 ? Math.sqrt(Math.max(0, squaredDeviations / (values.length - 1))) : null,
    rangeL: values.length ? Math.max(...values) - Math.min(...values) : null,
    meanDeviationFromReferenceL: values.length && target ? mean - target.value : null,
    uncertaintyStatement: REPEATABILITY_STATEMENT,
  };
}

export function evaluateTrial(attempt: ChallengeAttempt, trialId = attempt.activeTrialId): TrialEvaluation {
  const index = attempt.trials.findIndex((trial) => trial.id === trialId);
  const trial = attempt.trials[index];
  if (!trial) throw new Error('Unknown trial.');
  const { definition } = attempt;
  const comparable = attempt.trials.slice(0, index + 1).filter((other) =>
    other.scope.runId === trial.scope.runId && other.scope.stationId === trial.scope.stationId && areTrialsComparable(trial, other));
  const statistics = summarizeTrials(comparable, definition);
  const allGoals = evaluateGoals(trial, definition, statistics);
  const goals = attempt.mode === 'free' ? [] : allGoals.filter((goal) =>
    definition.goals.find((entry) => entry.id === goal.id)?.modes.includes(attempt.mode as Exclude<typeof attempt.mode, 'free'>));
  const issues = [
    ...trialGraphIssues(trial),
    ...(trial.reference.status === 'SUPPORTED' ? [] : trial.reference.reasons),
    ...(trial.support.status === 'SUPPORTED' ? [] : trial.support.reasons),
    ...(['FAILED', 'UNSUPPORTED'].includes(trial.frame.stationStates[trial.scope.stationId]?.status ?? 'FAILED')
      ? ['The current station failed or does not support the requested science. Old readings cannot complete this trial.'] : []),
    ...(trial.status === 'interrupted' ? [trial.interruptionReason ?? 'The trial was interrupted before capture.'] : []),
  ];
  const modelEligible = trial.reference.status === 'SUPPORTED' && trial.support.status === 'SUPPORTED' &&
    trial.frame.scene.simulationConfig.methodId === trial.reference.methodId && trial.support.methodId === trial.reference.methodId &&
    !['FAILED', 'UNSUPPORTED'].includes(trial.frame.stationStates[trial.scope.stationId]?.status ?? 'FAILED') &&
    trial.status !== 'interrupted' && trialGraphIssues(trial).length === 0;
  const categories = CATEGORY_ORDER.flatMap((category) => {
    const relevant = goals.filter((goal) => goal.category === category);
    if (!relevant.length) return [];
    const maximum = definition.rubric.weights[category];
    const fraction = relevant.filter((goal) => goal.state === 'complete').length / relevant.length;
    const points = modelEligible ? Math.round(maximum * fraction * 100) / 100 : 0;
    return [{
      category, maximum, points,
      explanation: category === 'repeatability'
        ? `${statistics.count} independent captured trials; spread uses a sample standard deviation, not invented uncertainty.`
        : `${relevant.filter((goal) => goal.state === 'complete').length}/${relevant.length} evidence-linked criteria satisfied.`,
    }];
  });
  return {
    goals, statistics, issues: [...new Set(issues)],
    endpointPosition: classifyEndpoint(trial, definition),
    eligibleObservationIds: endpointCandidates(trial, definition).map((record) => record.id),
    score: {
      total: Math.round(categories.reduce((sum, category) => sum + category.points, 0) * 100) / 100,
      maximum: categories.reduce((sum, category) => sum + category.maximum, 0),
      categories, eligible: modelEligible && attempt.mode !== 'free',
      complete: attempt.mode !== 'free' && modelEligible && capturedTrialIsEligible(trial, definition) &&
        goals.length > 0 && goals.every((goal) => goal.state === 'complete'),
      label: 'Draft learning score — not a certified experimental result',
    },
  };
}

export function deriveAchievements(attempt: ChallengeAttempt): readonly { readonly id: string; readonly trialIds: readonly string[] }[] {
  const completed = attempt.trials.filter((trial) => evaluateTrial(attempt, trial.id).score.complete).map((trial) => trial.id);
  return completed.length ? [{ id: `completed:${attempt.definition.id}:${attempt.definition.version}:${attempt.mode}`, trialIds: completed }] : [];
}
