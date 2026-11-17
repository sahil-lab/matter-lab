/**
 * Support (ring) clamp (SUPPORT_RING): a boss head gripping a stand's rod, with a flat wire ring
 * at the end that cradles a funnel, an evaporating dish, or anything else declaring a
 * `flat-bottom` socket — the ring's own socket reuses the exact `flat-surface` role the workbench
 * and stirrer plate use, so anything that already rests on a bench rests in a ring too.
 */
import { buildSupportRingGeometry, DEFAULT_SUPPORT_RING_CONFIG } from '../geometry';
import { dimensionSource } from '../sources';
import { uprightSocketTransform } from '../transforms';
import type { ApparatusDefinition } from '../types';

const config = DEFAULT_SUPPORT_RING_CONFIG;
const build = buildSupportRingGeometry(config);
const ringCenterX = config.armLengthM + config.ringRadiusM;
const ringClearDiameterM = (config.ringRadiusM - config.tubeRadiusM) * 2;

export const SUPPORT_RING_STANDARD: ApparatusDefinition = {
  id: 'support-ring-standard',
  kind: 'SUPPORT_RING',
  category: 'support',
  label: 'Support Ring',
  shortLabel: 'Ring',
  description: 'A boss-head ring clamp. Cradles a funnel or dish at any height along a retort stand\u2019s rod.',
  version: 1,
  dimensionsM: { width: ringCenterX + config.ringRadiusM, depth: config.ringRadiusM * 2, height: config.bossSizeM },
  massKg: 0.12,
  collision: {
    kind: 'compound',
    parts: [
      { kind: 'box', halfExtentsM: [config.bossSizeM / 2, config.bossSizeM / 2, config.bossSizeM / 2] },
      { kind: 'cylinder', radiusM: config.ringRadiusM + config.tubeRadiusM, heightM: config.tubeRadiusM * 2, centerM: [ringCenterX, 0, 0] },
    ],
  },
  capabilities: ['MOUNT', 'MOUNTABLE', 'SURFACE_SUPPORT'],
  sockets: [
    {
      id: 'boss-head',
      label: 'Boss head (grips the stand rod)',
      kind: 'MECHANICAL',
      role: 'boss-head',
      accepts: ['stand-pole'],
      gender: 'FEMALE',
      mate: 'axial',
      transform: uprightSocketTransform([0, 0, 0]),
      axialRangeM: [0, 0], // this ring is always the grip/child side; see sockets.ts's parent-first note
      geometryCheck: { kind: 'cylinder-fit', minDiameterM: 0.008, maxDiameterM: 0.016 },
      maxConnections: 1,
      highlightRadiusM: 0.035,
    },
    {
      id: 'ring-surface',
      label: 'Ring (cradles a funnel or dish)',
      kind: 'MECHANICAL',
      role: 'flat-surface',
      accepts: ['flat-bottom'],
      gender: 'NEUTRAL',
      mate: 'planar',
      transform: uprightSocketTransform([ringCenterX, 0, 0]),
      planarAreaM: { width: ringClearDiameterM * 0.9, depth: ringClearDiameterM * 0.9 },
      geometryCheck: { kind: 'footprint-fit', maxWidthM: ringClearDiameterM, maxDepthM: ringClearDiameterM },
      maxConnections: 1,
      highlightRadiusM: config.ringRadiusM,
    },
  ],
  controls: [],
  defaultConfig: {},
  configSchema: [],
  placement: { allowedSurfaceRoles: ['stand-pole'], allowRotationAboutUpAxis: false },
  asset: {
    source: 'procedural',
    proceduralBuilderId: 'support-ring-standard',
    polyCount: build.polyCount,
    materialSlots: ['ring-metal'],
    textureMemoryKB: 128,
    license: 'Procedural geometry authored for MATTER LAB; no external assets or textures used.',
    isPlaceholder: true,
    notes: 'A solid boss head and plain torus; a real ring clamp has a hinged, bolted jaw this placeholder does not model.',
  },
  thumbnail: { icon: 'CircleDashed', previewColor: '#9aa5b1' },
  focusPointM: [ringCenterX, 0, 0],
  tags: ['support-ring', 'support', 'clamp'],
  provenance: {
    dimensions: 'REFERENCE_MEASURED',
    notes: dimensionSource('support-ring-catalog').detail,
    sourceIds: [dimensionSource('support-ring-catalog').id],
  },
};
