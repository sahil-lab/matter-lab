import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import type { PlacementSurface } from './types';

const PlacementContext = createContext<readonly PlacementSurface[]>([]);

export function PlacementSurfaceProvider({ surfaces, children }: {
  readonly surfaces: readonly PlacementSurface[];
  readonly children?: ReactNode;
}) {
  return <PlacementContext.Provider value={surfaces}>{children}</PlacementContext.Provider>;
}
export function usePlacementSurfaces(): readonly PlacementSurface[] { return useContext(PlacementContext); }

export interface PlacementSurfaceMeshProps {
  readonly surface: PlacementSurface;
  readonly debug?: boolean;
  readonly onPointerDown?: (surface: PlacementSurface, event: ThreeEvent<PointerEvent>) => void;
  readonly onPointerMove?: (surface: PlacementSurface, event: ThreeEvent<PointerEvent>) => void;
  readonly onPointerUp?: (surface: PlacementSurface, event: ThreeEvent<PointerEvent>) => void;
}

/** Optional editor hit target. It contains no apparatus placement or simulation logic. */
export function PlacementSurfaceMesh({ surface, debug = false, onPointerDown, onPointerMove, onPointerUp }: PlacementSurfaceMeshProps) {
  return (
    <group position={[...surface.transform.positionM]} quaternion={[...surface.transform.quaternion]}>
      <mesh
        name={`surface:${surface.id}`} rotation={[-Math.PI / 2, 0, 0]}
        userData={{ placementSurfaceId: surface.id, units: 'm' }}
        onPointerDown={onPointerDown ? (event) => onPointerDown(surface, event) : undefined}
        onPointerMove={onPointerMove ? (event) => onPointerMove(surface, event) : undefined}
        onPointerUp={onPointerUp ? (event) => onPointerUp(surface, event) : undefined}
      >
        <planeGeometry args={[surface.sizeM[0], surface.sizeM[1]]} />
        <meshBasicMaterial color="#8cdebd" transparent opacity={debug ? 0.14 : 0} depthWrite={false} colorWrite={debug} polygonOffset polygonOffsetFactor={-2} />
      </mesh>
    </group>
  );
}
