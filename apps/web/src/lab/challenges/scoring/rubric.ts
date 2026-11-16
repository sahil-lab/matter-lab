/**
 * Deterministic, measured scoring rubric: apparatus setup, instrument operation, endpoint
 * detection, repeated-measurement variance and interpretation. Every dimension is a pure function
 * of the event log / run results / trial records already validated by Agent 07 and Agent 06 — none
 * of them read scene geometry for its own sake or any rendering/animation state, so a score cannot
 * change just because the scene was re-rendered or the camera moved.
 */

import { equivalenceVolumeL, evaluateObjective } from '../goals';
import type { EvaluationContext, GoalPredicate, GoalRoleBindings, Objective, TrialRecord } from '../goals';
import { clamp01, linearScore, mean, rsdPercent } from './math';
import { orderedTransfers, trialReferenceQuantities } from './signals';
import type { RubricDimensionScore, ScoreBand, ScoreBreakdown } from './types';

export interface ScoringRoles {
  readonly burette?: string;
  readonly flask?: string;
}

const DEFAULT_ROLES: Required<ScoringRoles> = { burette: 'burette', flask: 'flask' };

const WEIGHTS: Readonly<Record<RubricDimensionScore['id'], number>> = {
  setup: 0.25,
  instrumentOperation: 0.2,
  endpointDetection: 0.25,
  measurementRepeatability: 0.15,
  interpretation: 0.15,
};

/** The region around the equivalence point, as a fraction of it, where fine control matters most. */
const NEAR_BAND_FRACTION = 0.15;
/** A careful, dropwise addition this close to equivalence: full marks for control. */
const GOOD_NEAR_INCREMENT_L = 0.0005;
/** A large, uncontrolled addition this close to equivalence: zero marks for control. */
const POOR_NEAR_INCREMENT_L = 0.004;
/** Delivering this many times the equivalence volume before any endpoint mark counts as an overshoot. */
const OVERSHOOT_RATIO = 1.5;

function classify(predicate: GoalPredicate): 'setup' | 'operation' | 'endpoint' | 'trials' | 'other' {
  switch (predicate.kind) {
    case 'apparatusPlaced':
    case 'hasConnection':
    case 'capabilityPresent':
    case 'relativePosition':
    case 'containerSpecies':
      return 'setup';
    case 'valveOperated':
    case 'deliveredVolumeWithin':
      return 'operation';
    case 'endpointCaptured':
    case 'observationRecorded':
    case 'runSucceeded':
      return 'endpoint';
    case 'repeatTrialsAtLeast':
      return 'trials';
    case 'all':
    case 'any': {
      const cats = predicate.of.map(classify);
      return cats.every((c) => c === cats[0]) ? (cats[0] ?? 'other') : 'other';
    }
    case 'not':
      return classify(predicate.of);
    default:
      return 'other';
  }
}

function scoreSetup(objective: Objective, ctx: EvaluationContext): RubricDimensionScore {
  const evaluation = evaluateObjective(objective, ctx);
  const setupSteps = evaluation.steps.filter((s) => classify(s.step.predicate) === 'setup');
  const score01 = setupSteps.length === 0 ? 1 : setupSteps.filter((s) => s.result.met).length / setupSteps.length;
  const unmet = setupSteps.filter((s) => !s.result.met).map((s) => s.step.title);
  return {
    id: 'setup',
    label: 'Apparatus setup',
    score01,
    weight: WEIGHTS.setup,
    evidence: setupSteps.length === 0 ? 'ILLUSTRATIVE' : 'MODEL_CALCULATED',
    detail: unmet.length === 0 ? 'All required apparatus correctly placed and connected.' : `Still missing: ${unmet.join(', ')}.`,
  };
}

function instrumentOperationForTrial(trial: TrialRecord, roles: Required<ScoringRoles>, bindings: GoalRoleBindings): { readonly score01: number; readonly flag: string | null } {
  const sourceId = bindings[roles.burette];
  const receiverId = bindings[roles.flask];
  const transfers = orderedTransfers(trial.events, { sourceId, receiverId });
  if (transfers.length === 0) return { score01: 0, flag: 'No titrant delivered yet.' };

  const granularity01 = clamp01(transfers.length / 8);
  const equivalence = equivalenceVolumeL(trial.runResults);
  let cumulative = 0;
  const nearIncrements: number[] = [];
  let overshootFlag = false;
  for (const t of transfers) {
    const before = cumulative;
    cumulative += t.volumeL;
    if (equivalence !== undefined && equivalence > 0) {
      const band = equivalence * NEAR_BAND_FRACTION;
      if (cumulative >= equivalence - band && before <= equivalence + band) nearIncrements.push(t.volumeL);
      if (cumulative > equivalence * OVERSHOOT_RATIO && before <= equivalence * OVERSHOOT_RATIO) overshootFlag = true;
    }
  }
  const controlRatio = nearIncrements.length > 0 ? linearScore(mean(nearIncrements), GOOD_NEAR_INCREMENT_L, POOR_NEAR_INCREMENT_L) : 1;
  let score01 = clamp01(0.5 * granularity01 + 0.5 * controlRatio);
  if (overshootFlag) score01 *= 0.6;
  return { score01, flag: overshootFlag ? 'Overshot well past the equivalence point before slowing down.' : null };
}

