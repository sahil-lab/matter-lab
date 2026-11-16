/**
 * Volumetric flask (VOLUMETRIC_FLASK): a precision one-mark vessel used to prepare an exact
 * concentration (e.g. the 0.100 mol/L NaOH titrant), not to run the titration itself. Its single
 * neck graduation mark is modeled as coincident with the declared capacity — see `provenance.notes`.
 */
import { buildVolumetricFlaskGeometry, volumetricFlaskGlassProfile, DEFAULT_VOLUMETRIC_FLASK_CONFIG } from '../geometry';
import { containerFromProfilePoints, profileBoundingDimensions } from '../container';
import { dimensionSource } from '../sources';
import { uprightSocketTransform } from '../transforms';
import type { ApparatusDefinition, Transform } from '../types';

const config = DEFAULT_VOLUMETRIC_FLASK_CONFIG;
const build = buildVolumetricFlaskGeometry(config);
const profile = volumetricFlaskGlassProfile(config);
const container = containerFromProfilePoints(profile);
const bounds = profileBoundingDimensions(profile);
const totalHeightM = config.bulbHeightM + config.neckHeightM;
const mouthTransform: Transform = { positionM: [0, totalHeightM, 0], quaternion: [0, 0, 0, 1] };

export const VOLUMETRIC_FLASK_250ML: ApparatusDefinition = {
  id: 'volumetric-flask-250ml',
  kind: 'VOLUMETRIC_FLASK',
  category: 'glassware',
  label: '250 mL Volumetric Flask',
  shortLabel: 'Vol. Flask',
  description: 'A pear-shaped bulb with a long, narrow calibrated neck. Used to prepare a reagent at an exact concentration, filled precisely to the neck mark.',
  version: 1,
  dimensionsM: { width: bounds.widthM, depth: bounds.widthM, height: totalHeightM },
  massKg: 0.16,
  collision: { kind: 'cylinder', radiusM: bounds.widthM / 2, heightM: totalHeightM, centerM: [0, totalHeightM / 2, 0] },
  capabilities: ['CONTAINER', 'FLOW_RECEIVER'],
  sockets: [
    {
      id: 'base',
      label: 'Base (rests on a surface)',
      kind: 'MECHANICAL',
      role: 'flat-bottom',
      accepts: ['flat-surface'],
      gender: 'NEUTRAL',
      // 'coincident': a single reference point on the flask; the surface side (the bench top) is
      // the side declaring 'planar' + an area.
      mate: 'coincident',
      transform: uprightSocketTransform([0, 0, 0]),
      geometryCheck: { kind: 'none' },
      nominalFootprintM: { width: bounds.widthM, depth: bounds.widthM },
      maxConnections: 1,
      highlightRadiusM: bounds.widthM / 2,
    },
    {
      id: 'mouth-inlet',
      label: 'Neck (receives liquid)',
      kind: 'FLUID',
      role: 'liquid-inlet-open',
      accepts: ['liquid-outlet-valved', 'liquid-outlet-pour'],
      gender: 'NEUTRAL',
      mate: 'proximity',
      transform: mouthTransform,
      geometryCheck: { kind: 'none' },
      maxConnections: 1,
      highlightRadiusM: 0.02,
    },
  ],
  flowPorts: [{ id: 'neck', label: 'Neck', direction: 'INLET', transform: mouthTransform }],
  controls: [
    {
      id: 'fill',
      label: 'Fill to mark',
      kind: 'FILL',
      actionType: 'FILL',
      description: 'Fills with the chosen species up to the given volume. Normally used filled exactly to the calibrated capacity.',
      valueType: 'number',
      range: { min: 0, max: container.capacityL, step: 0.0005, unit: 'L', default: 0 },
      requiresCapability: 'CONTAINER',
    },
  ],
  container,
  defaultConfig: { contentsLabel: '' },
  configSchema: [
    { key: 'contentsLabel', label: 'Contents label', type: 'string', default: '', description: 'Free-text note for the inspector. Display only.' },
  ],
  placement: { allowedSurfaceRoles: ['flat-surface'], allowRotationAboutUpAxis: true, snapRotationDeg: 0 },
  asset: {
    source: 'procedural',
    proceduralBuilderId: 'volumetric-flask-250ml',
    polyCount: build.polyCount,
    materialSlots: ['glass'],
    textureMemoryKB: 160,
    license: 'Procedural geometry authored for MATTER LAB; no external assets or textures used.',
    isPlaceholder: true,
    notes: 'No separate etched ring mark or ground-glass stopper is modeled on the neck.',
  },
  thumbnail: { icon: 'GlassWater', previewColor: '#cdeaf0' },
  focusPointM: [0, config.bulbHeightM * 0.6, 0],
  tags: ['volumetric-flask', 'glassware', 'precision'],
  provenance: {
    dimensions: 'REFERENCE_MEASURED',
    notes:
      `${dimensionSource('iso-1042-volumetric-flask-250ml').detail} The neck graduation mark is modeled as coincident with the declared 250 mL ` +
      'capacity; the small additional headspace a real flask leaves between the mark and its stopper is not separately modeled.',
    sourceIds: [dimensionSource('iso-1042-volumetric-flask-250ml').id],
  },
};
