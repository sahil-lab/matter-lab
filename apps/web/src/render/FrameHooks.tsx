import { useFrame, useThree } from '@react-three/fiber';
import { useRef } from 'react';
import type { ToneMapping } from 'three';
import { fulfilCaptures, hasPendingCapture } from './capture';
import { perfMonitor } from './perf';
import type { QualitySettings } from './quality';

/** Runs before anything else in a frame: starts the performance measurements. */
export function FrameStart({ toneMapping }: { toneMapping: ToneMapping }) {
  useFrame(({ gl }) => {
    // The frame is assembled from several render calls, so statistics are reset once per frame here.
    gl.info.autoReset = false;
    if (gl.toneMapping !== toneMapping) gl.toneMapping = toneMapping;
    perfMonitor.begin(gl);
  }, -1000);
  return null;
}

/** Draws the scene straight to the screen. Used by the pipeline without post-processing. */
export function DirectRender() {
  useFrame(({ gl, scene, camera }) => {
    gl.render(scene, camera);
  }, 1);
  return null;
}

const STEP = 0.125;

/**
 * Runs after the frame has been drawn: finishes the measurements, serves screenshot requests while
 * the drawing buffer is still readable, and nudges the pixel ratio to hold the frame-rate target.
 */
export function FrameEnd({ quality }: { quality: QualitySettings }) {
  const setDpr = useThree((s) => s.setDpr);
  const tuning = useRef({ slowSince: 0, fastSince: 0, changedAt: 0 });

  useFrame(({ gl, viewport }) => {
    perfMonitor.end(gl);
    if (hasPendingCapture()) fulfilCaptures(gl.domElement);

    // Dynamic resolution: drop pixels when frames run long, restore them once there is headroom.
    const frameMs = perfMonitor.recentFrameMs();
    if (frameMs === 0) return;
    const now = performance.now();
    const t = tuning.current;
    const [min, max] = quality.dpr;
    const ceiling = Math.min(max, window.devicePixelRatio || 1);
    const current = viewport.dpr;
    if (now - t.changedAt < 1200) return;

    if (frameMs > 21.5 && current > min + 1e-3) {
      t.fastSince = 0;
      if (t.slowSince === 0) t.slowSince = now;
      else if (now - t.slowSince > 450) {
        setDpr(Math.max(min, current - STEP));
        t.changedAt = now;
        t.slowSince = 0;
        perfMonitor.reset();
      }
    } else if (frameMs < 13 && current < ceiling - 1e-3) {
      t.slowSince = 0;
      if (t.fastSince === 0) t.fastSince = now;
      else if (now - t.fastSince > 2500) {
        setDpr(Math.min(ceiling, current + STEP));
        t.changedAt = now;
        t.fastSince = 0;
        perfMonitor.reset();
      }
    } else {
      t.slowSince = 0;
      t.fastSince = 0;
    }
  }, 1000);
  return null;
}
