/**
 * Reagent bottle (BOTTLE): identifies what reagent is available at a station (e.g. "0.100 mol/L
 * NaOH titrant") and can pour it out through its neck — its `liquid-outlet-pour` socket is the
 * same role the pipette and dropper use, so a flask/beaker already accepts a pour from it. A
 * destination vessel's own `FILL` control is still where a chosen species/concentration actually
 * enters the simulation; this socket only establishes *that a pour connection is geometrically
 * valid*, the same way every other FLUID pairing in this module works.
 */
import { buildReagentBottleGeometry, reagentBottleGlassProfile, DEFAULT_REAGENT_BOTTLE_CONFIG } from '../geometry';
import { containerFromProfilePoints, profileBoundingDimensions } from '../container';
import { dimensionSource } from '../sources';
import { uprightSocketTransform } from '../transforms';
import type { ApparatusDefinition, Transform } from '../types';

const config = DEFAULT_REAGENT_BOTTLE_CONFIG;
const build = buildReagentBottleGeometry(config);
const profile = reagentBottleGlassProfile(config);
const container = containerFromProfilePoints(profile);
const bounds = profileBoundingDimensions(profile);
const neckTopTransform: Transform = { positionM: [0, config.totalHeightM, 0], quaternion: [0, 0, 0, 1] };

export const REAGENT_BOTTLE_250ML: ApparatusDefinition = {
  id: 'reagent-bottle-250ml',
  kind: 'BOTTLE',
  category: 'storage',
  label: '250 mL Reagent Bottle',
  shortLabel: 'Bottle',
  description: 'A round-shouldered screw-cap bottle used to label, stage and pour a reagent (e.g. a titrant or aliquot stock) at a station.',
  version: 1,
  dimensionsM: { width: bounds.widthM, depth: bounds.widthM, height: config.totalHeightM + config.capHeightM },
  massKg: 0.19,
  collision: { kind: 'cylinder', radiusM: bounds.widthM / 2, heightM: config.totalHeightM + config.capHeightM, centerM: [0, (config.totalHeightM + config.capHeightM) / 2, 0] },
  capabilities: ['CONTAINER', 'FLOW_SOURCE'],
  sockets: [
    {
      id: 'base',
      label: 'Base (rests on a surface)',
      kind: 'MECHANICAL',
      role: 'flat-bottom',
      accepts: ['flat-surface'],
      gender: 'NEUTRAL',
      // 'coincident': a single reference point on the bottle; the surface side (the bench top) is
      // the side declaring 'planar' + an area.
      mate: 'coincident',
      transform: uprightSocketTransform([0, 0, 0]),
      geometryCheck: { kind: 'none' },
      nominalFootprintM: { width: bounds.widthM, depth: bounds.widthM },
      maxConnections: 1,
      highlightRadiusM: bounds.widthM / 2,
    },
    {
      id: 'neck-outlet',
      label: 'Neck (pours out, once uncapped)',
      kind: 'FLUID',
      role: 'liquid-outlet-pour',
      accepts: ['liquid-inlet-open'],
      gender: 'NEUTRAL',
      mate: 'proximity',
      transform: neckTopTransform,
      geometryCheck: { kind: 'none' },
      maxConnections: 1,
      highlightRadiusM: config.neckRadiusM * 1.5,
    },
  ],
  flowPorts: [{ id: 'neck', label: 'Neck', direction: 'OUTLET', transform: neckTopTransform, maxFlowRateLPerS: 0.003 }],
  controls: [
    {
      id: 'fill',
      label: 'Charge contents',
      kind: 'FILL',
      actionType: 'FILL',
      description: 'Sets up an initial charge of the chosen species before a run starts.',
      valueType: 'number',
      range: { min: 0, max: container.capacityL, step: 0.0005, unit: 'L', default: 0 },
      requiresCapability: 'CONTAINER',
    },
    {
      id: 'pour',
      label: 'Pour',
      kind: 'CUSTOM',
      actionType: 'CUSTOM',
      description: 'Tips the bottle to pour into whatever vessel its neck is positioned over. Agent 07 resolves the actual transfer.',
      valueType: 'boolean',
      requiresCapability: 'FLOW_SOURCE',
    },
  ],
  container,
  defaultConfig: { speciesLabel: '', glassTint: 'clear' },
  configSchema: [
    {
      key: 'speciesLabel',
      label: 'Contents label',
      type: 'string',
      default: '',
      description: 'Free-text note for the inspector and palette (e.g. "0.100 mol/L NaOH"). Display only — not read by the simulation.',
    },
    {
      key: 'glassTint',
      label: 'Glass tint',
      type: 'enum',
      default: 'clear',
      options: [
        { value: 'clear', label: 'Clear' },
        { value: 'amber', label: 'Amber (light-sensitive reagents)' },
      ],
      description: 'Cosmetic only.',
    },
  ],
  placement: { allowedSurfaceRoles: ['flat-surface'], allowRotationAboutUpAxis: true, snapRotationDeg: 0 },
  asset: {
    source: 'procedural',
    proceduralBuilderId: 'reagent-bottle-250ml',
    polyCount: build.polyCount,
    materialSlots: ['glass', 'cap-plastic'],
    textureMemoryKB: 192,
    license: 'Procedural geometry authored for MATTER LAB; no external assets or textures used.',
    isPlaceholder: false,
  },
  thumbnail: { icon: 'Container', previewColor: '#c9a876' },
  focusPointM: [0, config.totalHeightM * 0.5, 0],
  tags: ['bottle', 'storage', 'reagent'],
  provenance: {
    dimensions: 'ILLUSTRATIVE',
    notes:
      'No specific catalog figure was confidently verified for this round-shouldered screw-cap style. Proportions are a generic reagent-bottle ' +
      `silhouette, loosely informed by (not a reproduction of) narrow-neck reagent bottle catalog figures: ${dimensionSource('reagent-bottle-catalog').detail} ` +
      'Simulated capacity is set to the nominal rated 250 mL.',
    sourceIds: [dimensionSource('reagent-bottle-catalog').id],
  },
};
