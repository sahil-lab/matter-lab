/**
 * A single station's work surface: a flat, collidable/selectable tabletop at a stable height
 * (`REFERENCE_HEIGHTS_M.benchTop`), in either the furnished-room look (four legs) or the studio
 * look (a solid plinth). Agent 03/04 place apparatus on top of this using the station's world
 * transform from `stations.ts`; this component carries no apparatus or simulation state.
 */
import { useMemo } from 'react';
import { DoubleSide } from 'three';
import { REFERENCE_HEIGHTS_M } from './coordinates';
import type { StationFootprint } from './stations';
import type { LightingPreset } from './RoomConfig';
import type { EnvironmentMode } from './types';

/** Set on the tabletop mesh's `userData` so Agent 04's raycaster can recognise a placement surface. */
export const WORKBENCH_SURFACE_TAG = 'lab-workbench-top';

export interface WorkbenchProps {
  readonly mode: EnvironmentMode;
  readonly footprintM: StationFootprint;
  readonly lighting: LightingPreset;
  /** A soft highlight for the active station, distinguishing it in a multi-station layout. */
  readonly active?: boolean;
}

function Legs({ widthM, depthM, topY }: { widthM: number; depthM: number; topY: number }) {
  const inset = 0.08;
  const legSize = 0.06;
  const positions = useMemo<Array<[number, number]>>(
    () => [
      [widthM / 2 - inset, depthM / 2 - inset],
      [-(widthM / 2 - inset), depthM / 2 - inset],
      [widthM / 2 - inset, -(depthM / 2 - inset)],
      [-(widthM / 2 - inset), -(depthM / 2 - inset)],
    ],
    [widthM, depthM],
  );
  return (
    <>
      {positions.map(([x, z], i) => (
        <mesh key={i} position={[x, topY / 2, z]} castShadow receiveShadow>
          <boxGeometry args={[legSize, topY, legSize]} />
          <meshStandardMaterial color="#8b9097" roughness={0.4} metalness={0.5} />
        </mesh>
      ))}
    </>
  );
}

export function Workbench({ mode, footprintM, lighting, active = false }: WorkbenchProps) {
  const topY = REFERENCE_HEIGHTS_M.benchTop;
  const thickness = REFERENCE_HEIGHTS_M.benchTopThickness;
  const legHeight = topY - thickness;

  return (
    <group>
      <mesh position={[0, topY - thickness / 2, 0]} userData={{ tag: WORKBENCH_SURFACE_TAG }} name={WORKBENCH_SURFACE_TAG} receiveShadow castShadow>
        <boxGeometry args={[footprintM.widthM, thickness, footprintM.depthM]} />
        <meshStandardMaterial color={mode === 'room' ? '#d7dadf' : lighting.floorColor} roughness={0.5} metalness={0.08} />
      </mesh>

      {mode === 'room' ? (
        <Legs widthM={footprintM.widthM} depthM={footprintM.depthM} topY={legHeight} />
      ) : (
        <mesh position={[0, legHeight / 2, 0]} castShadow receiveShadow>
          <boxGeometry args={[footprintM.widthM * 0.88, legHeight, footprintM.depthM * 0.88]} />
          <meshStandardMaterial color="#e9ebee" roughness={0.42} />
        </mesh>
      )}

      {active && (
        <mesh position={[0, topY + 0.001, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[Math.max(footprintM.widthM, footprintM.depthM) * 0.62, Math.max(footprintM.widthM, footprintM.depthM) * 0.66, 48]} />
          <meshBasicMaterial color={lighting.rimColor} transparent opacity={0.6} side={DoubleSide} toneMapped={false} />
        </mesh>
      )}
    </group>
  );
}
