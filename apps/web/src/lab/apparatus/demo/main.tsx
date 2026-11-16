/**
 * Dev-only mount point for the apparatus showcase demo (`apparatus-demo.html`). Not referenced by
 * `src/main.tsx` or any shipping entry point.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApparatusShowcaseApp } from './ApparatusShowcaseApp';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ApparatusShowcaseApp />
  </StrictMode>,
);
