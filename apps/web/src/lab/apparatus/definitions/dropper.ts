/**
 * Dropper (DROPPER): a short Pasteur-style pipette with a squeeze bulb, for small, approximate
 * transfers (a drop or a few mL) rather than a single calibrated volume.
 */
import { buildDropperGeometry, dropperGlassProfile, DEFAULT_DROPPER_CONFIG } from '../geometry';
import { containerFromProfilePoints, profileBoundingDimensions } from '../container';
import { dimensionSource } from '../sources';
import { IDENTITY_TRANSFORM } from '../transforms';
import type { ApparatusDefinition } from '../types';

const config = DEFAULT_DROPPER_CONFIG;
const build = buildDropperGeometry(config);
const profile = dropperGlassProfile(config);
const container = containerFromProfilePoints(profile);
const bounds = profileBoundingDimensions(profile);
const totalHeightM = config.glassHeightM + config.bulbRadiusM * 1.5;

export const DROPPER_STANDARD: ApparatusDefinition = {
  id: 'dropper-standard',
  kind: 'DROPPER',
  category: 'glassware',
  label: 'Dropper',
  shortLabel: 'Dropper',
  description: 'A short glass dropper with a rubber squeeze bulb. Delivers approximate, drop-by-drop volumes rather than a calibrated amount.',
  version: 1,
  dimensionsM: { width: Math.max(bounds.widthM, config.bulbRadiusM * 2), depth: Math.max(bounds.widthM, config.bulbRadiusM * 2), height: totalHeightM },
  massKg: 0.012,
  collision: { kind: 'cylinder', radiusM: config.bulbRadiusM, heightM: totalHeightM, centerM: [0, totalHeightM / 2, 0] },
  capabilities: ['CONTAINER', 'FLOW_SOURCE'],
  sockets: [
    {
      id: 'tip-outlet',
      label: 'Tip (dispenses drops)',
      kind: 'FLUID',
      role: 'liquid-outlet-pour',
      accepts: ['liquid-inlet-open'],
      gender: 'NEUTRAL',
      mate: 'proximity',
      transform: IDENTITY_TRANSFORM,
      geometryCheck: { kind: 'none' },
      maxConnections: 1,
      highlightRadiusM: 0.006,
    },
  ],
  flowPorts: [{ id: 'tip', label: 'Tip', direction: 'OUTLET', transform: IDENTITY_TRANSFORM, maxFlowRateLPerS: 0.0005 }],
  controls: [
    {
      id: 'fill',
      label: 'Draw up',
      kind: 'FILL',
      actionType: 'FILL',
      description: 'Squeezes the bulb and releases it to draw up the chosen species to the given volume.',
      valueType: 'number',
      range: { min: 0, max: container.capacityL, step: 0.0001, unit: 'L', default: 0 },
      requiresCapability: 'CONTAINER',
    },
    {
      id: 'release',
      label: 'Release a drop',
      kind: 'CUSTOM',
      actionType: 'CUSTOM',
      description: 'Squeezes the bulb to release a drop (or the full held volume) into whatever vessel the tip is positioned over. Agent 07 resolves the actual transfer.',
      valueType: 'boolean',
      requiresCapability: 'FLOW_SOURCE',
    },
  ],
  container,
  defaultConfig: { contentsLabel: '' },
  configSchema: [
    { key: 'contentsLabel', label: 'Contents label', type: 'string', default: '', description: 'Free-text note for the inspector. Display only.' },
  ],
  placement: { allowedSurfaceRoles: ['liquid-inlet-open'], allowRotationAboutUpAxis: false },
  asset: {
    source: 'procedural',
    proceduralBuilderId: 'dropper-standard',
    polyCount: build.polyCount,
    materialSlots: ['glass', 'rubber-bulb'],
    textureMemoryKB: 96,
    license: 'Procedural geometry authored for MATTER LAB; no external assets or textures used.',
    isPlaceholder: true,
    notes: 'The bulb is a plain sphere; a real teat is a softer, tapered rubber shape this placeholder does not model.',
  },
  thumbnail: { icon: 'Droplet', previewColor: '#cdeaf0' },
  focusPointM: [0, config.glassHeightM * 0.5, 0],
  tags: ['dropper', 'glassware', 'pasteur-pipette'],
  provenance: {
    dimensions: 'REFERENCE_MEASURED',
    notes: `${dimensionSource('pasteur-pipette-catalog').detail} This definition models the shorter (~150 mm) common type.`,
    sourceIds: [dimensionSource('pasteur-pipette-catalog').id],
  },
};