function scoreInstrumentOperation(ctx: EvaluationContext, bindings: GoalRoleBindings, roles: Required<ScoringRoles>): RubricDimensionScore {
  if (ctx.trials.length === 0) {
    return { id: 'instrumentOperation', label: 'Instrument operation', score01: 0, weight: WEIGHTS.instrumentOperation, evidence: 'UNSUPPORTED', detail: 'No trial recorded yet.' };
  }
  const perTrial = ctx.trials.map((t) => instrumentOperationForTrial(t, roles, bindings));
  const flag = perTrial.map((p) => p.flag).find((f): f is string => f !== null);
  return {
    id: 'instrumentOperation',
    label: 'Instrument operation',
    score01: mean(perTrial.map((p) => p.score01)),
    weight: WEIGHTS.instrumentOperation,
    evidence: 'MODEL_CALCULATED',
    detail: flag ?? 'Titrant delivered with fine, controlled increments near the endpoint.',
  };
}

function endpointDetectionForTrial(trial: TrialRecord): number | null {
  const mark = trial.endpoint;
  if (!mark) return null;
  const equivalence = equivalenceVolumeL(trial.runResults);
  if (equivalence === undefined) return null;
  const deviationL = Math.abs(mark.deliveredVolumeL - equivalence);
  // Within 0.2 mL of the computed equivalence point: full marks. 1.5 mL or more away: zero.
  return linearScore(deviationL, 0.0002, 0.0015);
}

function scoreEndpointDetection(ctx: EvaluationContext): RubricDimensionScore {
  const scores = ctx.trials.map(endpointDetectionForTrial).filter((s): s is number => s !== null);
  if (scores.length === 0) {
    return {
      id: 'endpointDetection',
      label: 'Endpoint detection',
      score01: 0,
      weight: WEIGHTS.endpointDetection,
      evidence: 'UNSUPPORTED',
      detail: 'No endpoint has been marked against a computed equivalence point yet.',
    };
  }
  return {
    id: 'endpointDetection',
    label: 'Endpoint detection',
    score01: mean(scores),
    weight: WEIGHTS.endpointDetection,
    evidence: 'MODEL_CALCULATED',
    detail: `Average deviation-based score over ${scores.length} trial(s), compared with the solver's computed equivalence point.`,
  };
}

function scoreRepeatability(ctx: EvaluationContext): RubricDimensionScore {
  const volumes = ctx.trials.map((t) => t.endpoint?.deliveredVolumeL).filter((v): v is number => v !== undefined);
  if (volumes.length < 2) {
    return {
      id: 'measurementRepeatability',
      label: 'Measurement repeatability',
      score01: 0,
      weight: WEIGHTS.measurementRepeatability,
      evidence: 'UNVERIFIED',
      detail: `Need at least 2 completed trials to assess repeatability (have ${volumes.length}).`,
    };
  }
  const rsd = rsdPercent(volumes);
  return {
    id: 'measurementRepeatability',
    label: 'Measurement repeatability',
    // A relative standard deviation of 1% or better is excellent hand-titration technique; 5%+ is poor.
    score01: linearScore(rsd, 1, 5),
    weight: WEIGHTS.measurementRepeatability,
    evidence: 'MODEL_CALCULATED',
    detail: `Relative standard deviation across ${volumes.length} trials: ${rsd.toFixed(2)}%.`,
  };
}

function interpretationForTrial(trial: TrialRecord): number | null {
  const ref = trialReferenceQuantities(trial);
  if (ref.titrantMolarityMolPerL === undefined || !ref.analyteVolumeL) return null;
  if (trial.reportedAnalyteMolarity === undefined || trial.endpoint === null) return null;
  const expected = (ref.titrantMolarityMolPerL * trial.endpoint.deliveredVolumeL) / ref.analyteVolumeL;
  if (!(expected > 0)) return null;
  const relativeError = Math.abs(trial.reportedAnalyteMolarity - expected) / expected;
  // Within 2% relative error of the molarity implied by the measured equivalence volume: full marks.
  return linearScore(relativeError, 0.02, 0.2);
}

function scoreInterpretation(ctx: EvaluationContext): RubricDimensionScore {
  const scores = ctx.trials.map(interpretationForTrial).filter((s): s is number => s !== null);
  if (scores.length === 0) {
    return {
      id: 'interpretation',
      label: 'Interpretation',
      score01: 0,
      weight: WEIGHTS.interpretation,
      evidence: 'UNSUPPORTED',
      detail: 'Submit a concentration conclusion to be scored against the measured equivalence point.',
    };
  }
  return {
    id: 'interpretation',
    label: 'Interpretation',
    score01: mean(scores),
    weight: WEIGHTS.interpretation,
    evidence: 'MODEL_CALCULATED',
    detail: `Conclusion compared against the analyte molarity implied by the measured equivalence volume, over ${scores.length} trial(s).`,
  };
}

function bandFor(overall01: number): ScoreBand {
  if (overall01 >= 0.85) return 'exemplary';
  if (overall01 >= 0.65) return 'proficient';
  if (overall01 >= 0.4) return 'developing';
  return 'novice';
}

/** Pure, deterministic: the same objective and the same saved event/run/trial data always score the same. */
export function scoreAttempt(objective: Objective, ctx: EvaluationContext, roles: ScoringRoles = {}): ScoreBreakdown {
  const resolvedRoles: Required<ScoringRoles> = { ...DEFAULT_ROLES, ...roles };
  const evaluation = evaluateObjective(objective, ctx);
  const dimensions: readonly RubricDimensionScore[] = [
    scoreSetup(objective, ctx),
    scoreInstrumentOperation(ctx, evaluation.bindings, resolvedRoles),
    scoreEndpointDetection(ctx),
    scoreRepeatability(ctx),
    scoreInterpretation(ctx),
  ];
  const overall01 = dimensions.reduce((sum, d) => sum + d.score01 * d.weight, 0);
  return {
    overall01,
    band: bandFor(overall01),
    dimensions,
    basedOnEventCount: ctx.events.length,
    basedOnTrialCount: ctx.trials.length,
    computedAtSimulationS: ctx.nowSimulationS,
    deterministic: true,
  };
}
