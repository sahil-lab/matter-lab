import { createContext, lazy, Suspense, useContext, useEffect, useMemo } from 'react';
import type { ReactNode } from 'react';
import { useThree } from '@react-three/fiber';
import { Color, Fog } from 'three';
import { useOptionalLabCamera } from './CameraModes';
import { boundsCenter, createFloorSurface } from './coordinates';
import { EnvironmentLighting } from './EnvironmentLighting';
import { PlacementSurfaceProvider } from './placement';
import { ROOM_PRESETS, STUDIO_NAVIGATION_BOUNDS } from './RoomConfig';
import type { RoomConfiguration } from './RoomConfig';
import { useSceneQuality } from './SceneQuality';
import { ViewportGrid } from './ViewportGrid';
import type { LabStation, LabWorldProps, PlacementSurface } from './types';

const RoomFurnishings = lazy(() => import('./RoomFurnishings'));
const EMPTY_STATIONS: readonly LabStation[] = [];
const EMPTY_SURFACES: readonly PlacementSurface[] = [];
const StationVisibilityContext = createContext<{ activeStationId?: string; isolated: boolean }>({ isolated: false });
const noRaycast = () => undefined;

function RoomArchitecture({ room }: { room: RoomConfiguration }) {
  return (
    <group name="room-architecture">
      <mesh position={[0, room.heightM / 2, -room.depthM / 2]} receiveShadow>
        <boxGeometry args={[room.widthM, room.heightM, 0.12]} />
        <meshStandardMaterial color="#1a3031" roughness={0.82} />
      </mesh>
      <mesh position={[-room.widthM / 2, room.heightM / 2, 0]} receiveShadow>
        <boxGeometry args={[0.12, room.heightM, room.depthM]} />
        <meshStandardMaterial color="#203736" roughness={0.85} />
      </mesh>
      <mesh position={[0, 0.075, -room.depthM / 2 + 0.08]}>
        <boxGeometry args={[room.widthM, 0.15, 0.04]} />
        <meshStandardMaterial color="#556963" roughness={0.5} metalness={0.4} />
      </mesh>
      <mesh position={[-room.widthM / 2 + 0.08, 0.075, 0]}>
        <boxGeometry args={[0.04, 0.15, room.depthM]} />
        <meshStandardMaterial color="#556963" roughness={0.5} metalness={0.4} />
      </mesh>
      <mesh position={[-room.widthM / 2 + 0.075, room.heightM * 0.57, 0]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[room.depthM * 0.62, room.heightM * 0.42]} />
        <meshBasicMaterial color="#849c94" toneMapped />
      </mesh>
      {Array.from({ length: Math.floor(room.widthM) + 1 }, (_, index) => (
        <mesh key={index} position={[-room.widthM / 2 + index, room.heightM / 2, -room.depthM / 2 + 0.07]}>
          <boxGeometry args={[0.012, room.heightM, 0.018]} />
          <meshStandardMaterial color="#34504b" roughness={0.7} />
        </mesh>
      ))}
    </group>
  );
}

