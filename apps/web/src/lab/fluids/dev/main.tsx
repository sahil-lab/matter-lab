import { createRoot } from 'react-dom/client';
import { FluidsDevApp } from './FluidsDevApp';

// Installed only for this standalone harness, in development or the dedicated e2e build — a normal
// production build of the main application never imports anything under lab/fluids/dev.
if (import.meta.env.DEV || import.meta.env.VITE_TEST_API === '1') {
  void import('./devApi').then((m) => m.installFluidsDevApi());
}

// Deliberately not wrapped in <StrictMode>: its double-invoked mount/unmount cycle on first render
// races with @react-three/drei's <Html>, which creates its own nested ReactDOM root per instance
// (GraduationMarks renders several) — under React 19 that produces spurious "synchronously unmount
// a root while React was already rendering" console errors here. This harness has no production
// code path of its own to protect with StrictMode; the main application keeps it in `src/main.tsx`.
createRoot(document.getElementById('fluids-dev-root')!).render(<FluidsDevApp />);
