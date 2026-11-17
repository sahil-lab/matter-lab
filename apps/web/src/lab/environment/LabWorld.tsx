/**
 * Top-level orchestration: lighting, camera, the placement grid and one workbench per station,
 * laid out by `stations.ts` and sized by `RoomConfig.roomDimensionsFor`. `LabWorld` places
 * apparatus nowhere itself — `renderStationContent` is how Agent 03/04/07 put real apparatus into
 * each station's slot, in that station's local coordinate frame (translate by `slot.origin`).
 */
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { CameraDirector } from './CameraDirector';
import { EnvironmentLighting } from './EnvironmentLighting';
import { LabEffects } from './LabEffects';
import { LightingTestRig } from './LightingTestRig';
import { DEFAULT_LIGHTING_PRESET, LIGHTING_PRESETS, roomDimensionsFor } from './RoomConfig';
import { SCENE_QUALITY, shouldLoadStation } from './SceneQuality';
import { SceneResourceContext, useSceneResourceManager } from './SceneResourceManager';
import { layoutBounds, layoutStations } from './stations';
import type { StationSlot } from './stations';
import { useEnvironment } from './environmentStore';
import { ViewportGrid } from './ViewportGrid';
import { Workbench } from './Workbench';
import type { StationRecord, UUID, WorldTransform } from './types';

export interface StationRenderProps {
  readonly station: StationRecord;
  readonly index: number;
  readonly origin: WorldTransform;
  readonly active: boolean;
}

export interface LabWorldProps {
  /** Renders one station's apparatus content, in that station's local frame (already translated/rotated by `origin`). */
  readonly renderStationContent?: (props: StationRenderProps) => ReactNode;
  /** Forces the lighting/reflection test rig on regardless of the environment store's own toggle (used by screenshots/QA). */
  readonly forceLightingTestRig?: boolean;
}

export function LabWorld({ renderStationContent, forceLightingTestRig }: LabWorldProps) {
  const mode = useEnvironment((s) => s.mode);
  const lightingPresetId = useEnvironment((s) => s.lightingPresetId);
  const qualityId = useEnvironment((s) => s.qualityId);
  const stations = useEnvironment((s) => s.stations);
  const activeStationId = useEnvironment((s) => s.activeStationId);
  const cameraMode = useEnvironment((s) => s.cameraMode);
  const gridVisible = useEnvironment((s) => s.gridVisible);
  const reducedMotion = useEnvironment((s) => s.reducedMotion);
  const rigVisible = useEnvironment((s) => s.lightingTestRigVisible) || !!forceLightingTestRig;

  const preset = LIGHTING_PRESETS[lightingPresetId ?? DEFAULT_LIGHTING_PRESET[mode]];
  const quality = SCENE_QUALITY[qualityId];

  const slots = useMemo<StationSlot[]>(() => layoutStations(stations, mode), [stations, mode]);
  const bounds = useMemo(() => layoutBounds(slots), [slots]);
  const roomDimensions = useMemo(() => roomDimensionsFor(bounds), [bounds]);
  const activeIndex = useMemo(() => slots.findIndex((slot) => slot.station.id === activeStationId), [slots, activeStationId]);

  const resourceManager = useSceneResourceManager();

  return (
    <SceneResourceContext.Provider value={resourceManager}>
      <CameraDirector mode={cameraMode} reducedMotion={reducedMotion} />
      <EnvironmentLighting mode={mode} preset={preset} quality={quality} roomDimensions={roomDimensions} />
      {quality.postprocessing && <LabEffects quality={quality} preset={preset} />}
      <ViewportGrid widthM={roomDimensions.widthM} depthM={roomDimensions.depthM} visible={gridVisible} color={preset.wallColor} />

      {slots.map((slot) => {
        const active = slot.station.id === activeStationId;
        const loaded = shouldLoadStation(slot.index, activeIndex >= 0 ? activeIndex : null, quality.maxLoadedStations);
        return (
          <StationGroup key={slot.station.id} slot={slot}>
            <Workbench mode={mode} footprintM={slot.footprintM} lighting={preset} active={active} />
            {loaded && renderStationContent?.({ station: slot.station, index: slot.index, origin: slot.origin, active })}
          </StationGroup>
        );
      })}

      <LightingTestRig visible={rigVisible} />
    </SceneResourceContext.Provider>
  );
}

/** Translates (and, if the layout ever rotates a station, rotates) its children into a station's world slot. */
function StationGroup({ slot, children }: { slot: StationSlot; children: ReactNode }) {
  const [x, y, z] = slot.origin.positionM;
  const [qx, qy, qz, qw] = slot.origin.quaternion;
  return (
    <group position={[x, y, z]} quaternion={[qx, qy, qz, qw]} name={`station-${slot.station.id}`}>
      {children}
    </group>
  );
}

/** Looks up a station's slot by id; useful for anything outside `LabWorld` that needs a station's world transform (e.g. Agent 04's drop targets). */
export function useStationSlot(stationId: UUID | null): StationSlot | undefined {
  const mode = useEnvironment((s) => s.mode);
  const stations = useEnvironment((s) => s.stations);
  const slots = useMemo(() => layoutStations(stations, mode), [stations, mode]);
  return stationId ? slots.find((slot) => slot.station.id === stationId) : undefined;
}
