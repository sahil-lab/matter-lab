/**
 * Reagent bottle (BOTTLE): a mobile container that identifies what reagent is available at a
 * station (e.g. "0.100 mol/L NaOH titrant"). It deliberately has no fluid socket or pour
 * connection of its own in this revision — see `provenance.notes` and the module README's
 * "known gaps" section. A destination vessel's own `FILL` control is where a chosen species and
 * concentration actually enter the simulation; this definition is a labeled, inspectable prop.
 */
import { buildReagentBottleGeometry, reagentBottleGlassProfile, DEFAULT_REAGENT_BOTTLE_CONFIG } from '../geometry';
import { containerFromProfilePoints, profileBoundingDimensions } from '../container';
import { dimensionSource } from '../sources';
import { uprightSocketTransform } from '../transforms';
import type { ApparatusDefinition } from '../types';

const config = DEFAULT_REAGENT_BOTTLE_CONFIG;
const build = buildReagentBottleGeometry(config);
const profile = reagentBottleGlassProfile(config);
const container = containerFromProfilePoints(profile);
const bounds = profileBoundingDimensions(profile);

export const REAGENT_BOTTLE_250ML: ApparatusDefinition = {
  id: 'reagent-bottle-250ml',
  kind: 'BOTTLE',
  category: 'storage',
  label: '250 mL Reagent Bottle',
  shortLabel: 'Bottle',
  description: 'A round-shouldered screw-cap bottle used to label and stage a reagent (e.g. a titrant or aliquot stock) at a station.',
  version: 1,
  dimensionsM: { width: bounds.widthM, depth: bounds.widthM, height: config.totalHeightM + config.capHeightM },
  massKg: 0.19,
  collision: { kind: 'cylinder', radiusM: bounds.widthM / 2, heightM: config.totalHeightM + config.capHeightM, centerM: [0, (config.totalHeightM + config.capHeightM) / 2, 0] },
  capabilities: ['CONTAINER'],
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
  ],
  controls: [],
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
