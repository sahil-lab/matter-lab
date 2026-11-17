/**
 * Graduated cylinder (GRADUATED_CYLINDER): a tall, narrow, precisely-graduated vessel for
 * measuring a volume more accurately than a beaker (though less precisely than volumetric
 * glassware). Unlike the burette, it reads bottom-up (`zeroAtTop: false`).
 */
import { buildGraduatedCylinderGeometry, graduatedCylinderGlassProfile, DEFAULT_GRADUATED_CYLINDER_CONFIG } from '../geometry';
import { containerFromProfilePoints, profileBoundingDimensions } from '../container';
import { dimensionSource } from '../sources';
import { uprightSocketTransform } from '../transforms';
import type { ApparatusDefinition, GraduationSpec, Transform } from '../types';

const config = DEFAULT_GRADUATED_CYLINDER_CONFIG;
const build = buildGraduatedCylinderGeometry(config);
const profile = graduatedCylinderGlassProfile(config);
const container = containerFromProfilePoints(profile);
const bounds = profileBoundingDimensions(profile);
const mouthTransform: Transform = { positionM: [0, config.heightM, 0], quaternion: [0, 0, 0, 1] };
const capacityML = Math.round(container.capacityL * 1000 * 100) / 100;

const graduation: GraduationSpec = {
  capacityML,
  majorIntervalML: 10,
  minorIntervalML: 1,
  labelEveryNMajor: 1,
  toleranceML: 1,
  zeroAtTop: false,
  evidence: 'REFERENCE_MEASURED',
};

export const GRADUATED_CYLINDER_100ML: ApparatusDefinition = {
  id: 'graduated-cylinder-100ml',
  kind: 'GRADUATED_CYLINDER',
  category: 'glassware',
  label: '100 mL Graduated Cylinder',
  shortLabel: 'Grad. Cyl.',
  description: 'A tall, narrow cylinder with fine graduations. More accurate than a beaker for measuring a volume, though not volumetric-grade.',
  version: 1,
  dimensionsM: { width: bounds.widthM, depth: bounds.widthM, height: config.heightM },
  massKg: 0.09,
  collision: { kind: 'cylinder', radiusM: bounds.widthM / 2, heightM: config.heightM, centerM: [0, config.heightM / 2, 0] },
  capabilities: ['CONTAINER', 'FLOW_RECEIVER'],
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
      highlightRadiusM: 0.016,
    },
  ],
  flowPorts: [{ id: 'mouth', label: 'Mouth', direction: 'INLET', transform: mouthTransform }],
  controls: [
    {
      id: 'fill',
      label: 'Charge contents',
      kind: 'FILL',
      actionType: 'FILL',
      description: 'Sets up an initial charge before a run starts.',
      valueType: 'number',
      range: { min: 0, max: container.capacityL, step: 0.0005, unit: 'L', default: 0 },
      requiresCapability: 'CONTAINER',
    },
  ],
  container,
  graduation,
  defaultConfig: { contentsLabel: '' },
  configSchema: [
    { key: 'contentsLabel', label: 'Contents label', type: 'string', default: '', description: 'Free-text note for the inspector. Display only.' },
  ],
  placement: { allowedSurfaceRoles: ['flat-surface'], allowRotationAboutUpAxis: true, snapRotationDeg: 0 },
  asset: {
    source: 'procedural',
    proceduralBuilderId: 'graduated-cylinder-100ml',
    polyCount: build.polyCount,
    materialSlots: ['glass'],
    textureMemoryKB: 160,
    license: 'Procedural geometry authored for MATTER LAB; no external assets or textures used.',
    isPlaceholder: false,
  },
  thumbnail: { icon: 'Ruler', previewColor: '#cdeaf0' },
  focusPointM: [0, config.heightM * 0.5, 0],
  tags: ['graduated-cylinder', 'glassware', 'measurement'],
  provenance: {
    dimensions: 'REFERENCE_MEASURED',
    notes: `${dimensionSource('graduated-cylinder-100ml-catalog').detail} Simulated capacity is set to the nominal rated 100 mL.`,
    sourceIds: [dimensionSource('graduated-cylinder-100ml-catalog').id],
  },
};
