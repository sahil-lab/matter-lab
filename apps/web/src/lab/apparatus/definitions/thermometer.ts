/**
 * Analog glass thermometer (THERMOMETER): a passive, visually-read instrument — `MEASUREMENT`
 * capability (not the more specific `TEMPERATURE_SENSOR`, which the digital temperature sensor
 * declares instead; see that definition's doc comment for the distinction this module draws).
 * Reuses the pH probe's shaft+bulb+head geometry builder with thermometer-sized proportions.
 */
import { buildPhProbeGeometry, DEFAULT_PH_PROBE_CONFIG } from '../geometry';
import type { PhProbeGeometryConfig } from '../geometry';
import { dimensionSource } from '../sources';
import { uprightSocketTransform } from '../transforms';
import type { ApparatusDefinition } from '../types';

const config: PhProbeGeometryConfig = { ...DEFAULT_PH_PROBE_CONFIG, shaftRadiusM: 0.0035, shaftHeightM: 0.28, bulbRadiusM: 0.004, headSizeM: 0.018 };
/** Exported so the geometry builder registry can build from the exact same config as this
 * definition, rather than risking a second, possibly-drifted copy of these numbers. */
export const THERMOMETER_GEOMETRY_CONFIG = config;
const build = buildPhProbeGeometry(config);
const totalHeightM = config.shaftHeightM + config.headSizeM * 0.7;

export const THERMOMETER_STANDARD: ApparatusDefinition = {
  id: 'thermometer-standard',
  kind: 'THERMOMETER',
  category: 'instrument',
  label: 'Laboratory Thermometer',
  shortLabel: 'Thermometer',
  description: 'An analog glass thermometer. Read visually; reports a temperature wherever it is dipped.',
  version: 1,
  dimensionsM: { width: config.headSizeM, depth: config.headSizeM, height: totalHeightM },
  massKg: 0.03,
  collision: { kind: 'cylinder', radiusM: config.shaftRadiusM * 1.4, heightM: totalHeightM, centerM: [0, totalHeightM / 2 - config.shaftHeightM * 0.02, 0] },
  capabilities: ['MEASUREMENT', 'MOUNTABLE'],
  sockets: [
    {
      id: 'sensor-tip',
      label: 'Sensing bulb',
      kind: 'SENSOR',
      role: 'sensor-probe',
      accepts: ['sensor-access'],
      gender: 'MALE',
      mate: 'proximity',
      transform: { positionM: [0, -config.bulbRadiusM * 0.3, 0], quaternion: [0, 0, 0, 1] },
      geometryCheck: { kind: 'none' },
      maxConnections: 1,
      highlightRadiusM: 0.012,
    },
    {
      id: 'shaft-mount',
      label: 'Shaft (can be held by a second clamp)',
      kind: 'MECHANICAL',
      role: 'probe-shaft',
      accepts: ['clamp-jaw'],
      gender: 'MALE',
      mate: 'coincident',
      transform: uprightSocketTransform([0, config.shaftHeightM * 0.5, 0]),
      geometryCheck: { kind: 'none' },
      nominalDiameterM: config.shaftRadiusM * 2,
      maxConnections: 1,
      highlightRadiusM: 0.015,
    },
  ],
  controls: [
    {
      id: 'immersion',
      label: 'Immersion',
      kind: 'PROBE_POSITION',
      actionType: 'SET_PROBE',
      description: 'How far the bulb is lowered into a vessel, from fully raised (0) to fully immersed (1).',
      valueType: 'number',
      range: { min: 0, max: 1, step: 0.01, unit: 'immersion fraction', default: 0 },
      requiresCapability: 'MEASUREMENT',
    },
  ],
  defaultConfig: {},
  configSchema: [],
  placement: { allowedSurfaceRoles: ['sensor-access', 'clamp-jaw'], allowRotationAboutUpAxis: false },
  asset: {
    source: 'procedural',
    proceduralBuilderId: 'thermometer-standard',
    polyCount: build.polyCount,
    materialSlots: ['probe-bulb', 'probe-shaft', 'probe-head'],
    textureMemoryKB: 96,
    license: 'Procedural geometry authored for MATTER LAB; no external assets or textures used.',
    isPlaceholder: true,
    notes: 'Reuses the pH probe\u2019s shaft/bulb/head geometry at thermometer proportions; no printed scale or colored fill line is modeled.',
  },
  thumbnail: { icon: 'Thermometer', previewColor: '#cdeaf0' },
  focusPointM: [0, config.shaftHeightM * 0.1, 0],
  tags: ['thermometer', 'instrument', 'temperature'],
  provenance: {
    dimensions: 'REFERENCE_MEASURED',
    notes: dimensionSource('lab-thermometer-catalog').detail,
    sourceIds: [dimensionSource('lab-thermometer-catalog').id],
  },
};
