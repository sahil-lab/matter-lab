/**
 * Digital temperature sensor (TEMPERATURE_SENSOR): a thin probe for automated/logged temperature
 * tracking (e.g. during an exothermic titration), distinct from the passive, visually-read
 * `thermometer-standard` — this one declares the specific `TEMPERATURE_SENSOR` capability so
 * Agent 07 can distinguish an electronically-read instrument from a glass one if that ever matters.
 */
import { buildPhProbeGeometry, DEFAULT_PH_PROBE_CONFIG } from '../geometry';
import type { PhProbeGeometryConfig } from '../geometry';
import { dimensionSource } from '../sources';
import { uprightSocketTransform } from '../transforms';
import type { ApparatusDefinition } from '../types';

const config: PhProbeGeometryConfig = { ...DEFAULT_PH_PROBE_CONFIG, shaftRadiusM: 0.003, shaftHeightM: 0.12, bulbRadiusM: 0.0032, headSizeM: 0.02 };
/** Exported so the geometry builder registry can build from the exact same config as this
 * definition, rather than risking a second, possibly-drifted copy of these numbers. */
export const TEMPERATURE_SENSOR_GEOMETRY_CONFIG = config;
const build = buildPhProbeGeometry(config);
const totalHeightM = config.shaftHeightM + config.headSizeM * 0.7;

export const TEMPERATURE_SENSOR_STANDARD: ApparatusDefinition = {
  id: 'temperature-sensor-standard',
  kind: 'TEMPERATURE_SENSOR',
  category: 'instrument',
  label: 'Digital Temperature Probe',
  shortLabel: 'Temp. Probe',
  description: 'A thin digital temperature probe, for automated or logged temperature tracking during a run.',
  version: 1,
  dimensionsM: { width: config.headSizeM, depth: config.headSizeM, height: totalHeightM },
  massKg: 0.02,
  collision: { kind: 'cylinder', radiusM: config.shaftRadiusM * 1.6, heightM: totalHeightM, centerM: [0, totalHeightM / 2 - config.shaftHeightM * 0.02, 0] },
  capabilities: ['TEMPERATURE_SENSOR', 'MOUNTABLE'],
  sockets: [
    {
      id: 'sensor-tip',
      label: 'Sensing tip',
      kind: 'SENSOR',
      role: 'sensor-probe',
      accepts: ['sensor-access'],
      gender: 'MALE',
      mate: 'proximity',
      transform: { positionM: [0, -config.bulbRadiusM * 0.3, 0], quaternion: [0, 0, 0, 1] },
      geometryCheck: { kind: 'none' },
      maxConnections: 1,
      highlightRadiusM: 0.01,
    },
    {
      id: 'shaft-mount',
      // At 6 mm this probe's shaft is narrower than a standard burette clamp jaw's declared fit
      // range (see buretteClamp.ts) — it declares the mount socket for consistency with the other
      // probes, but a real attach attempt against the standard clamp is expected to be rejected as
      // DIAMETER_TOO_SMALL until a dedicated small-probe clamp is added.
      label: 'Shaft (can be held by a sufficiently narrow clamp)',
      kind: 'MECHANICAL',
      role: 'probe-shaft',
      accepts: ['clamp-jaw'],
      gender: 'MALE',
      mate: 'coincident',
      transform: uprightSocketTransform([0, config.shaftHeightM * 0.5, 0]),
      geometryCheck: { kind: 'none' },
      nominalDiameterM: config.shaftRadiusM * 2,
      maxConnections: 1,
      highlightRadiusM: 0.012,
    },
  ],
  controls: [
    {
      id: 'immersion',
      label: 'Immersion',
      kind: 'PROBE_POSITION',
      actionType: 'SET_PROBE',
      description: 'How far the sensing tip is lowered into a vessel, from fully raised (0) to fully immersed (1).',
      valueType: 'number',
      range: { min: 0, max: 1, step: 0.01, unit: 'immersion fraction', default: 0 },
      requiresCapability: 'TEMPERATURE_SENSOR',
    },
  ],
  defaultConfig: {},
  configSchema: [],
  placement: { allowedSurfaceRoles: ['sensor-access', 'clamp-jaw'], allowRotationAboutUpAxis: false },
  asset: {
    source: 'procedural',
    proceduralBuilderId: 'temperature-sensor-standard',
    polyCount: build.polyCount,
    materialSlots: ['probe-bulb', 'probe-shaft', 'probe-head'],
    textureMemoryKB: 96,
    license: 'Procedural geometry authored for MATTER LAB; no external assets or textures used.',
    isPlaceholder: true,
    notes: 'Reuses the pH probe\u2019s geometry at a thinner, RTD-probe-like proportion; no cable is modeled.',
  },
  thumbnail: { icon: 'Thermometer', previewColor: '#4fb3a9' },
  focusPointM: [0, config.shaftHeightM * 0.1, 0],
  tags: ['probe', 'instrument', 'temperature', 'sensor'],
  provenance: {
    dimensions: 'ILLUSTRATIVE',
    notes:
      `Loosely informed by the same generic combination-electrode form factor as the pH probe (${dimensionSource('ph-combination-electrode-catalog').id}), ` +
      'scaled down to a thinner RTD-probe-like shaft; no specific digital temperature probe catalog figure was verified.',
  },
};
