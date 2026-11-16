/**
 * Retort (ring) stand (STAND): a base plate and a vertical rod. The rod is the mounting rail a
 * burette clamp slides along — see the brief's worked example, "stand pole accepts clamp".
 */
import { buildRetortStandGeometry, DEFAULT_RETORT_STAND_CONFIG } from '../geometry';
import { dimensionSource } from '../sources';
import { uprightSocketTransform } from '../transforms';
import type { ApparatusDefinition } from '../types';

const config = DEFAULT_RETORT_STAND_CONFIG;
const build = buildRetortStandGeometry(config);
// Matches buildRetortStandGeometry's own rod placement (geometry/retortStand.ts): offset toward
// one edge of the base so clamped glassware hangs clear of the base plate.
const rodOffsetZ = config.baseDepthM / 2 - config.rodRadiusM * 2;
const rodBaseY = config.baseThicknessM;
const clampMargin = 0.02; // keep clamps from sliding fully off either end of the rod

export const RETORT_STAND_600MM: ApparatusDefinition = {
  id: 'retort-stand-600mm',
  kind: 'STAND',
  category: 'support',
  label: 'Retort Stand (600 mm rod)',
  shortLabel: 'Stand',
  description: 'A base plate with a vertical support rod. Burette clamps and support rings slide along the rod and lock at any height.',
  version: 1,
  dimensionsM: { width: config.baseWidthM, depth: config.baseDepthM, height: rodBaseY + config.rodHeightM },
  massKg: 1.4,
  collision: {
    kind: 'compound',
    parts: [
      { kind: 'box', halfExtentsM: [config.baseWidthM / 2, config.baseThicknessM / 2, config.baseDepthM / 2], centerM: [0, config.baseThicknessM / 2, 0] },
      { kind: 'cylinder', radiusM: config.rodRadiusM, heightM: config.rodHeightM, centerM: [0, rodBaseY + config.rodHeightM / 2, rodOffsetZ] },
    ],
  },
  capabilities: ['MOUNT', 'MOUNTABLE'],
  sockets: [
    {
      id: 'base',
      label: 'Base (rests on a surface)',
      kind: 'MECHANICAL',
      role: 'flat-bottom',
      accepts: ['flat-surface'],
      gender: 'NEUTRAL',
      // 'coincident': a single reference point on the stand's base; the surface side (the bench
      // top) is the side declaring 'planar' + an area.
      mate: 'coincident',
      transform: uprightSocketTransform([0, 0, 0]),
      geometryCheck: { kind: 'none' },
      nominalFootprintM: { width: config.baseWidthM, depth: config.baseDepthM },
      maxConnections: 1,
      highlightRadiusM: 0.1,
    },
    {
      id: 'pole',
      label: 'Support rod',
      kind: 'MECHANICAL',
      role: 'stand-pole',
      accepts: ['boss-head'],
      gender: 'MALE',
      mate: 'axial',
      transform: uprightSocketTransform([0, rodBaseY, rodOffsetZ]),
      axialRangeM: [clampMargin, config.rodHeightM - clampMargin],
      geometryCheck: { kind: 'none' },
      nominalDiameterM: config.rodRadiusM * 2,
      // A real stand commonly carries more than one boss-head fitting (burette clamp plus a ring
      // clamp, say) at independent heights along the same rod.
      maxConnections: 4,
      highlightRadiusM: 0.03,
    },
  ],
  controls: [],
  defaultConfig: {},
  configSchema: [],
  placement: { allowedSurfaceRoles: ['flat-surface'], allowRotationAboutUpAxis: true, snapRotationDeg: 45 },
  asset: {
    source: 'procedural',
    proceduralBuilderId: 'retort-stand-600mm',
    polyCount: build.polyCount,
    materialSlots: ['stand-metal'],
    textureMemoryKB: 256,
    license: 'Procedural geometry authored for MATTER LAB; no external assets or textures used.',
    isPlaceholder: false,
  },
  thumbnail: { icon: 'GitCommitVertical', previewColor: '#9aa5b1' },
  focusPointM: [0, rodBaseY + config.rodHeightM * 0.6, rodOffsetZ],
  guidedHighlight: { anchorM: [0, rodBaseY + config.rodHeightM * 0.5, rodOffsetZ], radiusM: 0.08 },
  tags: ['stand', 'support', 'retort-stand'],
  provenance: {
    dimensions: 'REFERENCE_MEASURED',
    notes:
      'Base and rod dimensions follow common laboratory retort/ring stand catalog specifications: ' +
      dimensionSource('retort-stand-catalog').detail,
    sourceIds: [dimensionSource('retort-stand-catalog').id],
  },
};
