/**
 * Lab jack (LAB_JACK): a platform used to raise or lower a stirrer/heater beneath a clamped
 * vessel. The scissor mechanism is not functionally articulated in this revision — each instance
 * is a fixed height, not an adjustable prop (see `provenance.notes` and the geometry module doc).
 */
import { buildLabJackGeometry, DEFAULT_LAB_JACK_CONFIG } from '../geometry';
import { uprightSocketTransform } from '../transforms';
import type { ApparatusDefinition } from '../types';

const config = DEFAULT_LAB_JACK_CONFIG;
const build = buildLabJackGeometry(config);

export const LAB_JACK_STANDARD: ApparatusDefinition = {
  id: 'lab-jack-standard',
  kind: 'LAB_JACK',
  category: 'support',
  label: 'Lab Jack',
  shortLabel: 'Lab Jack',
  description: 'A platform for raising or lowering whatever rests on it (a stirrer, a heater) relative to a clamped vessel above.',
  version: 1,
  dimensionsM: { width: config.baseWidthM, depth: config.baseDepthM, height: config.heightM },
  massKg: 0.9,
  collision: { kind: 'box', halfExtentsM: [config.baseWidthM / 2, config.heightM / 2, config.baseDepthM / 2], centerM: [0, config.heightM / 2, 0] },
  capabilities: ['MOUNT', 'MOUNTABLE', 'SURFACE_SUPPORT'],
  sockets: [
    {
      id: 'base',
      label: 'Base (rests on a surface)',
      kind: 'MECHANICAL',
      role: 'flat-bottom',
      accepts: ['flat-surface'],
      gender: 'NEUTRAL',
      mate: 'coincident',
      transform: uprightSocketTransform([0, 0, 0]),
      geometryCheck: { kind: 'none' },
      nominalFootprintM: { width: config.baseWidthM, depth: config.baseDepthM },
      maxConnections: 1,
      highlightRadiusM: config.baseWidthM / 2,
    },
    {
      id: 'platform',
      label: 'Platform',
      kind: 'MECHANICAL',
      role: 'flat-surface',
      accepts: ['flat-bottom'],
      gender: 'NEUTRAL',
      mate: 'planar',
      transform: uprightSocketTransform([0, config.heightM, 0]),
      planarAreaM: { width: config.platformWidthM * 0.92, depth: config.platformDepthM * 0.92 },
      geometryCheck: { kind: 'footprint-fit', maxWidthM: config.platformWidthM * 0.95, maxDepthM: config.platformDepthM * 0.95 },
      maxConnections: 2,
      highlightRadiusM: config.platformWidthM / 2,
    },
  ],
  controls: [],
  defaultConfig: {},
  configSchema: [],
  placement: { allowedSurfaceRoles: ['flat-surface'], allowRotationAboutUpAxis: true, snapRotationDeg: 90 },
  asset: {
    source: 'procedural',
    proceduralBuilderId: 'lab-jack-standard',
    polyCount: build.polyCount,
    materialSlots: ['jack-metal', 'jack-platform'],
    textureMemoryKB: 192,
    license: 'Procedural geometry authored for MATTER LAB; no external assets or textures used.',
    isPlaceholder: true,
    notes: 'A static placeholder: the scissor mechanism is two fixed crossed struts, not an articulated, height-adjustable lift.',
  },
  thumbnail: { icon: 'ChevronsUpDown', previewColor: '#9aa5b1' },
  focusPointM: [0, config.heightM, 0],
  tags: ['lab-jack', 'support'],
  provenance: {
    dimensions: 'ILLUSTRATIVE',
    notes: 'Generic small-to-mid lab jack proportions (real lab jacks commonly range roughly 50-300 mm tall); no specific catalog figure was verified.',
  },
};
