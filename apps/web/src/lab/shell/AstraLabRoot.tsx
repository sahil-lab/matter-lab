import '../../design-system/tokens.css';
import '../../design-system/primitives.css';
import './shell.css';
import { useEffect } from 'react';
import { initMotionPreference } from '../../design-system';
import { AstraLabShell } from './AstraLabShell';
import { OnboardingIntro } from './OnboardingIntro';
import { useAstraLab } from './store';

/**
 * Entry point for the Astra lab experience: a premium, skippable cinematic for first-time
 * visitors and a no-delay return straight to the shell afterwards (brief §"Required
 * implementation" 3). Mounted at the `/lab` route by `main.tsx`, independent of the v1 app's root.
 */
export function AstraLabRoot() {
  const onboardingSeen = useAstraLab((s) => s.onboardingSeen);
  const onboardingActive = useAstraLab((s) => s.onboardingActive);

  useEffect(() => {
    initMotionPreference();
  }, []);

  const showOnboarding = !onboardingSeen || onboardingActive;
  return (
    <div className="astra-root" data-astra-lab-root>
      <AstraLabShell />
      {showOnboarding && <OnboardingIntro />}
    </div>
  );
}
