/**
 * Opt-in render-mode instrumentation for whatever mounts `<LabWorld>`: frame pacing, CPU/GPU time
 * and renderer workload (draw calls, triangles, memory), reusing `render/perf.ts`'s `PerfMonitor`
 * (generic WebGL introspection, not molecular-editor-specific) rather than re-measuring the same
 * things a second way. `PerfBegin`/`PerfEnd` bracket a frame at the priorities that run first/last
 * regardless of what else is in the scene; `DirectRender` is only needed when no post-processing
 * composer is already rendering the frame (see `SceneQuality.postprocessing`).
 */
import { useFrame } from '@react-three/fiber';
import { PerfMonitor } from '../../render/perf';
import type { PerfSnapshot } from '../../render/perf';

export { PerfMonitor };
export type { PerfSnapshot };

export function PerfBegin({ monitor }: { monitor: PerfMonitor }) {
  useFrame(({ gl }) => {
    // Without this, three.js resets its draw-call/triangle counters on every internal render()
    // call (the post-processing composer makes several per frame), so only the last one would
    // survive to be read in `PerfEnd`.
    gl.info.autoReset = false;
    monitor.begin(gl);
  }, -1000);
  return null;
}

export function PerfEnd({ monitor }: { monitor: PerfMonitor }) {
  useFrame(({ gl }) => monitor.end(gl), 1000);
  return null;
}

/** Draws the scene directly to the screen; use when `SceneQuality.postprocessing` is off for the active preset. */
export function DirectRender() {
  useFrame(({ gl, scene, camera }) => gl.render(scene, camera), 1);
  return null;
}
