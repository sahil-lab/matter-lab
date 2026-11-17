/**
 * Digital balance (BALANCE): a weighing pan (reusing the `flat-surface` role every other surface
 * in this module uses) plus `tare`/`readout` controls. This module never computes or reports an
 * actual mass — Agent 07 owns that; `readout` exists purely so Agent 01's inspector knows this
 * instrument displays a measured value, not an adjustable input (see its description).
 */
import { buildBalanceGeometry, DEFAULT_BALANCE_CONFIG } from '../geometry';
import { uprightSocketTransform } from '../transforms';
import type { ApparatusDefinition } from '../types';

const config = DEFAULT_BALANCE_CONFIG;
const build = buildBalanceGeometry(config);
const panTopY = config.bodyHeightM + config.panHeightM;

export const BALANCE_STANDARD: ApparatusDefinition = {
  id: 'balance-standard',
  kind: 'BALANCE',
  category: 'instrument',
  label: 'Digital Balance',
  shortLabel: 'Balance',
  description: 'A digital balance. Reports the mass of whatever rests on its pan.',
  version: 1,
  dimensionsM: { width: config.bodyWidthM, depth: config.bodyDepthM, height: panTopY },
  massKg: 1.6,
  collision: { kind: 'box', halfExtentsM: [config.bodyWidthM / 2, panTopY / 2, config.bodyDepthM / 2], centerM: [0, panTopY / 2, 0] },
  capabilities: ['MOUNT', 'MOUNTABLE', 'MEASUREMENT'],
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
      nominalFootprintM: { width: config.bodyWidthM, depth: config.bodyDepthM },
      maxConnections: 1,
      highlightRadiusM: config.bodyWidthM / 2,
    },
    {
      id: 'pan',
      label: 'Weighing pan',
      kind: 'MECHANICAL',
      role: 'flat-surface',
      accepts: ['flat-bottom'],
      gender: 'NEUTRAL',
      mate: 'planar',
      transform: uprightSocketTransform([0, panTopY, config.bodyDepthM * 0.05]),
      planarAreaM: { width: config.panRadiusM * 1.6, depth: config.panRadiusM * 1.6 },
      geometryCheck: { kind: 'footprint-fit', maxWidthM: config.panRadiusM * 1.9, maxDepthM: config.panRadiusM * 1.9 },
      maxConnections: 1,
      highlightRadiusM: config.panRadiusM,
    },
  ],
  controls: [
    {
      id: 'tare',
      label: 'Tare',
      kind: 'BALANCE_TARE',
      actionType: 'CUSTOM',
      description: 'Zeroes the balance against whatever is currently on the pan.',
      valueType: 'boolean',
      requiresCapability: 'MEASUREMENT',
    },
    {
      id: 'readout',
      label: 'Mass reading',
      kind: 'READOUT',
      actionType: 'CUSTOM',
      description: 'The currently displayed mass. Informational only — Agent 07 computes it from the pan\u2019s contents; nothing dispatches this control from a user action.',
      valueType: 'number',
      range: { min: 0, max: 500, unit: 'g', default: 0 },
      requiresCapability: 'MEASUREMENT',
    },
  ],
  defaultConfig: {},
  configSchema: [],
  placement: { allowedSurfaceRoles: ['flat-surface'], allowRotationAboutUpAxis: true, snapRotationDeg: 90 },
  asset: {
    source: 'procedural',
    proceduralBuilderId: 'balance-standard',
    polyCount: build.polyCount,
    materialSlots: ['balance-body', 'balance-pan', 'balance-display'],
    textureMemoryKB: 192,
    license: 'Procedural geometry authored for MATTER LAB; no external assets or textures used.',
    isPlaceholder: true,
    notes: 'A flat body, a disc pan and a blank display panel; no buttons, draft shield or a readable digit display are modeled.',
  },
  thumbnail: { icon: 'Scale', previewColor: '#2b2f36' },
  focusPointM: [0, panTopY, 0],
  tags: ['balance', 'instrument', 'mass'],
  provenance: {
    dimensions: 'ILLUSTRATIVE',
    notes: 'Generic compact digital balance proportions; no specific catalog figure was verified.',
  },
};
