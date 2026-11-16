/**
 * Conical (Erlenmeyer) flask (FLASK): the receiving vessel for the aliquot being titrated in the
 * shared vertical slice. A `CONTAINER` + `FLOW_RECEIVER` that never computes its own contents or
 * pH — Agent 07 owns that; this module only describes capacity, the mouth it can be filled
 * through, and where a pH probe may dip in.
 */
import { buildConicalFlaskGeometry, conicalFlaskGlassProfile, DEFAULT_CONICAL_FLASK_CONFIG } from '../geometry';
import { containerFromProfilePoints, profileBoundingDimensions } from '../container';
import { dimensionSource } from '../sources';
import { uprightSocketTransform } from '../transforms';
import type { ApparatusDefinition, Transform } from '../types';

const config = DEFAULT_CONICAL_FLASK_CONFIG;
const build = buildConicalFlaskGeometry(config);
const profile = conicalFlaskGlassProfile(config);
const container = containerFromProfilePoints(profile);
const bounds = profileBoundingDimensions(profile);
const mouthTransform: Transform = { positionM: [0, config.totalHeightM, 0], quaternion: [0, 0, 0, 1] };

export const CONICAL_FLASK_250ML: ApparatusDefinition = {
  id: 'conical-flask-250ml',
  kind: 'FLASK',
  category: 'glassware',
  label: '250 mL Conical Flask',
  shortLabel: 'Flask',
  description: 'A narrow-neck Erlenmeyer flask. Holds the titration aliquot; its wide base and narrow neck make it easy to swirl without spilling.',
  version: 1,
  dimensionsM: { width: bounds.widthM, depth: bounds.widthM, height: config.totalHeightM },
  massKg: 0.14,
  collision: { kind: 'cylinder', radiusM: bounds.widthM / 2, heightM: config.totalHeightM, centerM: [0, config.totalHeightM / 2, 0] },
  capabilities: ['CONTAINER', 'FLOW_RECEIVER'],
  sockets: [
    {
      id: 'base',
      label: 'Base (rests on a surface)',
      kind: 'MECHANICAL',
      role: 'flat-bottom',
      accepts: ['flat-surface'],
      gender: 'NEUTRAL',
      // 'coincident': a single reference point on the flask; the surface side it mates with (the
      // bench top or a stirrer plate) is the side declaring 'planar' + an area.
      mate: 'coincident',
      transform: uprightSocketTransform([0, 0, 0]),
      geometryCheck: { kind: 'none' },
      nominalFootprintM: { width: bounds.widthM, depth: bounds.widthM },
      maxConnections: 1,
      highlightRadiusM: bounds.widthM / 2,
    },
    {
      id: 'mouth-inlet',
      label: 'Mouth (receives liquid)',
      kind: 'FLUID',
      role: 'liquid-inlet-open',
      accepts: ['liquid-outlet-valved', 'liquid-outlet-pour'],
      gender: 'NEUTRAL',
      mate: 'proximity',
      transform: mouthTransform,
      geometryCheck: { kind: 'none' },
      maxConnections: 1,
      highlightRadiusM: 0.025,
    },
    {
      id: 'sensor-access',
      label: 'Mouth (accepts a dipped sensor)',
      kind: 'SENSOR',
      role: 'sensor-access',
      accepts: ['sensor-probe'],
      gender: 'NEUTRAL',
      mate: 'proximity',
      transform: mouthTransform,
      geometryCheck: { kind: 'none' },
      maxConnections: 2,
      highlightRadiusM: 0.025,
    },
  ],
  flowPorts: [{ id: 'mouth', label: 'Mouth', direction: 'INLET', transform: mouthTransform }],
  controls: [
    {
      id: 'fill',
      label: 'Charge aliquot',
      kind: 'FILL',
      actionType: 'FILL',
      description: 'Sets up the initial charge (e.g. a 25.00 mL aliquot) before a run starts. Mid-run contents changes come from TRANSFER events, not this control.',
      valueType: 'number',
      range: { min: 0, max: container.capacityL, step: 0.0005, unit: 'L', default: 0 },
      requiresCapability: 'CONTAINER',
    },
  ],
  container,
  defaultConfig: { contentsLabel: '' },
  configSchema: [
    {
      key: 'contentsLabel',
      label: 'Contents label',
      type: 'string',
      default: '',
      description: 'Free-text note for the inspector (e.g. "0.100 mol/L HCl aliquot"). Display only.',
    },
  ],
  placement: { allowedSurfaceRoles: ['flat-surface'], allowRotationAboutUpAxis: true, snapRotationDeg: 0 },
  asset: {
    source: 'procedural',
    proceduralBuilderId: 'conical-flask-250ml',
    polyCount: build.polyCount,
    materialSlots: ['glass'],
    textureMemoryKB: 192,
    license: 'Procedural geometry authored for MATTER LAB; no external assets or textures used.',
    isPlaceholder: false,
  },
  thumbnail: { icon: 'FlaskConical', previewColor: '#cdeaf0' },
  focusPointM: [0, config.totalHeightM * 0.5, 0],
  tags: ['flask', 'glassware', 'erlenmeyer', 'titration'],
  provenance: {
    dimensions: 'REFERENCE_MEASURED',
    notes:
      `${dimensionSource('iso-1773-erlenmeyer-250ml').detail} Simulated capacity is set to the nominal rated 250 mL. A real flask's true ` +
      'brim-full volume is somewhat larger than its rating (Erlenmeyer flasks are deliberately given generous headspace for swirling); this ' +
      'model treats the rated volume as the simulated ceiling rather than reproducing that extra headspace.',
    sourceIds: [dimensionSource('iso-1773-erlenmeyer-250ml').id],
  },
};
