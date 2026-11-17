/**
 * Burette clamp (CLAMP): a boss head that grips a retort stand's rod, and a jaw that grips a
 * burette barrel. This is the pairing the brief's worked example names directly: "burette clamp
 * socket accepts a compatible burette barrel; stand pole accepts clamp".
 */
import { buildBuretteClampGeometry, calibratedBarrelDiameterM, DEFAULT_BURETTE_CLAMP_CONFIG } from '../geometry';
import { dimensionSource } from '../sources';
import { uprightSocketTransform } from '../transforms';
import type { ApparatusDefinition } from '../types';

const config = DEFAULT_BURETTE_CLAMP_CONFIG;
const build = buildBuretteClampGeometry(config);
const barrelDiameterM = calibratedBarrelDiameterM();

export const BURETTE_CLAMP_BOSS_HEAD: ApparatusDefinition = {
  id: 'burette-clamp-boss-head',
  kind: 'CLAMP',
  category: 'support',
  label: 'Burette Clamp',
  shortLabel: 'Clamp',
  description: 'A boss-head clamp: one jaw grips a retort stand\u2019s rod, the other grips a burette barrel at any height along the rod.',
  version: 1,
  dimensionsM: { width: config.bossSizeM / 2 + config.armLengthM + config.jawRadiusM, depth: config.bossSizeM, height: Math.max(config.bossSizeM, config.jawHeightM) },
  massKg: 0.18,
  collision: {
    kind: 'compound',
    parts: [
      { kind: 'box', halfExtentsM: [config.bossSizeM / 2, config.bossSizeM / 2, config.bossSizeM / 2] },
      { kind: 'cylinder', radiusM: config.jawRadiusM, heightM: config.jawHeightM, centerM: [config.armLengthM, 0, 0] },
    ],
  },
  capabilities: ['MOUNT', 'MOUNTABLE'],
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
      // This clamp is always the grip/child side of the pairing in the vertical slice (the stand's
      // own range governs); see `uprightSocketTransform`'s doc and the parent-first note in `sockets.ts`.
      axialRangeM: [0, 0],
      geometryCheck: { kind: 'cylinder-fit', minDiameterM: 0.008, maxDiameterM: 0.016 },
      maxConnections: 1,
      highlightRadiusM: 0.035,
    },
    {
      id: 'jaw',
      label: 'Jaw (grips the burette barrel or a probe shaft)',
      kind: 'MECHANICAL',
      role: 'clamp-jaw',
      accepts: ['burette-barrel', 'probe-shaft'],
      gender: 'FEMALE',
      mate: 'coincident',
      transform: uprightSocketTransform([config.armLengthM, 0, 0]),
      // Brackets the calibrated ~9 mm burette barrel and a ~12 mm combination-electrode shaft
      // (pH/conductivity probe) with headroom for similar-diameter glassware; a wide-mouth bottle
      // neck, or a narrower ~6 mm digital temperature probe shaft, should still be rejected.
      geometryCheck: { kind: 'cylinder-fit', minDiameterM: 0.007, maxDiameterM: 0.012 },
      maxConnections: 1,
      highlightRadiusM: 0.025,
    },
  ],
  controls: [],
  defaultConfig: {},
  configSchema: [],
  placement: { allowedSurfaceRoles: ['stand-pole'], allowRotationAboutUpAxis: false },
  asset: {
    source: 'procedural',
    proceduralBuilderId: 'burette-clamp-boss-head',
    polyCount: build.polyCount,
    materialSlots: ['clamp-metal', 'clamp-jaw-pad'],
    textureMemoryKB: 192,
    license: 'Procedural geometry authored for MATTER LAB; no external assets or textures used.',
    isPlaceholder: true,
    notes: 'Simple box/cylinder approximation; a real boss head has a hinged, bolted jaw this placeholder does not model — see module README.',
  },
  thumbnail: { icon: 'Wrench', previewColor: '#9aa5b1' },
  focusPointM: [config.armLengthM, 0, 0],
  tags: ['clamp', 'support', 'boss-head'],
  provenance: {
    dimensions: 'REFERENCE_MEASURED',
    notes: `Boss head and jaw sizing follow common catalog specifications: ${dimensionSource('boss-head-clamp-catalog').detail} The modeled burette barrel (${(barrelDiameterM * 1000).toFixed(1)} mm, after capacity calibration) falls inside this range.`,
    sourceIds: [dimensionSource('boss-head-clamp-catalog').id],
  },
};
