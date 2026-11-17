/**
 * MATTER LAB — Astra lab shell: UI-only state (Agent 01: Creative Direction and UI).
 *
 * This store holds presentation state for the lab shell chrome only (panels, tabs, the chosen
 * camera/quality mode, playback scrubber position). It is deliberately independent of the v1
 * app's `state/store.ts` (a different, tightly-coupled document/undo store) and of Agent 07's
 * authoritative experiment runtime, which does not exist in this worktree yet. Nothing here is
 * scientific state: no inventory, no pH, no simulation time. Follows the same
 * `create` + `subscribeWithSelector` / imperative-wrapper pattern as `state/store.ts`.
 */
import type { JobStatus } from '@matterlab/core';
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { ASTRA_INSPECTOR_AUTOCOLLAPSE_WIDTH, ASTRA_PANEL_AUTOCOLLAPSE_WIDTH } from '../../design-system/tokens';

export type AstraCameraMode = 'orbit' | 'first-person' | 'top-down';
export type AstraQualityId = 'efficient' | 'balanced' | 'quality';
export type AstraInspectorTab = 'properties' | 'explain';
export type AstraExplainTab = 'method' | 'assumptions' | 'limitations' | 'references' | 'diagnostics';
export type AstraExplainLevel = 'simple' | 'advanced';
export type AstraLabMode = 'guided' | 'challenge' | 'free' | 'precision';

export interface AstraJobPreview {
  readonly id: string;
  readonly title: string;
  readonly detail?: string;
  readonly status: JobStatus;
  readonly progress: number | null;
  readonly startedAt: number;
}

export interface AstraToast {
  readonly id: number;
  readonly kind: 'info' | 'success' | 'warning' | 'error';
  readonly title: string;
}

const ONBOARDING_KEY = 'astra-lab:onboarding-seen';

function readOnboardingSeen(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return window.localStorage.getItem(ONBOARDING_KEY) === '1';
  } catch {
    return false;
  }
}

export interface AstraShellState {
  /** First-run cinematic: shown once per browser unless the user re-triggers it from the menu. */
  onboardingSeen: boolean;
  onboardingActive: boolean;

  libraryOpen: boolean;
  inspectorOpen: boolean;
  dockOpen: boolean;
  librarySearch: string;
  selectedDefinitionId: string | null;

  inspectorTab: AstraInspectorTab;
  explainTab: AstraExplainTab;
  explainLevel: AstraExplainLevel;

  cameraMode: AstraCameraMode;
  quality: AstraQualityId;
  labMode: AstraLabMode;

  /**
   * Watermarked sample-data preview, OFF by default. The shell's true default state has no
   * simulation connected; switching this on is an explicit, visible choice to see populated HUD
   * states with clearly-labeled illustrative numbers (see `demoData.ts`).
   */
  previewDemoData: boolean;

  playing: boolean;
  speed: number;
  /** Index into the current observation timeline; `null` means "live / latest". */
  scrubIndex: number | null;

  jobs: AstraJobPreview[];
  toasts: AstraToast[];
}

function initialState(): AstraShellState {
  const width = typeof window === 'undefined' ? ASTRA_INSPECTOR_AUTOCOLLAPSE_WIDTH : window.innerWidth;
  return {
    onboardingSeen: readOnboardingSeen(),
    onboardingActive: false,

    // Responsive defaults only: the viewport keeps its ~75-85% share at every gate resolution by
    // starting with less chrome on narrower screens. Either panel can still be opened manually at
    // any width (see the acceptance test "remains usable at 1280x800").
    libraryOpen: width >= ASTRA_PANEL_AUTOCOLLAPSE_WIDTH,
    inspectorOpen: width >= ASTRA_INSPECTOR_AUTOCOLLAPSE_WIDTH,
    dockOpen: false,
    librarySearch: '',
    selectedDefinitionId: null,

    inspectorTab: 'properties',
    explainTab: 'method',
    explainLevel: 'simple',

    cameraMode: 'orbit',
    quality: 'balanced',
    labMode: 'free',

    previewDemoData: false,

    playing: false,
    speed: 1,
    scrubIndex: null,

    jobs: [],
    toasts: [],
  };
}

export const useAstraLab = create<AstraShellState>()(subscribeWithSelector(initialState));

/** Imperative access for code outside React (test hook, keyboard shortcuts). */
export const astraLab = {
  get: useAstraLab.getState,
  set: useAstraLab.setState,
  subscribe: useAstraLab.subscribe,
};

export function markOnboardingSeen(): void {
  try {
    window.localStorage.setItem(ONBOARDING_KEY, '1');
  } catch {
    // Storage may be unavailable (private browsing); the session still proceeds past onboarding.
  }
  astraLab.set({ onboardingSeen: true, onboardingActive: false });
}

export function replayOnboarding(): void {
  astraLab.set({ onboardingActive: true });
}

let toastId = 0;
export function notifyAstra(kind: AstraToast['kind'], title: string): void {
  const id = ++toastId;
  astraLab.set((s) => ({ toasts: [...s.toasts, { id, kind, title }] }));
  window.setTimeout(() => dismissAstraToast(id), kind === 'error' ? 6000 : 3200);
}

export function dismissAstraToast(id: number): void {
  astraLab.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

let jobSeq = 0;
/** Enqueues a short, clearly-labeled demo job so the progress indicator has something to show. */
export function enqueueDemoJob(title: string, durationMs = 2400): string {
  const id = `demo-job-${++jobSeq}`;
  const startedAt = Date.now();
  astraLab.set((s) => ({ jobs: [{ id, title, detail: 'Sample preview task — no real computation runs.', status: 'running', progress: 0, startedAt }, ...s.jobs] }));
  const steps = 12;
  let step = 0;
  const timer = window.setInterval(() => {
    step++;
    const progress = Math.min(1, step / steps);
    astraLab.set((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, progress } : j)) }));
    if (step >= steps) {
      window.clearInterval(timer);
      astraLab.set((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, status: 'succeeded' as JobStatus, progress: 1 } : j)) }));
    }
  }, durationMs / steps);
  return id;
}

export function clearFinishedAstraJobs(): void {
  astraLab.set((s) => ({ jobs: s.jobs.filter((j) => j.status === 'running' || j.status === 'queued') }));
}
