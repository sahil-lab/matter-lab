/**
 * Magnetic stirrer (STIRRER): a hotplate-less stirring base. Its top plate is a second
 * `flat-surface` role — the same role the workbench exposes — so a flask can rest on either
 * interchangeably, letting a station place the flask directly on the stirrer during titration.
 */
import { buildMagneticStirrerGeometry, DEFAULT_MAGNETIC_STIRRER_CONFIG } from '../geometry';
import { dimensionSource } from '../sources';
import { uprightSocketTransform } from '../transforms';
import type { ApparatusDefinition } from '../types';

const config = DEFAULT_MAGNETIC_STIRRER_CONFIG;
const build = buildMagneticStirrerGeometry(config);
const plateTopY = config.heightM + config.heightM * 0.2; // matches buildMagneticStirrerGeometry's plate placement

export const MAGNETIC_STIRRER_COMPACT: ApparatusDefinition = {
  id: 'magnetic-stirrer-compact',
  kind: 'STIRRER',
  category: 'instrument',
  label: 'Magnetic Stirrer',
  shortLabel: 'Stirrer',
  description: 'A compact magnetic stirrer. Spins a stir bar inside a vessel resting on its plate to keep the solution well mixed during a titration.',
  version: 1,
  dimensionsM: { width: config.widthM, depth: config.depthM, height: plateTopY },
  massKg: 1.1,
  collision: { kind: 'box', halfExtentsM: [config.widthM / 2, plateTopY / 2, config.depthM / 2], centerM: [0, plateTopY / 2, 0] },
  capabilities: ['MOUNT', 'MOUNTABLE', 'STIRRING'],
  sockets: [
    {
      id: 'base',
      label: 'Base (rests on a surface)',
      kind: 'MECHANICAL',
      role: 'flat-bottom',
      accepts: ['flat-surface'],
      gender: 'NEUTRAL',
      // 'coincident': a single reference point on the stirrer's own base; the surface side (the
      // bench top) is the side declaring 'planar' + an area. The stirrer's own 'plate' socket
      // below is a genuine surface in its own right and correctly stays 'planar'.
      mate: 'coincident',
      transform: uprightSocketTransform([0, 0, 0]),
      geometryCheck: { kind: 'none' },
      nominalFootprintM: { width: config.widthM, depth: config.depthM },
      maxConnections: 1,
      highlightRadiusM: config.widthM / 2,
    },
    {
      id: 'plate',
      label: 'Stirring plate',
      kind: 'MECHANICAL',
      role: 'flat-surface',
      accepts: ['flat-bottom'],
      gender: 'NEUTRAL',
      mate: 'planar',
      transform: uprightSocketTransform([0, plateTopY, 0]),
      planarAreaM: { width: config.plateRadiusM * 1.7, depth: config.plateRadiusM * 1.7 },
      geometryCheck: { kind: 'footprint-fit', maxWidthM: config.plateRadiusM * 1.9, maxDepthM: config.plateRadiusM * 1.9 },
      maxConnections: 2,
      highlightRadiusM: config.plateRadiusM,
    },
  ],
  controls: [
    {
      id: 'power',
      label: 'Power',
      kind: 'STIRRER_TOGGLE',
      actionType: 'START_STIRRER',
      description: 'Turns the stir plate motor on or off.',
      valueType: 'boolean',
      requiresCapability: 'STIRRING',
    },
    {
      id: 'speed',
      label: 'Stir speed',
      kind: 'STIRRER_SPEED',
      actionType: 'START_STIRRER',
      description: 'Sets the stir bar rotation speed.',
      valueType: 'number',
      range: { min: 0, max: 1500, step: 50, unit: 'rpm', default: 0 },
      requiresCapability: 'STIRRING',
    },
  ],
  defaultConfig: {},
  configSchema: [],
  placement: { allowedSurfaceRoles: ['flat-surface'], allowRotationAboutUpAxis: true, snapRotationDeg: 90 },
  asset: {
    source: 'procedural',
    proceduralBuilderId: 'magnetic-stirrer-compact',
    polyCount: build.polyCount,
    materialSlots: ['stirrer-body', 'stirrer-plate', 'stirrer-knob'],
    textureMemoryKB: 256,
    license: 'Procedural geometry authored for MATTER LAB; no external assets or textures used.',
    isPlaceholder: true,
    notes: 'A flat box body with a disc plate and a single knob; no control panel, display or cord are modeled — see module README.',
  },
  thumbnail: { icon: 'Magnet', previewColor: '#2b2f36' },
  focusPointM: [0, plateTopY, 0],
  tags: ['stirrer', 'instrument', 'mixing'],
  provenance: {
    dimensions: 'ILLUSTRATIVE',
    notes: dimensionSource('magnetic-stirrer-hotplate-catalog').detail,
    sourceIds: [dimensionSource('magnetic-stirrer-hotplate-catalog').id],
  },
};
