/**
 * Conductivity meter probe (CONDUCTIVITY_METER): a combination-electrode-style dip sensor, the
 * same general form factor the pH probe uses (see `sources.ts`'s `ph-combination-electrode-catalog`
 * note that 12 mm is a generic combination-electrode shaft diameter, not pH-specific).
 */
import { buildPhProbeGeometry, DEFAULT_PH_PROBE_CONFIG } from '../geometry';
import type { PhProbeGeometryConfig } from '../geometry';
import { dimensionSource } from '../sources';
import { uprightSocketTransform } from '../transforms';
import type { ApparatusDefinition } from '../types';

const config: PhProbeGeometryConfig = { ...DEFAULT_PH_PROBE_CONFIG, shaftHeightM: 0.14 };
/** Exported so the geometry builder registry can build from the exact same config as this
 * definition, rather than risking a second, possibly-drifted copy of these numbers. */
export const CONDUCTIVITY_METER_GEOMETRY_CONFIG = config;
const build = buildPhProbeGeometry(config);
const totalHeightM = config.shaftHeightM + config.headSizeM * 0.7;

export const CONDUCTIVITY_METER_STANDARD: ApparatusDefinition = {
  id: 'conductivity-meter-standard',
  kind: 'CONDUCTIVITY_METER',
  category: 'instrument',
  label: 'Conductivity Probe',
  shortLabel: 'Conductivity',
  description: 'A combination-electrode conductivity probe. Dips into an open vessel to report a live conductivity reading.',
  version: 1,
  dimensionsM: { width: config.headSizeM, depth: config.headSizeM, height: totalHeightM },
  massKg: 0.055,
  collision: { kind: 'cylinder', radiusM: config.shaftRadiusM * 1.6, heightM: totalHeightM, centerM: [0, totalHeightM / 2 - config.shaftHeightM * 0.02, 0] },
  capabilities: ['CONDUCTIVITY_SENSOR', 'MOUNTABLE'],
  sockets: [
    {
      id: 'sensor-tip',
      label: 'Sensing cell',
      kind: 'SENSOR',
      role: 'sensor-probe',
      accepts: ['sensor-access'],
      gender: 'MALE',
      mate: 'proximity',
      transform: { positionM: [0, -config.bulbRadiusM * 0.3, 0], quaternion: [0, 0, 0, 1] },
      geometryCheck: { kind: 'none' },
      maxConnections: 1,
      highlightRadiusM: 0.015,
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
      highlightRadiusM: 0.018,
    },
  ],
  controls: [
    {
      id: 'immersion',
      label: 'Immersion',
      kind: 'PROBE_POSITION',
      actionType: 'SET_PROBE',
      description: 'How far the sensing cell is lowered into a vessel, from fully raised (0) to fully immersed (1).',
      valueType: 'number',
      range: { min: 0, max: 1, step: 0.01, unit: 'immersion fraction', default: 0 },
      requiresCapability: 'CONDUCTIVITY_SENSOR',
    },
  ],
  defaultConfig: {},
  configSchema: [],
  placement: { allowedSurfaceRoles: ['sensor-access', 'clamp-jaw'], allowRotationAboutUpAxis: false },
  asset: {
    source: 'procedural',
    proceduralBuilderId: 'conductivity-meter-standard',
    polyCount: build.polyCount,
    materialSlots: ['probe-bulb', 'probe-shaft', 'probe-head'],
    textureMemoryKB: 128,
    license: 'Procedural geometry authored for MATTER LAB; no external assets or textures used.',
    isPlaceholder: true,
    notes: 'Reuses the pH probe\u2019s geometry; a real conductivity cell has ring electrodes around the tip this placeholder does not model.',
  },
  thumbnail: { icon: 'Waves', previewColor: '#4fb3a9' },
  focusPointM: [0, config.shaftHeightM * 0.1, 0],
  tags: ['probe', 'instrument', 'conductivity', 'sensor'],
  provenance: {
    dimensions: 'REFERENCE_MEASURED',
    notes: `Shaft diameter follows the same generic combination-electrode form factor as the pH probe: ${dimensionSource('ph-combination-electrode-catalog').detail}`,
    sourceIds: [dimensionSource('ph-combination-electrode-catalog').id],
  },
};
