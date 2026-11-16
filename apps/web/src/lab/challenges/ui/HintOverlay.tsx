import type { HintDescriptor } from '../hints';

function describeTarget(target: HintDescriptor['highlightTargets'][number]): string {
  switch (target.kind) {
    case 'paletteCategory':
      return `Find a ${target.apparatusKind.toLowerCase()} in the apparatus library.`;
    case 'instance':
      return 'Look at the highlighted part in the scene.';
    case 'control':
      return `Use the ${target.controlId} control.`;
    default:
      return '';
  }
}

/**
 * Context-sensitive hint for Guided mode. The caption and `accessibleText` always carry the full
 * instruction on their own — the 3D highlight (once Agent 02/03/04 exist) is a supplement, never
 * the only way to know what to do next. Skippable via the "Hide hints" toggle in the parent.
 */
export function HintOverlay({ hint }: { hint: HintDescriptor | null }) {
  return (
    <div className="lc-hint">
      <span className="lc-label">Guided hint</span>
      <div aria-live="polite">
        {hint ? (
          <div className="lc-hint__body">
            <span className="lc-hint__step">
              Step {hint.stepIndex + 1} of {hint.totalSteps}
            </span>
            <h3>{hint.title}</h3>
            <p>{hint.caption}</p>
            {hint.highlightTargets.map((target, i) => (
              <p className="lc-hint__target" key={i}>
                {describeTarget(target)}
              </p>
            ))}
            <p className="lc-sr-only">{hint.accessibleText}</p>
          </div>
        ) : (
          <p className="lc-hint__done">Every step of this objective is satisfied.</p>
        )}
      </div>
    </div>
  );
}
