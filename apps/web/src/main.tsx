import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource-variable/space-grotesk';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { restorePreferences, restoreSession } from './state/persistence';
import { lab } from './state/store';
import './styles/app.css';
import './styles/lab.css';

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
