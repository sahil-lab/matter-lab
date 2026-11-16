import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource-variable/space-grotesk';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../styles/app.css';
import { ChallengesWorkspace } from './ui';

/**
 * Standalone dev/preview mount for this surface only (`lab-challenges-preview.html`), so Agent 08's
 * work can be run, clicked through and screenshotted before Agent 01's app shell and Agent 02's 3D
 * environment exist to host it for real. Not part of the production app entry (`src/main.tsx`),
 * and not wired into `App.tsx` — delete once Agent 10 integrates this surface into the real shell.
 */
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ChallengesWorkspace />
  </StrictMode>,
);
