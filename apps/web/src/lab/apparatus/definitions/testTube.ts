/**
 * Test tube (TEST_TUBE): a small round-bottom tube, the common 16 x 100 mm catalog size.
 * Simplification: real round-bottom tubes need a rack or clamp to free-stand; this revision gives
 * it a nominal `flat-bottom` resting socket anyway rather than modeling a rack — see module README.
 */
import { buildTestTubeGeometry, testTubeGlassProfile, DEFAULT_TEST_TUBE_CONFIG } from '../geometry';
import { containerFromProfilePoints, profileBoundingDimensions } from '../container';
import { dimensionSource } from '../sources';
import { uprightSocketTransform } from '../transforms';
import type { ApparatusDefinition, Transform } from '../types';

const config = DEFAULT_TEST_TUBE_CONFIG;
const build = buildTestTubeGeometry(config);
const profile = testTubeGlassProfile(config);
const container = containerFromProfilePoints(profile);
const bounds = profileBoundingDimensions(profile);
const mouthTransform: Transform = { positionM: [0, config.heightM, 0], quaternion: [0, 0, 0, 1] };

export const TEST_TUBE_16X100MM: ApparatusDefinition = {
  id: 'test-tube-16x100mm',
  kind: 'TEST_TUBE',
  category: 'glassware',
  label: 'Test Tube (16 x 100 mm)',
  shortLabel: 'Test Tube',
  description: 'A small round-bottom test tube. Used for quick qualitative tests (e.g. an indicator color check) rather than for precision volumes.',
  version: 1,
  dimensionsM: { width: bounds.widthM, depth: bounds.widthM, height: config.heightM },
  massKg: 0.012,
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
      // 'coincident': a single reference point on the tube; the surface side (the bench top) is
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
      label: 'Mouth (receives liquid)',
      kind: 'FLUID',
      role: 'liquid-inlet-open',
      accepts: ['liquid-outlet-valved', 'liquid-outlet-pour'],
      gender: 'NEUTRAL',
      mate: 'proximity',
      transform: mouthTransform,
      geometryCheck: { kind: 'none' },
      maxConnections: 1,
      highlightRadiusM: 0.012,
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
  defaultConfig: { contentsLabel: '' },
  configSchema: [
    { key: 'contentsLabel', label: 'Contents label', type: 'string', default: '', description: 'Free-text note for the inspector. Display only.' },
  ],
  placement: { allowedSurfaceRoles: ['flat-surface'], allowRotationAboutUpAxis: true, snapRotationDeg: 0 },
  asset: {
    source: 'procedural',
    proceduralBuilderId: 'test-tube-16x100mm',
    polyCount: build.polyCount,
    materialSlots: ['glass'],
    textureMemoryKB: 96,
    license: 'Procedural geometry authored for MATTER LAB; no external assets or textures used.',
    isPlaceholder: true,
    notes: 'Models the tube only; a test-tube rack or spring clamp (the normal way it is actually stood up) is not yet a separate definition.',
  },
  thumbnail: { icon: 'TestTube', previewColor: '#cdeaf0' },
  focusPointM: [0, config.heightM * 0.5, 0],
  tags: ['test-tube', 'glassware'],
  provenance: {
    dimensions: 'REFERENCE_MEASURED',
    notes:
      `${dimensionSource('test-tube-16x100-catalog').detail} The thin-shell profile used here does not model glass wall thickness, so the ` +
      'radius is calibrated to the capacity rather than the literal 16 mm outer diameter (see `capacityScaleFactor` in `container.ts`).',
    sourceIds: [dimensionSource('test-tube-16x100-catalog').id],
  },
};
