import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { restorePreferences, restoreSession } from './state/persistence';
import { lab } from './state/store';
import './styles/app.css';
import './styles/lab.css';

/**
 * Boots the existing v1 MATTER LAB application (the molecular editor, reaction laboratory and
 * discovery vault). Moved out of `main.tsx` unchanged so that visiting `/lab` (the Astra 3D
 * laboratory, see `lab/shell/bootAstraLab.tsx`) does not pull this app's bundle — and vice versa.
 */
export function bootMatterLab(): void {
  const hasQualityPreference = restorePreferences();
  restoreSession();
  // A restored session is the baseline, not an unsaved change.
  lab.set((s) => ({ savedRevision: s.revision }));

  if (import.meta.env.DEV || import.meta.env.VITE_TEST_API === '1') {
    void import('./testApi').then((m) => m.installTestApi());
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App hasQualityPreference={hasQualityPreference} />
    </StrictMode>,
  );
}
