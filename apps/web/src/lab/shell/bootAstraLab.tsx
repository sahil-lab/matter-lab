import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AstraLabRoot } from './AstraLabRoot';
import { Gallery } from './Gallery';
import * as contracts from './contracts';
import * as demoData from './demoData';
import { astraLab, markOnboardingSeen } from './store';

/**
 * Boots the Astra lab experience at `/lab` (the shell) and `/lab/gallery` (the component gallery),
 * independent of the v1 app's `bootMatterLab.tsx` so neither route's bundle pulls in the other's.
 */
export function bootAstraLab(pathname: string): void {
  if (import.meta.env.DEV || import.meta.env.VITE_TEST_API === '1') {
    installAstraTestApi();
  }
  const isGallery = pathname.startsWith('/lab/gallery');
  createRoot(document.getElementById('root')!).render(
    <StrictMode>{isGallery ? <Gallery /> : <AstraLabRoot />}</StrictMode>,
  );
}

/**
 * A window onto the running Astra lab for automated browser tests, matching the spirit of the v1
 * app's `window.__MATTERLAB__` (`testApi.ts`) but under its own namespace so neither can collide
 * with or depend on the other.
 */
function installAstraTestApi(): void {
  const api = { astraLab, markOnboardingSeen, contracts, demoData };
  (window as unknown as { __ASTRA_LAB__: typeof api }).__ASTRA_LAB__ = api;
}
