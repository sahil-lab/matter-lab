import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource-variable/space-grotesk';

/**
 * The only routing this single-page app needs: `/lab` is the Astra 3D laboratory (Agent 01's
 * shell; see `lab/shell/bootAstraLab.tsx`), and everything else is the existing v1 MATTER LAB
 * application (`bootMatterLab.tsx`, unchanged). Both are dynamic imports so visiting one route
 * never downloads the other's bundle.
 */
if (window.location.pathname.startsWith('/lab')) {
  const pathname = window.location.pathname;
  void import('./lab/shell/bootAstraLab').then((m) => m.bootAstraLab(pathname));
} else {
  void import('./bootMatterLab').then((m) => m.bootMatterLab());
}
