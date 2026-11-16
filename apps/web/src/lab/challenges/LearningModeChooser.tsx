import { useId } from 'react';
import { LEARNING_MODES } from './definition.ts';
import type { ChallengeMode } from './types.ts';

export function LearningModeChooser({ mode, onChange }: { readonly mode: ChallengeMode; readonly onChange: (mode: ChallengeMode) => void }) {
  const groupId = useId();
  return <fieldset className="mlab-learning__modes">
    <legend>Experiment mode</legend>
    {LEARNING_MODES.map((choice) => <label key={choice.id} className="mlab-learning__mode">
      <input type="radio" name={groupId} value={choice.id} checked={mode === choice.id} onChange={() => onChange(choice.id)} />
      <span><strong>{choice.label}</strong><span>{choice.description}</span></span>
    </label>)}
  </fieldset>;
}
