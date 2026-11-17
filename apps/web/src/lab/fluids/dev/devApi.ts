/**
 * A small window hook for Playwright tests driving the standalone fluids dev harness, mirroring
 * the pattern of the main application's `src/testApi.ts` (same idea: expose just enough of the
 * running app for assertions) but entirely separate from it — only `dev/main.tsx` installs this,
 * never the main application.
 */
import { devProjection, devTelemetry, useDevStore } from './devStore';
import type { ScenarioId } from './fixtures';
import { fluidsPerfMonitor, fluidsPerfSnapshot } from './PerfTracker';

export function installFluidsDevApi(): void {
  const api = {
    getState: () => useDevStore.getState(),
    setScenario: (id: ScenarioId) => useDevStore.getState().setScenario(id),
    setDeliveredMl: (ml: number) => useDevStore.getState().setDeliveredMl(ml),
    setDripping: (active: boolean) => useDevStore.getState().setDripping(active),
    reset: () => useDevStore.getState().reset(),
    activeDroplets: () => devTelemetry.activeDroplets,
    buretteReadingML: () => devTelemetry.buretteReadingML,
    /** CSS-pixel screen location of a world-space point under the live camera, or `null` before the first frame. */
    projectWorldPoint: (point: readonly [number, number, number]) => devProjection.project?.(point) ?? null,
    perfSnapshot: () => fluidsPerfSnapshot(),
    resetPerf: () => fluidsPerfMonitor.reset(),
  };
  (window as unknown as { __FLUIDS_LAB__: typeof api }).__FLUIDS_LAB__ = api;
}
