/**
 * MATTER LAB — Astra motion system (Agent 01: Creative Direction and UI).
 *
 * One shared API for every animated transition in the lab UI, so "smooth scene transitions" are a
 * property of this module, not ad-hoc per-component DOM timers. Everything here respects both the
 * OS `prefers-reduced-motion` setting and the in-app "Reduce motion" toggle (persisted to
 * localStorage), collapsing durations to near-zero without changing layout or removing content.
 */
import { useEffect, useState } from 'react';
import { ASTRA_DURATION, ASTRA_EASE } from './tokens';

const STORAGE_KEY = 'astra-lab:reduced-motion';

function readStoredPreference(): boolean | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === null ? null : raw === '1';
  } catch {
    // Storage can throw in locked-down contexts (private browsing, disabled storage); fall back
    // to the OS preference only.
    return null;
  }
}

function systemPrefersReduced(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Whether motion should be minimised right now: the explicit in-app choice if the user has made
 * one, otherwise the operating system's setting.
 */
export function prefersReducedMotion(): boolean {
  const stored = readStoredPreference();
  return stored ?? systemPrefersReduced();
}

/** Persists the user's explicit choice; pass `null` to defer back to the OS setting. */
export function setReducedMotionPreference(value: boolean | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (value === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
  } catch {
    // Ignored: the toggle still works for the current page load via React state.
  }
  document.documentElement.dataset.astraMotion = prefersReducedMotion() ? 'reduced' : 'full';
  window.dispatchEvent(new CustomEvent('astra:motion-preference'));
}

/** Reactive read of {@link prefersReducedMotion}, updating on OS changes and in-app toggles. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => prefersReducedMotion());
  useEffect(() => {
    const update = () => setReduced(prefersReducedMotion());
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    media?.addEventListener('change', update);
    window.addEventListener('astra:motion-preference', update);
    update();
    return () => {
      media?.removeEventListener('change', update);
      window.removeEventListener('astra:motion-preference', update);
    };
  }, []);
  return reduced;
}

/** Applies the current preference to `documentElement.dataset.astraMotion`; call once at startup. */
export function initMotionPreference(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.astraMotion = prefersReducedMotion() ? 'reduced' : 'full';
}

export type MotionDurationKey = keyof typeof ASTRA_DURATION;

/** A duration in milliseconds, collapsed to 0 when motion should be minimised. */
export function duration(key: MotionDurationKey, reduced = prefersReducedMotion()): number {
  return reduced ? 0 : ASTRA_DURATION[key];
}

/** A ready-to-use CSS `transition` value, e.g. `transitionFor('base', 'transform, opacity')`. */
export function transitionFor(key: MotionDurationKey, properties: string, ease: keyof typeof ASTRA_EASE = 'standard'): string {
  return properties
    .split(',')
    .map((prop) => `${prop.trim()} ${ASTRA_DURATION[key]}ms ${ASTRA_EASE[ease]}`)
    .join(', ');
}

/** Resolves once, after `duration(key)` milliseconds — immediately when motion is reduced. */
export function afterMotion(key: MotionDurationKey, reduced?: boolean): Promise<void> {
  const ms = duration(key, reduced);
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => window.setTimeout(resolve, ms));
}
