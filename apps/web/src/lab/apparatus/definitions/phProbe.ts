/**
 * Combination pH probe (PH_PROBE): a dip sensor for the live pH readout in the shared vertical
 * slice. It reports a `PROBE_POSITION` control for how far it is immersed; Agent 06/07 own
 * actually computing a pH value from validated chemical state — this module never does.
 */
import { buildPhProbeGeometry, DEFAULT_PH_PROBE_CONFIG } from '../geometry';
import { dimensionSource } from '../sources';
import type { ApparatusDefinition } from '../types';

const config = DEFAULT_PH_PROBE_CONFIG;
const build = buildPhProbeGeometry(config);
const totalHeightM = config.shaftHeightM + config.headSizeM * 0.7;

export const PH_PROBE_COMBINATION: ApparatusDefinition = {
  id: 'ph-probe-combination',
  kind: 'PH_PROBE',
  category: 'instrument',
  label: 'Combination pH Probe',
  shortLabel: 'pH Probe',
  description: 'A combination glass-body pH electrode. Dips into an open vessel to report a live pH reading.',
  version: 1,
  dimensionsM: { width: config.headSizeM, depth: config.headSizeM, height: totalHeightM },
  massKg: 0.06,
  collision: { kind: 'cylinder', radiusM: config.shaftRadiusM * 1.6, heightM: totalHeightM, centerM: [0, totalHeightM / 2 - config.shaftHeightM * 0.02, 0] },
  capabilities: ['PH_SENSOR'],
  sockets: [
    {
      id: 'sensor-tip',
      label: 'Sensing bulb',
      kind: 'SENSOR',
      role: 'sensor-probe',
      accepts: ['sensor-access'],
      gender: 'MALE',
      mate: 'proximity',
      // The sensing bulb sits a little below the shaft's local origin — see geometry/phProbe.ts.
      transform: { positionM: [0, -config.bulbRadiusM * 0.3, 0], quaternion: [0, 0, 0, 1] },
      geometryCheck: { kind: 'none' },
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
      description: 'How far the sensing bulb is lowered into a vessel, from fully raised (0) to fully immersed (1).',
      valueType: 'number',
      range: { min: 0, max: 1, step: 0.01, unit: 'immersion fraction', default: 0 },
      requiresCapability: 'PH_SENSOR',
    },
  ],
  defaultConfig: {},
  configSchema: [],
  // A probe is normally hand-positioned over a vessel rather than rigidly mounted, so it declares
  // no `flat-surface`-compatible resting socket in this revision — see module README "known gaps".
  placement: { allowedSurfaceRoles: ['sensor-access'], allowRotationAboutUpAxis: false },
  asset: {
    source: 'procedural',
    proceduralBuilderId: 'ph-probe-combination',
    polyCount: build.polyCount,
    materialSlots: ['probe-bulb', 'probe-shaft', 'probe-head'],
    textureMemoryKB: 128,
    license: 'Procedural geometry authored for MATTER LAB; no external assets or textures used.',
    isPlaceholder: true,
    notes: 'A plain shaft, bulb and connector-head box; no BNC connector or cable is modeled — see module README.',
  },
  thumbnail: { icon: 'Radar', previewColor: '#4fb3a9' },
  focusPointM: [0, config.shaftHeightM * 0.1, 0],
  guidedHighlight: { anchorM: [0, 0, 0], radiusM: 0.02 },
  tags: ['probe', 'instrument', 'ph', 'sensor'],
  provenance: {
    dimensions: 'REFERENCE_MEASURED',
    notes:
      `Shaft diameter follows common combination pH electrode catalog specifications: ${dimensionSource('ph-combination-electrode-catalog').detail} ` +
      'The sensing bulb and BNC connector head are illustrative approximations of a generic combination electrode, not a specific modeled product.',
    sourceIds: [dimensionSource('ph-combination-electrode-catalog').id],
  },
};
