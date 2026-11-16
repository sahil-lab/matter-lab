/**
 * UI/scenario state for the standalone fluids dev harness only (`/fluids-lab.html`). This is a
 * throwaway zustand store scoped to `dev/`; it has nothing to do with the main application's store
 * (`state/store.ts`) and nothing in production `lab/fluids` code reads from it.
 */
import { create } from 'zustand';
import type { IndicatorId } from '../color/indicatorColor';
import type { FluidQualityTier } from '../quality/fluidQuality';
import type { ScenarioId } from './fixtures';

interface DevState {
  readonly scenario: ScenarioId;
  /** Delivered titrant volume, mL, for the endpoint-titration scenario. */
  readonly deliveredMl: number;
  readonly dripping: boolean;
  /** Bumped by `reset()`; `DropletStream` clears its in-flight drops when this changes. */
  readonly resetCounter: number;
  readonly indicator: IndicatorId;
  readonly qualityTier: FluidQualityTier;
  readonly reducedMotion: boolean;
  readonly setScenario: (id: ScenarioId) => void;
  readonly setDeliveredMl: (ml: number) => void;
  readonly setDripping: (active: boolean) => void;
  readonly reset: () => void;
  readonly setIndicator: (id: IndicatorId) => void;
  readonly setQualityTier: (tier: FluidQualityTier) => void;
  readonly setReducedMotion: (value: boolean) => void;
}

export const MAX_DELIVERED_ML = 50;

export const useDevStore = create<DevState>((set) => ({
  scenario: 'endpoint-titration',
  deliveredMl: 0,
  dripping: false,
  resetCounter: 0,
  indicator: 'phenolphthalein',
  qualityTier: 'quality',
  reducedMotion: false,
  setScenario: (scenario) => set({ scenario }),
  setDeliveredMl: (ml) => set({ deliveredMl: Math.min(Math.max(ml, 0), MAX_DELIVERED_ML) }),
  setDripping: (dripping) => set({ dripping }),
  reset: () => set((s) => ({ deliveredMl: 0, dripping: false, resetCounter: s.resetCounter + 1 })),
  setIndicator: (indicator) => set({ indicator }),
  setQualityTier: (qualityTier) => set({ qualityTier }),
  setReducedMotion: (reducedMotion) => set({ reducedMotion }),
}));

/**
 * Plain mutable fields the render loop updates every frame (droplet counts, ...). Deliberately not
 * part of the zustand store above: a React re-render on every frame would defeat the point of
 * `lab/fluids` rendering on an imperative `useFrame`. Playwright reads these through `devApi.ts`.
 */
export const devTelemetry = {
  activeDroplets: 0,
  /** The burette's own rendered current-reading tag (GraduationMarks), or `null` when ungraduated/empty. */
  buretteReadingML: null as number | null,
};

/**
 * World-to-screen projection for the harness's live camera, refreshed every frame by a small
 * bridge component inside the `<Canvas>` (see `FluidsDevApp.tsx`). Lets Playwright tests find the
 * CSS-pixel location of a known 3D point (e.g. "inside the flask liquid") to sample a real
 * rendered pixel, without hardcoding screen coordinates that would break if the camera moved.
 */
export const devProjection: { project: ((point: readonly [number, number, number]) => readonly [number, number]) | null } = {
  project: null,
};
