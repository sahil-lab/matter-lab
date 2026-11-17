/**
 * Filter/powder funnel (FUNNEL): a flow passage, not a liquid-holding container — it declares no
 * `CONTAINER` capability. Typically handheld or resting loosely in a flask neck or support ring;
 * this revision does not model a rigid mechanical rest (see `provenance.notes`).
 */
import { buildFunnelGeometry, DEFAULT_FUNNEL_CONFIG } from '../geometry';
import { IDENTITY_TRANSFORM } from '../transforms';
import type { ApparatusDefinition, Transform } from '../types';

const config = DEFAULT_FUNNEL_CONFIG;
const build = buildFunnelGeometry(config);
const totalHeightM = config.stemHeightM + config.bowlHeightM;
const bowlTopTransform: Transform = { positionM: [0, totalHeightM, 0], quaternion: [0, 0, 0, 1] };

export const FUNNEL_STANDARD: ApparatusDefinition = {
  id: 'funnel-standard',
  kind: 'FUNNEL',
  category: 'fluid-control',
  label: 'Funnel',
  shortLabel: 'Funnel',
  description: 'A conical funnel with a long stem. Directs a pour into a narrow-necked vessel below; holds no liquid of its own.',
  version: 1,
  dimensionsM: { width: config.bowlTopRadiusM * 2, depth: config.bowlTopRadiusM * 2, height: totalHeightM },
  massKg: 0.05,
  collision: { kind: 'cylinder', radiusM: config.bowlTopRadiusM, heightM: totalHeightM, centerM: [0, totalHeightM / 2, 0] },
  capabilities: ['FLOW_SOURCE', 'FLOW_RECEIVER'],
  sockets: [
    {
      id: 'bowl-inlet',
      label: 'Bowl (receives a pour)',
      kind: 'FLUID',
      role: 'liquid-inlet-open',
      accepts: ['liquid-outlet-valved', 'liquid-outlet-pour'],
      gender: 'NEUTRAL',
      mate: 'proximity',
      transform: bowlTopTransform,
      geometryCheck: { kind: 'none' },
      maxConnections: 1,
      highlightRadiusM: config.bowlTopRadiusM * 0.8,
    },
    {
      id: 'stem-outlet',
      label: 'Stem (pours out)',
      kind: 'FLUID',
      role: 'liquid-outlet-pour',
      accepts: ['liquid-inlet-open'],
      gender: 'NEUTRAL',
      mate: 'proximity',
      transform: IDENTITY_TRANSFORM,
      geometryCheck: { kind: 'none' },
      maxConnections: 1,
      highlightRadiusM: 0.01,
    },
  ],
  flowPorts: [
    { id: 'bowl', label: 'Bowl', direction: 'INLET', transform: bowlTopTransform },
    { id: 'stem', label: 'Stem', direction: 'OUTLET', transform: IDENTITY_TRANSFORM },
  ],
  controls: [],
  defaultConfig: {},
  configSchema: [],
  // No modeled rigid rest in this revision — see provenance.notes.
  placement: { allowedSurfaceRoles: [], allowRotationAboutUpAxis: false },
  asset: {
    source: 'procedural',
    proceduralBuilderId: 'funnel-standard',
    polyCount: build.polyCount,
    materialSlots: ['glass'],
    textureMemoryKB: 96,
    license: 'Procedural geometry authored for MATTER LAB; no external assets or textures used.',
    isPlaceholder: true,
    notes:
      'Resting in a support ring or a flask neck (a real funnel\u2019s normal use) is not modeled as a rigid socket in this revision \u2014 ' +
      'only its fluid inlet/outlet are. It is assumed handheld or freely positioned until that gap is addressed (see module README).',
  },
  thumbnail: { icon: 'Filter', previewColor: '#cdeaf0' },
  focusPointM: [0, config.stemHeightM, 0],
  tags: ['funnel', 'glassware', 'fluid-control'],
  provenance: {
    dimensions: 'ILLUSTRATIVE',
    notes: 'Generic small filter-funnel proportions; no specific catalog figure was verified for this exact size.',
  },
};
