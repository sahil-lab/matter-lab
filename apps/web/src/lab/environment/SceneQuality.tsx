import { createContext, useContext, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import type { Frameloop } from '@react-three/fiber';
import { Group, Vector3 } from 'three';
import { adaptDpr, FrameMetricsWindow, readRendererCounters, SCENE_QUALITY } from './qualityMath';
import type { AdaptiveDprState, SceneQualitySettings } from './qualityMath';
import type { LabFrameMetrics, LabRendererBackend, SceneQualityPreset } from './types';

const QualityContext = createContext<SceneQualitySettings>(SCENE_QUALITY.balanced);
export function useSceneQuality(): SceneQualitySettings { return useContext(QualityContext); }
export function SceneQualityProvider({ preset = 'balanced', children }: { preset?: SceneQualityPreset; children?: ReactNode }) {
  return <QualityContext.Provider value={SCENE_QUALITY[preset]}>{children}</QualityContext.Provider>;
}

export function SceneMetrics({
  backend, adaptive = true, frameloop = 'always', onMetrics,
}: {
  backend: LabRendererBackend;
  adaptive?: boolean;
  frameloop?: Exclude<Frameloop, 'never'>;
  onMetrics?: (metrics: LabFrameMetrics) => void;
}) {
  const quality = useSceneQuality();
  const get = useThree((state) => state.get);
  const window = useRef(new FrameMetricsWindow());
  const callback = useRef(onMetrics);
  callback.current = onMetrics;
  const dprState = useRef<AdaptiveDprState>({ dpr: quality.dpr[1], slowWindows: 0, fastWindows: 0 });
  const skipNext = useRef(true);

  useEffect(() => {
    const state = get();
    const desired = Math.min(globalThis.devicePixelRatio || 1, quality.dpr[1]);
    dprState.current = { dpr: Math.max(quality.dpr[0], desired), slowWindows: 0, fastWindows: 0 };
    state.setDpr(dprState.current.dpr);
    window.current.reset();
  }, [get, quality]);

  useEffect(() => {
    const onVisibility = () => {
      window.current.reset();
      skipNext.current = true;
      get().setFrameloop(document.hidden ? 'never' : frameloop);
      if (!document.hidden) get().invalidate();
    };
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [get, frameloop]);

  useFrame((state, deltaS) => {
    if (document.hidden) return;
    if (skipNext.current) { skipNext.current = false; return; }
    const sample = window.current.addFrame(deltaS);
    if (!sample) return;
    if (adaptive && frameloop === 'always') {
      const maximum = Math.min(globalThis.devicePixelRatio || 1, quality.dpr[1]);
      const next = adaptDpr(dprState.current, sample.meanFrameMs, [Math.min(quality.dpr[0], maximum), maximum]);
      if (next.dpr !== dprState.current.dpr) state.setDpr(next.dpr);
      dprState.current = next;
    }
    callback.current?.({
      ...sample, ...readRendererCounters(state.gl.info), backend, quality: quality.preset,
      measurement: 'render-cadence', frameloop,
      dpr: state.viewport.dpr, viewportPx: [state.size.width, state.size.height], visibility: 'visible',
    });
  });
  return null;
}

/** Decorative LOD only. It never changes apparatus state or remounts a station. */
export function LabDistanceLOD({ near, far, distanceM }: { near: ReactNode; far?: ReactNode; distanceM?: number }) {
  const quality = useSceneQuality();
  const root = useRef<Group>(null);
  const nearGroup = useRef<Group>(null);
  const farGroup = useRef<Group>(null);
  const position = useRef(new Vector3());
  const showingNear = useRef(true);
  useFrame(({ camera }) => {
    if (!root.current || !nearGroup.current || !farGroup.current) return;
    root.current.getWorldPosition(position.current);
    const threshold = (distanceM ?? quality.lodDistanceM) * (showingNear.current ? 1.1 : 0.9);
    showingNear.current = position.current.distanceToSquared(camera.position) < threshold * threshold;
    nearGroup.current.visible = showingNear.current;
    farGroup.current.visible = !showingNear.current;
  });
  return (
    <group ref={root}>
      <group ref={nearGroup}>{near}</group>
      <group ref={farGroup} visible={false}>{far}</group>
    </group>
  );
}
