import { LabTutorialCard } from '../../design-system/lab/LabTutorialCard';
import { useLabMotion } from '../../design-system/lab/motion';
import { LabButton } from '../../design-system/lab/primitives';
import { goalHighlight, instructionAction } from './hints.ts';
import type { ChallengeController, LearningActionRequest, LearningHighlight } from './types.ts';
import { useChallenge } from './useChallenge.ts';
import './learning.css';

export interface LabGuidedTutorialProps {
  readonly controller: ChallengeController;
  readonly onHighlight?: (highlight: LearningHighlight) => void;
  readonly onActionRequest?: (request: LearningActionRequest) => void;
}

/** Render directly in Agent01 LabShell.tutorial. Navigation never modifies evidence or goals. */
export function LabGuidedTutorial({ controller, onHighlight, onActionRequest }: LabGuidedTutorialProps) {
  const view = useChallenge(controller);
  const motion = useLabMotion();
  const { attempt } = view;
  if (attempt.mode !== 'guided' || attempt.progression.dismissed) return null;
  const index = attempt.progression.instructionIndex;
  const step = attempt.definition.instructions[index]!;
  const results = view.evaluation.goals.filter((goal) => step.goalIds.includes(goal.id));
  const hintGoal = results.find((goal) => goal.state !== 'complete')?.id ?? results[0]?.id;
  const action = instructionAction(view);
  return <div className="mlab-learning" data-motion={motion.reduced ? 'reduced' : 'full'}>
    <LabTutorialCard title={step.title} stepLabel={`Guide ${index + 1} / ${attempt.definition.instructions.length}`}
      goals={results.map((goal) => ({ id: goal.id, label: goal.label, state: goal.state === 'pending' && goal.id === hintGoal ? 'current' : goal.state }))}
      onPrevious={index > 0 ? () => controller.setInstructionIndex(index - 1) : undefined}
      onContinue={index < attempt.definition.instructions.length - 1 ? () => controller.setInstructionIndex(index + 1) : undefined}
      continueLabel="Read next instruction"
      onDismiss={() => controller.dismissGuide(true)}>
      <p>{step.caption}</p>
      <p className="mlab-caption">You may read ahead or skip the guide. Only accepted laboratory actions and supported observations complete goals.</p>
      {hintGoal && <LabButton size="sm" variant="outline" onClick={() => {
        controller.requestHint(hintGoal);
        const hint = goalHighlight(view, hintGoal, { reducedMotion: motion.reduced });
        if (hint) onHighlight?.(hint);
      }}>Show a context hint</LabButton>}
      {hintGoal && attempt.progression.hintsRequested.includes(hintGoal) &&
        <p className="mlab-learning__hint" role="status">{attempt.definition.goals.find((goal) => goal.id === hintGoal)?.hint}</p>}
      {action && onActionRequest && <LabButton size="sm" onClick={() => onActionRequest(action)}>Open accessible apparatus controls</LabButton>}
    </LabTutorialCard>
  </div>;
}
