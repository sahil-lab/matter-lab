import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Group, Mesh } from 'three';
import type { MeshPhysicalMaterial } from 'three';
import type {
  ApparatusDefinition, ApparatusInstance, ContainerContents, ObservationRecord,
} from '@matterlab/contracts';
import { LiquidAppearanceTransition } from './appearance';
import { checkVesselCalibration, evaluateVesselFill } from './calibration';
import type { CalibratedFill } from './calibration';
import { boundedSurfaceMotion, createLiquidGeometry } from './liquidGeometry';
import type { LiquidGeometryResource } from './liquidGeometry';
import { CLEAR_LIQUID_APPEARANCE, createLiquidMaterial, setLiquidAppearance } from './materials';
import { selectIndicatorAppearance } from './observations';
import type { FluidScope, FluidVisualSettings, StirringState } from './types';
import { useFluidSettings } from './useFluidSettings';

export interface VesselLiquidProps {
  readonly definition: ApparatusDefinition;
  readonly instance: ApparatusInstance;
  readonly contents?: ContainerContents;
  readonly scope: FluidScope;
  readonly observations: readonly ObservationRecord[];
  readonly stirring?: StirringState;
  readonly indicatorId?: string;
  readonly settings?: FluidVisualSettings;
  readonly onStatus?: (fill: CalibratedFill) => void;
}

interface Model {
  readonly mesh: Mesh;
  readonly geometry: LiquidGeometryResource;
  readonly material: MeshPhysicalMaterial;
}

/** Local vessel coordinates. The apparatus renderer owns the instance transform and glass shell. */
export function VesselLiquid({
  definition, instance, contents, scope, observations, stirring, indicatorId, settings, onStatus,
}: VesselLiquidProps) {
  const quality = useFluidSettings(settings);
  const root = useRef<Group>(null);
  const model = useRef<Model | null>(null);
  const transition = useRef(new LiquidAppearanceTransition());
  const receivedAtS = useRef(0);
  const lastMotionAtS = useRef(0);
  const invalidate = useThree((state) => state.invalidate);
  const calibration = definition.vesselCalibration;
  const check = useMemo(() => calibration ? checkVesselCalibration(calibration) : undefined, [calibration]);
  const fill = useMemo(() => {
    const value = evaluateVesselFill(definition, contents?.volumeL ?? 0, instance.transform.quaternion, check);
    if (instance.definitionId !== definition.id || instance.stationId !== scope.stationId) {
      return { ...value, status: 'UNSUPPORTED' as const, reason: 'Instance, definition and station must describe the same vessel.' };
    }
    return value;
  }, [definition, contents?.volumeL, instance.definitionId, instance.stationId, instance.transform.quaternion, scope.stationId, check]);
  const appearance = useMemo(() => contents && contents.volumeL > 0
    ? selectIndicatorAppearance({ observations, scope, apparatusId: instance.id, indicatorId }).appearance
    : CLEAR_LIQUID_APPEARANCE, [contents, observations, scope, instance.id, indicatorId]);

  useLayoutEffect(() => {
    if (!calibration || !check?.supported) return;
    const parent = root.current!;
    const geometry = createLiquidGeometry(calibration, quality);
    const material = createLiquidMaterial(quality);
    const mesh = new Mesh(geometry.geometry, material);
    mesh.name = `liquid:${instance.id}`;
    mesh.renderOrder = 10;
    mesh.visible = false;
    mesh.raycast = () => {};
    mesh.userData = { instanceId: instance.id, stationId: instance.stationId, units: 'm', evidence: 'ILLUSTRATIVE' };
    parent.add(mesh);
    model.current = { mesh, geometry, material };
    return () => {
      parent.remove(mesh);
      model.current = null;
      geometry.dispose();
      material.dispose();
      transition.current.clear();
    };
  }, [calibration, check, quality, instance.id, instance.stationId]);

  useLayoutEffect(() => {
    const nowS = performance.now() / 1000;
    receivedAtS.current = nowS;
    lastMotionAtS.current = nowS;
    transition.current.set(scope, appearance, nowS, quality.reducedMotion || quality.lowPower);
    const current = model.current;
    if (current) {
      current.mesh.visible = quality.enabled && fill.status === 'READY';
      if (fill.status !== 'UNSUPPORTED') current.geometry.update(fill);
      setLiquidAppearance(current.material, transition.current.sample(nowS));
    }
    invalidate();
  }, [fill, appearance, scope, quality, instance.id, stirring?.enabled, stirring?.frequencyHz, invalidate]);

  useEffect(() => { onStatus?.(fill); }, [fill, onStatus]);

  useFrame(() => {
    const current = model.current;
    if (!current?.mesh.visible || !calibration) return;
    const nowS = performance.now() / 1000;
    const elapsedS = Math.max(0, nowS - receivedAtS.current);
    const visualTimeS = scope.simulationTimeS + (scope.status === 'RUNNING' ? Math.min(0.1, elapsedS) : 0);
    const motion = boundedSurfaceMotion(fill, calibration.maxFillHeightM, scope, stirring, quality, visualTimeS);
    if (motion.amplitudeM > 0 && nowS - lastMotionAtS.current >= 1 / quality.motionUpdatesPerS) {
      current.geometry.update(fill, motion);
      lastMotionAtS.current = nowS;
    }
    if (transition.current.isAnimating(nowS)) setLiquidAppearance(current.material, transition.current.sample(nowS));
    else setLiquidAppearance(current.material, appearance);
    if ((motion.amplitudeM > 0 && elapsedS < 0.1) || transition.current.isAnimating(nowS)) invalidate();
  });

  return (
    <group ref={root} name={`vessel-liquid:${instance.id}`} dispose={null}
      userData={{ units: 'm', evidence: 'ILLUSTRATIVE', fluidStatus: fill.status, fluidReason: fill.reason }}>
    </group>
  );
}
