/**
 * Frame-pacing/GPU-timing instrumentation for the dev harness, reusing the main application's
 * generic, scene-agnostic `PerfMonitor` (`render/perf.ts`) rather than re-implementing GPU timer
 * query bookkeeping. Two `useFrame` hooks bracket R3F's own render call: default priority runs
 * before it, priority `-1` runs after — the same technique `FrameHooks.tsx` uses for the main
 * canvas — so the GPU timer query actually covers the draw calls, not just this component's work.
 */
import { useFrame } from '@react-three/fiber';
import { PerfMonitor } from '../../../render/perf';
import type { PerfSnapshot } from '../../../render/perf';

export const fluidsPerfMonitor = new PerfMonitor();

export function PerfTracker() {
  useFrame(({ gl }) => {
    fluidsPerfMonitor.begin(gl);
  });
  useFrame(({ gl }) => {
    fluidsPerfMonitor.end(gl);
  }, -1);
  return null;
}

export function fluidsPerfSnapshot(): PerfSnapshot {
  return fluidsPerfMonitor.snapshot();
}
