import { useImperativeHandle, useLayoutEffect, useRef } from 'react';
import type { ReactNode, Ref } from 'react';
import { useThree } from '@react-three/fiber';
import type { ThreeEvent } from '@react-three/fiber';
import type { Group } from 'three';
import { useSceneQuality } from './SceneQuality';
import { createWorkbenchModel } from './workbenchGeometry';
import type { SceneQualityPreset } from './types';

export interface WorkbenchProps {
  readonly instanceId?: string;
  readonly stationId?: string;
  readonly quality?: SceneQualityPreset;
  readonly accent?: string;
  readonly children?: ReactNode;
  readonly ref?: Ref<Group>;
  readonly onSurfacePointerDown?: (event: ThreeEvent<PointerEvent>) => void;
}

/** Local floor pivot [0,0,0]. Place this ONLY inside an authoritative BENCH instance. */
export function Workbench({ instanceId, stationId, quality, accent, children, ref, onSurfacePointerDown }: WorkbenchProps) {
  const sceneQuality = useSceneQuality();
  const root = useRef<Group>(null);
  const invalidate = useThree((state) => state.invalidate);
  useImperativeHandle(ref, () => root.current!, []);
  useLayoutEffect(() => {
    const parent = root.current!;
    const model = createWorkbenchModel(quality ?? sceneQuality.preset, accent);
    parent.add(model.group);
    invalidate();
    return () => { parent.remove(model.group); model.dispose(); };
  }, [quality, sceneQuality.preset, accent, invalidate]);
  return (
    <group
      ref={root}
      name={instanceId ? `bench:${instanceId}` : 'workbench-fixture'}
      userData={{ instanceId, stationId, units: 'm' }}
      onPointerDown={onSurfacePointerDown ? (event) => {
        if (event.object.name === 'work-surface') onSurfacePointerDown(event);
      } : undefined}
    >
      {children}
    </group>
  );
}