function StationMarker({ station, index, active }: { station: LabStation; index: number; active: boolean }) {
  const center = boundsCenter(station.boundsM);
  const width = Math.max(0.3, station.boundsM.maxM[0] - station.boundsM.minM[0]) + 0.18;
  const depth = Math.max(0.3, station.boundsM.maxM[2] - station.boundsM.minM[2]) + 0.18;
  const color = station.accent ?? ['#a5c9aa', '#95bfcf', '#ccb89a', '#c0a8c9'][index % 4];
  return (
    <group name={`station-marker:${station.id}`} position={[center[0], 0.006, center[2]]} userData={{ stationId: station.id, label: station.label }}>
      {[-1, 1].map((side) => (
        <group key={side}>
          <mesh position={[0, 0, side * depth / 2]} rotation={[-Math.PI / 2, 0, 0]} raycast={noRaycast}>
            <planeGeometry args={[width, 0.015]} />
            <meshBasicMaterial color={color} transparent opacity={active ? 0.62 : 0.24} depthWrite={false} />
          </mesh>
          <mesh position={[side * width / 2, 0, 0]} rotation={[-Math.PI / 2, 0, 0]} raycast={noRaycast}>
            <planeGeometry args={[0.015, depth]} />
            <meshBasicMaterial color={color} transparent opacity={active ? 0.62 : 0.24} depthWrite={false} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/** Hide render children only. Authoritative apparatus and station state remain outside this component. */
export function LabStationGroup({ stationId, children }: { stationId: string; children?: ReactNode }) {
  const visibility = useContext(StationVisibilityContext);
  if (visibility.isolated && visibility.activeStationId && stationId !== visibility.activeStationId) return null;
  return <group name={`station:${stationId}`} userData={{ stationId }}>{children}</group>;
}

/** Architecture around caller-owned scene children. Intentionally never instantiates a Workbench. */
export function LabWorld({
  mode = 'room', roomPreset = 'teaching', lightingPreset = 'daylight',
  stations = EMPTY_STATIONS, activeStationId, isolateStation = false,
  showGrid = false, showStationMarkers = true, placementSurfaces = EMPTY_SURFACES, children,
}: LabWorldProps) {
  const get = useThree((state) => state.get);
  const controller = useOptionalLabCamera();
  const quality = useSceneQuality();
  const room = ROOM_PRESETS[roomPreset];
  const floor = useMemo(() => createFloorSurface(
    mode === 'room' ? room.widthM : 40, mode === 'room' ? room.depthM : 40,
  ), [mode, room]);
  const surfaces = useMemo(() => [floor, ...placementSurfaces], [floor, placementSurfaces]);
  const visibility = useMemo(() => ({ activeStationId, isolated: isolateStation }), [activeStationId, isolateStation]);

  useEffect(() => { controller?.setStations(stations); }, [controller, stations]);
  useEffect(() => { controller?.setNavigationBounds(mode === 'room' ? room.navigationBoundsM : STUDIO_NAVIGATION_BOUNDS); }, [controller, mode, room]);
  useEffect(() => {
    const { scene, invalidate } = get();
    const old = { background: scene.background, fog: scene.fog };
    const background = new Color(mode === 'room' ? '#0b1b1d' : '#091619');
    const fog = new Fog(background, mode === 'room' ? 12 : 9, mode === 'room' ? 38 : 32);
    scene.background = background;
    scene.fog = fog;
    invalidate();
    return () => {
      if (scene.background === background) scene.background = old.background;
      if (scene.fog === fog) scene.fog = old.fog;
    };
  }, [get, mode]);

  return (
    <StationVisibilityContext.Provider value={visibility}>
      <PlacementSurfaceProvider surfaces={surfaces}>
        <group name={`lab-world:${mode}`} userData={{ units: 'm', roomPreset }}>
          <EnvironmentLighting preset={lightingPreset} />
          <mesh name="lab-floor" rotation={[-Math.PI / 2, 0, 0]} receiveShadow userData={{ placementSurfaceId: floor.id }}>
            <planeGeometry args={mode === 'room' ? [room.widthM, room.depthM] : [200, 200]} />
            <meshStandardMaterial color={mode === 'room' ? '#344441' : '#263638'} roughness={0.64} metalness={0.08} />
          </mesh>
          {mode === 'room' && <RoomArchitecture room={room} />}
          {mode === 'room' && quality.preset !== 'low' && <Suspense fallback={null}><RoomFurnishings room={room} /></Suspense>}
          {showGrid && <ViewportGrid widthM={mode === 'room' ? room.widthM : 16} depthM={mode === 'room' ? room.depthM : 14} />}
          {showStationMarkers && stations.map((station, index) => (
            <LabStationGroup key={station.id} stationId={station.id}>
              <StationMarker station={station} index={index} active={station.id === activeStationId} />
            </LabStationGroup>
          ))}
          {children}
        </group>
      </PlacementSurfaceProvider>
    </StationVisibilityContext.Provider>
  );
}
