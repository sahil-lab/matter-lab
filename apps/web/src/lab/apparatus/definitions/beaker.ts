/**
 * Low-form beaker (BEAKER): general-purpose open vessel. Commonly used both as a mixing/receiving
 * container and as a convenient place to dip a pH probe outside the formal titration flask.
 */
import { buildBeakerGeometry, beakerGlassProfile, DEFAULT_BEAKER_CONFIG } from '../geometry';
import { containerFromProfilePoints, profileBoundingDimensions } from '../container';
import { dimensionSource } from '../sources';
import { uprightSocketTransform } from '../transforms';
import type { ApparatusDefinition, Transform } from '../types';

const config = DEFAULT_BEAKER_CONFIG;
const build = buildBeakerGeometry(config);
const profile = beakerGlassProfile(config);
const container = containerFromProfilePoints(profile);
const bounds = profileBoundingDimensions(profile);
const mouthTransform: Transform = { positionM: [0, config.heightM, 0], quaternion: [0, 0, 0, 1] };

export const BEAKER_250ML_LOW_FORM: ApparatusDefinition = {
  id: 'beaker-250ml-low-form',
  kind: 'BEAKER',
  category: 'glassware',
  label: '250 mL Beaker (Low Form)',
  shortLabel: 'Beaker',
  description: 'A low-form beaker with a pour spout. General-purpose mixing and receiving vessel; its graduations are approximate, not precision markings.',
  version: 1,
  dimensionsM: { width: bounds.widthM, depth: bounds.widthM, height: config.heightM },
  massKg: 0.1,
  collision: { kind: 'cylinder', radiusM: bounds.widthM / 2, heightM: config.heightM, centerM: [0, config.heightM / 2, 0] },
  capabilities: ['CONTAINER', 'FLOW_RECEIVER'],
  sockets: [
    {
      id: 'base',
      label: 'Base (rests on a surface)',
      kind: 'MECHANICAL',
      role: 'flat-bottom',
      accepts: ['flat-surface'],
      gender: 'NEUTRAL',
      // 'coincident': this is a single reference point on the beaker, not an area of its own — the
      // *surface* socket it mates with (e.g. the bench top) is the side declaring 'planar' + an area.
      mate: 'coincident',
      transform: uprightSocketTransform([0, 0, 0]),
      geometryCheck: { kind: 'none' },
      nominalFootprintM: { width: bounds.widthM, depth: bounds.widthM },
      maxConnections: 1,
      highlightRadiusM: bounds.widthM / 2,
    },
    {
      id: 'mouth-inlet',
      label: 'Mouth (receives liquid)',
      kind: 'FLUID',
      role: 'liquid-inlet-open',
      accepts: ['liquid-outlet-valved', 'liquid-outlet-pour'],
      gender: 'NEUTRAL',
      mate: 'proximity',
      transform: mouthTransform,
      geometryCheck: { kind: 'none' },
      maxConnections: 1,
      highlightRadiusM: 0.03,
    },
    {
      id: 'sensor-access',
      label: 'Mouth (accepts a dipped sensor)',
      kind: 'SENSOR',
      role: 'sensor-access',
      accepts: ['sensor-probe'],
      gender: 'NEUTRAL',
      mate: 'proximity',
      transform: mouthTransform,
      geometryCheck: { kind: 'none' },
      maxConnections: 2,
      highlightRadiusM: 0.03,
    },
  ],
  flowPorts: [{ id: 'mouth', label: 'Mouth', direction: 'INLET', transform: mouthTransform }],
  controls: [
    {
      id: 'fill',
      label: 'Charge contents',
      kind: 'FILL',
      actionType: 'FILL',
      description: 'Sets up an initial charge before a run starts.',
      valueType: 'number',
      range: { min: 0, max: container.capacityL, step: 0.0005, unit: 'L', default: 0 },
      requiresCapability: 'CONTAINER',
    },
  ],
  container,
  defaultConfig: { contentsLabel: '' },
  configSchema: [
    { key: 'contentsLabel', label: 'Contents label', type: 'string', default: '', description: 'Free-text note for the inspector. Display only.' },
  ],
  placement: { allowedSurfaceRoles: ['flat-surface'], allowRotationAboutUpAxis: true, snapRotationDeg: 0 },
  asset: {
    source: 'procedural',
    proceduralBuilderId: 'beaker-250ml-low-form',
    polyCount: build.polyCount,
    materialSlots: ['glass'],
    textureMemoryKB: 160,
    license: 'Procedural geometry authored for MATTER LAB; no external assets or textures used.',
    isPlaceholder: false,
  },
  thumbnail: { icon: 'Beaker', previewColor: '#cdeaf0' },
  focusPointM: [0, config.heightM * 0.5, 0],
  tags: ['beaker', 'glassware'],
  provenance: {
    dimensions: 'REFERENCE_MEASURED',
    notes:
      `${dimensionSource('iso-3819-beaker-250ml').detail} Simulated capacity is set to the nominal rated 250 mL; beakers are non-volumetric ` +
      'glassware, so this is a simulated working ceiling, not a precision measurement.',
    sourceIds: [dimensionSource('iso-3819-beaker-250ml').id],
  },
};
