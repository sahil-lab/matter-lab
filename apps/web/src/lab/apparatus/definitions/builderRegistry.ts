/**
 * Maps each definition's `asset.proceduralBuilderId` to the function that actually builds its
 * mesh. `components/ApparatusMesh.tsx` is the one place that needs this map — definitions and
 * individual geometry builders never need to know the string keys exist.
 *
 * This lives in `definitions/`, not `geometry/`: three probe definitions (thermometer,
 * conductivity meter, temperature sensor) reuse the pH probe's geometry *builder* with their own,
 * definition-specific config, so the single source of truth for "which exact config does this
 * definition use" is the definition module itself, not a second copy here.
 */
import {
  buildBalanceGeometry,
  buildBeakerGeometry,
  buildBuretteClampGeometry,
  buildBuretteGeometry,
  buildConicalFlaskGeometry,
  buildDropperGeometry,
  buildFunnelGeometry,
  buildGraduatedCylinderGeometry,
  buildLabJackGeometry,
  buildMagneticStirrerGeometry,
  buildPhProbeGeometry,
  buildPipetteGeometry,
  buildReagentBottleGeometry,
  buildRetortStandGeometry,
  buildSupportRingGeometry,
  buildTestTubeGeometry,
  buildVolumetricFlaskGeometry,
  buildWorkbenchGeometry,
  type GeometryBuildResult,
} from '../geometry';
import { CONDUCTIVITY_METER_GEOMETRY_CONFIG } from './conductivityMeter';
import { TEMPERATURE_SENSOR_GEOMETRY_CONFIG } from './temperatureSensor';
import { THERMOMETER_GEOMETRY_CONFIG } from './thermometer';

export type ProceduralGeometryBuilder = () => GeometryBuildResult;

/** Keyed by `ApparatusDefinition.id` (every current definition uses its own id as its
 * `proceduralBuilderId`, so there is exactly one obvious builder per registered definition). */
export const PROCEDURAL_GEOMETRY_BUILDERS: Readonly<Record<string, ProceduralGeometryBuilder>> = {
  'workbench-standard': () => buildWorkbenchGeometry(),
  'retort-stand-600mm': () => buildRetortStandGeometry(),
  'burette-clamp-boss-head': () => buildBuretteClampGeometry(),
  'burette-50ml-class-a': () => buildBuretteGeometry(),
  'conical-flask-250ml': () => buildConicalFlaskGeometry(),
  'reagent-bottle-250ml': () => buildReagentBottleGeometry(),
  'magnetic-stirrer-compact': () => buildMagneticStirrerGeometry(),
  'ph-probe-combination': () => buildPhProbeGeometry(),
  'beaker-250ml-low-form': () => buildBeakerGeometry(),
  'test-tube-16x100mm': () => buildTestTubeGeometry(),
  'volumetric-flask-250ml': () => buildVolumetricFlaskGeometry(),
  'pipette-25ml-volumetric': () => buildPipetteGeometry(),
  'dropper-standard': () => buildDropperGeometry(),
  'graduated-cylinder-100ml': () => buildGraduatedCylinderGeometry(),
  'funnel-standard': () => buildFunnelGeometry(),
  'support-ring-standard': () => buildSupportRingGeometry(),
  'lab-jack-standard': () => buildLabJackGeometry(),
  'thermometer-standard': () => buildPhProbeGeometry(THERMOMETER_GEOMETRY_CONFIG),
  'conductivity-meter-standard': () => buildPhProbeGeometry(CONDUCTIVITY_METER_GEOMETRY_CONFIG),
  'balance-standard': () => buildBalanceGeometry(),
  'temperature-sensor-standard': () => buildPhProbeGeometry(TEMPERATURE_SENSOR_GEOMETRY_CONFIG),
};

export function resolveProceduralBuilder(id: string): ProceduralGeometryBuilder | undefined {
  return PROCEDURAL_GEOMETRY_BUILDERS[id];
}
