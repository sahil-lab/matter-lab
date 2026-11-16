import { createContext, useContext, useMemo, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { LabMotionPreference } from './types';

export interface LabMotion {
  readonly reduced: boolean;
  readonly durationMs: number;
  readonly cameraDurationS: number;
  readonly entryDurationMs: number;
  readonly easing: readonly [number, number, number, number];
}

const EASING = [0.2, 0.7, 0.2, 1] as const;

export function resolveLabMotion(preference: LabMotionPreference, systemReduced: boolean): LabMotion {
  // A system accessibility preference is a floor, not something a cinematic setting overrides.
  const reduced = preference === 'reduced' || systemReduced;
  return { reduced, durationMs: reduced ? 0 : 220, cameraDurationS: reduced ? 0 : 0.75, entryDurationMs: reduced ? 0 : 1800, easing: EASING };
}

function subscribeToMotion(listener: () => void) {
  const query = window.matchMedia('(prefers-reduced-motion: reduce)');
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}

function getSystemMotion() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const MotionContext = createContext<LabMotion>(resolveLabMotion('system', true));

export function LabMotionProvider({ preference = 'system', children }: { preference?: LabMotionPreference; children: ReactNode }) {
  const systemReduced = useSyncExternalStore(
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? subscribeToMotion : () => () => undefined,
    getSystemMotion,
    () => true,
  );
  const motion = useMemo(() => resolveLabMotion(preference, systemReduced), [preference, systemReduced]);
  return <MotionContext.Provider value={motion}>{children}</MotionContext.Provider>;
}

export function useLabMotion(): LabMotion {
  return useContext(MotionContext);
}
