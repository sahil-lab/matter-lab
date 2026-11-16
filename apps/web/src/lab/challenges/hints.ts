import type { ChallengeView, LearningActionRequest, LearningHighlight } from './types.ts';

export function goalHighlight(
  view: ChallengeView, goalId: string, options: { readonly reducedMotion: boolean; readonly focus?: boolean },
): LearningHighlight | null {
  const goal = view.attempt.definition.goals.find((entry) => entry.id === goalId);
  if (!goal) return null;
  const instanceIds = goal.highlightRoles.flatMap((role) => {
    const instanceId = view.trial.bindings[role];
    return instanceId && view.trial.frame.scene.apparatus.some((instance) =>
      instance.id === instanceId && instance.stationId === view.trial.scope.stationId) ? [instanceId] : [];
  });
  const controlExists = goal.controlId && instanceIds.some((id) => {
    const instance = view.trial.frame.scene.apparatus.find((entry) => entry.id === id);
    return view.trial.definitions.find((entry) => entry.id === instance?.definitionId)?.controls.some((control) => control.id === goal.controlId);
  });
  return {
    instanceIds: [...new Set(instanceIds)], caption: goal.hint,
    ...(controlExists ? { controlId: goal.controlId } : {}),
    focus: options.focus ?? false, reducedMotion: options.reducedMotion,
  };
}

export function instructionAction(view: ChallengeView): LearningActionRequest | null {
  const instruction = view.attempt.definition.instructions[view.attempt.progression.instructionIndex];
  if (!instruction?.actionKind) return null;
  const goalId = instruction.goalIds.find((id) => view.evaluation.goals.some((goal) => goal.id === id && goal.state !== 'complete')) ?? instruction.goalIds[0];
  const goal = view.attempt.definition.goals.find((entry) => entry.id === goalId);
  const highlight = goalId ? goalHighlight(view, goalId, { reducedMotion: true }) : null;
  return {
    kind: instruction.actionKind, instanceIds: highlight?.instanceIds ?? [],
    ...(goalId ? { goalId } : {}),
    ...(goal?.highlightRoles[0] ? { role: goal.highlightRoles[0] } : {}),
    ...(highlight?.controlId ? { controlId: highlight.controlId } : {}),
  };
}
