import { ArrowRight } from 'lucide-react';
import { Button, Reveal, useReducedMotion } from '../../design-system';
import { markOnboardingSeen } from './store';

/**
 * The skippable first-run cinematic entry (brief §"Required implementation" 3). Returning users
 * never see this — `AstraLabRoot` only mounts it while `!onboardingSeen`. A reduced-motion
 * preference shows the same content without the staggered reveal.
 */
export function OnboardingIntro() {
  const reduced = useReducedMotion();
  const enter = () => markOnboardingSeen();

  return (
    <div
      className="astra-cinematic"
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to MATTER LAB Astra"
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          enter();
        } else if (e.key === 'Escape') {
          enter();
        }
      }}
    >
      <div className="astra-cinematic__backdrop" aria-hidden />
      <button type="button" className="astra-cinematic__skip" onClick={enter} data-testid="astra-onboarding-skip">
        Skip intro
      </button>
      <div className="astra-cinematic__content">
        <Reveal delayMs={reduced ? 0 : 120}>
          <p className="astra-eyebrow">MATTER LAB — Astra</p>
        </Reveal>
        <Reveal delayMs={reduced ? 0 : 420}>
          <h1 className="astra-cinematic__title">A laboratory, rebuilt in three dimensions.</h1>
        </Reveal>
        <Reveal delayMs={reduced ? 0 : 720}>
          <p className="astra-cinematic__sub">
            Arrange real apparatus, run supported chemistry, and read results labeled by how they were obtained. Nothing you see here is a scripted animation.
          </p>
        </Reveal>
        <Reveal delayMs={reduced ? 0 : 980}>
          <Button variant="cool" size="lg" onClick={enter} autoFocus data-testid="astra-onboarding-enter">
            Enter the lab <ArrowRight />
          </Button>
        </Reveal>
      </div>
    </div>
  );
}
