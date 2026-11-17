/**
 * Dynamic resolution: drops the device-pixel ratio when frames run long and restores it once
 * there is headroom, within a quality preset's `dpr` range. Same technique as the molecular
 * editor's `render/FrameHooks.tsx#FrameEnd`, generalised to take any `PerfMonitor` and range so it
 * is not coupled to that store's `QualityId`.
 */
import { useThree, useFrame } from '@react-three/fiber';
import { useRef } from 'react';
import type { PerfMonitor } from './FrameInstrumentation';

export interface AdaptiveResolutionProps {
  readonly dprRange: readonly [number, number];
  readonly monitor: PerfMonitor;
}

const STEP = 0.125;
/** Frame budget edges (ms) that trigger a downward/upward resolution step; matches a 46-77 fps band. */
const SLOW_FRAME_MS = 21.5;
const FAST_FRAME_MS = 13;

export function AdaptiveResolution({ dprRange, monitor }: AdaptiveResolutionProps) {
  const setDpr = useThree((s) => s.setDpr);
  const tuning = useRef({ slowSince: 0, fastSince: 0, changedAt: 0 });

  useFrame(({ viewport }) => {
    const frameMs = monitor.recentFrameMs();
    if (frameMs === 0) return;
    const now = performance.now();
    const t = tuning.current;
    const [min, max] = dprRange;
    const ceiling = Math.min(max, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : max);
    const current = viewport.dpr;
    if (now - t.changedAt < 1200) return;

    if (frameMs > SLOW_FRAME_MS && current > min + 1e-3) {
      t.fastSince = 0;
      if (t.slowSince === 0) t.slowSince = now;
      else if (now - t.slowSince > 450) {
        setDpr(Math.max(min, current - STEP));
        t.changedAt = now;
        t.slowSince = 0;
        monitor.reset();
      }
    } else if (frameMs < FAST_FRAME_MS && current < ceiling - 1e-3) {
      t.slowSince = 0;
      if (t.fastSince === 0) t.fastSince = now;
      else if (now - t.fastSince > 2500) {
        setDpr(Math.min(ceiling, current + STEP));
        t.changedAt = now;
        t.fastSince = 0;
        monitor.reset();
      }
    } else {
      t.slowSince = 0;
      t.fastSince = 0;
    }
  }, 1000);

  return null;
}
