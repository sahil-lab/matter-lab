/** Evaluates a whole `Objective` (its ordered steps) against one `EvaluationContext`. */

import type { ApparatusLabelLookup } from '../contracts';
import { evaluatePredicate } from './evaluate';
import type { EvaluationContext, GoalRoleBindings, GoalStep, Objective, PredicateResult } from './types';

export interface StepEvaluation {
  readonly step: GoalStep;
  readonly index: number;
  readonly result: PredicateResult;
}

export interface ObjectiveEvaluation {
  readonly objective: Objective;
  readonly steps: readonly StepEvaluation[];
  readonly bindings: GoalRoleBindings;
  readonly completedCount: number;
  readonly totalCount: number;
  /** Index of the first unmet step, or -1 when every step is met. Guided mode hints point here. */
  readonly firstUnmetIndex: number;
  readonly trialsCompleted: number;
  readonly trialsRequired: number;
  /** All steps met and (for Precision mode) enough trials recorded. */
  readonly complete: boolean;
}

/**
 * Threads role bindings through the objective's steps in order, so a later step ("connect burette
 * to clamp") can refer to a role a previous step bound ("place a burette"). Pure function of
 * `ctx`: re-running it against the same event log always reproduces the same evaluation.
 */
export function evaluateObjective(objective: Objective, ctx: EvaluationContext, labels?: ApparatusLabelLookup): ObjectiveEvaluation {
  let bindings: GoalRoleBindings = {};
  const steps: StepEvaluation[] = objective.steps.map((step, index) => {
    const result = evaluatePredicate(step.predicate, ctx, bindings, labels);
    bindings = result.bindings;
    return { step, index, result };
  });
  const completedCount = steps.filter((s) => s.result.met).length;
  const firstUnmetIndex = steps.findIndex((s) => !s.result.met);
  const trialsCompleted = ctx.trials.filter((t) => t.endpoint !== null).length;
  const trialsRequired = objective.requiredTrials;
  return {
    objective,
    steps,
    bindings,
    completedCount,
    totalCount: steps.length,
    firstUnmetIndex,
    trialsCompleted,
    trialsRequired,
    complete: completedCount === steps.length && trialsCompleted >= trialsRequired,
  };
}
