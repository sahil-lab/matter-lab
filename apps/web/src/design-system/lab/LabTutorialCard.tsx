import { ArrowLeft, ArrowRight, Check, Circle, CircleSlash, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { LabButton, LabTag } from './primitives';

export interface LabTutorialGoal {
  readonly id: string;
  readonly label: string;
  readonly state: 'pending' | 'current' | 'complete' | 'unsupported';
}

export interface LabTutorialCardProps {
  readonly title: string;
  readonly stepLabel: string;
  readonly children: ReactNode;
  readonly goals?: readonly LabTutorialGoal[];
  readonly onPrevious?: () => void;
  readonly onContinue?: () => void;
  readonly continueLabel?: string;
  readonly continueDisabled?: boolean;
  readonly disabledReason?: string;
  readonly onDismiss?: () => void;
}

/** Displays Agent08's decisions. It does not decide whether an action meets a challenge predicate. */
export function LabTutorialCard({ title, stepLabel, children, goals = [], onPrevious, onContinue, continueLabel = 'Continue', continueDisabled, disabledReason, onDismiss }: LabTutorialCardProps) {
  return (
    <section className="mlab-tutorial" aria-label={title}>
      <header><LabTag tone="warm">{stepLabel}</LabTag>{onDismiss && <LabButton icon size="sm" aria-label="Dismiss guide" onClick={onDismiss}><X /></LabButton>}</header>
      <h3>{title}</h3><div className="mlab-prose">{children}</div>
      {goals.length > 0 && <ul className="mlab-goals">{goals.map((goal) => {
        const Icon = goal.state === 'complete' ? Check : goal.state === 'unsupported' ? CircleSlash : Circle;
        return <li key={goal.id} data-state={goal.state}><Icon aria-hidden="true" /><span>{goal.label}</span><span className="mlab-sr-only">{goal.state}</span></li>;
      })}</ul>}
      {disabledReason && <p className="mlab-caption">{disabledReason}</p>}
      {(onPrevious || onContinue) && <footer>{onPrevious && <LabButton icon aria-label="Previous guide step" onClick={onPrevious}><ArrowLeft /></LabButton>}{onContinue && <LabButton variant="outline" disabled={continueDisabled} onClick={onContinue}>{continueLabel}<ArrowRight /></LabButton>}</footer>}
    </section>
  );
}
