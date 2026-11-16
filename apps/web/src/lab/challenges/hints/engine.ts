/**
 * Turns the first unmet step of an objective into a hint: a caption, an accessible (non-visual)
 * description, and highlight targets expressed through the Agent 02/03/04 contract stub. Stateless
 * and pure — "skip" / "dismiss" state lives in the mode store, not here.
 */

import type { ApparatusKind, ApparatusLabelLookup, HighlightTarget } from '../contracts';
import { DEFAULT_APPARATUS_LABEL_LOOKUP } from '../contracts';
import { evaluateObjective } from '../goals';
import type { EvaluationContext, GoalPredicate, GoalRoleBindings, GoalStep, Objective } from '../goals';

export interface HintDescriptor {
  readonly stepId: string;
  readonly stepIndex: number;
  readonly totalSteps: number;
  readonly title: string;
  readonly caption: string;
  /** Always meaningful on its own: never "look at the glowing thing", always what to do and why. */
  readonly accessibleText: string;
  readonly highlightTargets: readonly HighlightTarget[];
  readonly skippable: true;
}

export interface ChecklistItem {
  readonly stepId: string;
  readonly title: string;
  readonly instructions: string;
  readonly met: boolean;
  readonly detail: string;
  readonly current: boolean;
}

function collectRoleKinds(predicate: GoalPredicate, out: Record<string, ApparatusKind>): void {
  switch (predicate.kind) {
    case 'apparatusPlaced':
      out[predicate.role] = predicate.apparatusKind;
      return;
    case 'all':
    case 'any':
      for (const child of predicate.of) collectRoleKinds(child, out);
      return;
    case 'not':
      collectRoleKinds(predicate.of, out);
      return;
    default:
      return;
  }
}

function buildHighlightTargets(step: GoalStep, bindings: GoalRoleBindings): HighlightTarget[] {
  const kindsByRole: Record<string, ApparatusKind> = {};
  collectRoleKinds(step.predicate, kindsByRole);
  const targets: HighlightTarget[] = [];
  for (const role of step.highlightRoles) {
    const instanceId = bindings[role];
    const kind = kindsByRole[role];
    if (instanceId) targets.push({ kind: 'instance', instanceId });
    else if (kind) targets.push({ kind: 'paletteCategory', apparatusKind: kind });
  }
  return targets;
}

/** The next thing the learner should do, or `null` once every step of the objective is satisfied. */
export function deriveHint(objective: Objective, ctx: EvaluationContext, labels: ApparatusLabelLookup = DEFAULT_APPARATUS_LABEL_LOOKUP): HintDescriptor | null {
  const evaluation = evaluateObjective(objective, ctx, labels);
  if (evaluation.firstUnmetIndex === -1) return null;
  const current = evaluation.steps[evaluation.firstUnmetIndex]!;
  return {
    stepId: current.step.id,
    stepIndex: evaluation.firstUnmetIndex,
    totalSteps: evaluation.totalCount,
    title: current.step.title,
    caption: current.step.instructions,
    accessibleText: current.step.accessibleHint,
    highlightTargets: buildHighlightTargets(current.step, evaluation.bindings),
    skippable: true,
  };
}

/** A full, keyboard-navigable, non-3D checklist of every step — the accessible guided path. */
export function buildChecklist(objective: Objective, ctx: EvaluationContext, labels: ApparatusLabelLookup = DEFAULT_APPARATUS_LABEL_LOOKUP): readonly ChecklistItem[] {
  const evaluation = evaluateObjective(objective, ctx, labels);
  return evaluation.steps.map((s) => ({
    stepId: s.step.id,
    title: s.step.title,
    instructions: s.step.instructions,
    met: s.result.met,
    detail: s.result.detail,
    current: s.index === evaluation.firstUnmetIndex,
  }));
}
