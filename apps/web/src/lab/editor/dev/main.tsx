import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { LabEditorHarness } from '../components/LabEditorHarness';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LabEditorHarness />
  </StrictMode>,
);
