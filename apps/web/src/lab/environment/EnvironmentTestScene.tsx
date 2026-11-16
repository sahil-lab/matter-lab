import { useState } from 'react';
import type { ReactNode } from 'react';
import { createLabCameraController } from './CameraController';
import { cameraViewForMode, DEFAULT_CAMERA_VIEW } from './cameraMath';
import { LabCanvas } from './LabCanvas';
import type { LabCanvasProps } from './LabCanvas';
import { LabWorld } from './LabWorld';
import { Workbench } from './Workbench';
import type { LabStation, LabWorldMode, SceneQualityPreset } from './types';

export const ENVIRONMENT_VISUAL_CASES = [
  'empty-room', 'assembled-station', 'top-down', 'glass-close-up', 'quality-low', 'quality-high',
] as const;
export type EnvironmentVisualCase = typeof ENVIRONMENT_VISUAL_CASES[number];
const FIXTURE_STATIONS: readonly LabStation[] = [
  { id: '00000000-0000-4000-8000-000000000002', label: 'Environment fixture', boundsM: { minM: [-1.2, 0, -0.525], maxM: [1.2, 1.8, 0.525] } },
];

/** Neutral opaque references; Agent05 supplies the glass specimens through children. */
export function LightingReferenceRig({ children }: { children?: ReactNode }) {
  return (
    <group name="lighting-reference-rig">
      <mesh position={[-0.18, 0.975, 0]} castShadow>
        <sphereGeometry args={[0.075, 24, 16]} />
        <meshStandardMaterial color="#a0a0a0" roughness={1} metalness={0} />
      </mesh>
      <mesh position={[0.18, 0.975, 0]} castShadow>
        <sphereGeometry args={[0.075, 24, 16]} />
        <meshStandardMaterial color="#b8c0bd" roughness={0.12} metalness={1} />
      </mesh>
      <mesh position={[-0.25, 1.05, -0.18]}>
        <boxGeometry args={[0.48, 0.3, 0.006]} />
        <meshStandardMaterial color="#101d1e" roughness={1} />
      </mesh>
      <mesh position={[0.25, 1.05, -0.18]}>
        <boxGeometry args={[0.48, 0.3, 0.006]} />
        <meshStandardMaterial color="#d4d8cf" roughness={1} />
      </mesh>
      {children}
    </group>
  );
}

/**
 * Standalone verification fixture ONLY: creates one explicit bench. `apparatusChildren` must not
 * include a BENCH instance. The production LabWorld never creates this bench or fake apparatus.
 */
export function EnvironmentTestScene({
  scenario = 'empty-room', apparatusChildren, mode = 'room', quality,
  ...canvasProps
}: Omit<LabCanvasProps, 'children' | 'cameraController' | 'quality'> & {
  scenario?: EnvironmentVisualCase;
  apparatusChildren?: ReactNode;
  mode?: LabWorldMode;
  quality?: SceneQualityPreset;
}) {
  const [controller] = useState(() => createLabCameraController({
    initialView: scenario === 'top-down'
      ? cameraViewForMode(DEFAULT_CAMERA_VIEW, 'top-down')
      : scenario === 'glass-close-up'
        ? { ...DEFAULT_CAMERA_VIEW, mode: 'inspection', positionM: [0.5, 1.23, 0.68], targetM: [0, 1.04, 0] }
        : DEFAULT_CAMERA_VIEW,
  }));
  const selectedQuality = quality ?? (scenario === 'quality-low' ? 'low' : scenario === 'quality-high' ? 'high' : 'balanced');
  return (
    <LabCanvas {...canvasProps} cameraController={controller} quality={selectedQuality} showControls>
      <LabWorld mode={mode} stations={FIXTURE_STATIONS} showGrid={scenario === 'top-down'}>
        {scenario !== 'empty-room' && <Workbench quality={selectedQuality} />}
        {scenario === 'glass-close-up' ? <LightingReferenceRig>{apparatusChildren}</LightingReferenceRig> : apparatusChildren}
      </LabWorld>
    </LabCanvas>
  );
}
