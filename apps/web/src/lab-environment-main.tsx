import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource-variable/space-grotesk';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { LabEnvironmentHarness } from './lab/environment/harness/LabEnvironmentHarness';
import { installLabEnvironmentTestApi } from './lab/environment/harness/testApi';
import './styles/app.css';
import './lab/environment/harness/harness.css';

if (import.meta.env.DEV || import.meta.env.VITE_TEST_API === '1') installLabEnvironmentTestApi();

createRoot(document.getElementById('lab-root')!).render(
  <StrictMode>
    <LabEnvironmentHarness />
  </StrictMode>,
);

