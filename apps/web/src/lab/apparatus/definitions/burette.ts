/**
 * Graduated burette with stopcock (BURETTE): the titrant delivery vessel at the center of the
 * shared vertical slice (shared contract §6). Capacity, graduation and the stopcock `VALVE`
 * control are the pieces Agent 07's reducer reads to meter a `TRANSFER`; this module only
 * describes them — it never computes a delivered volume or writes an instance's inventory itself.
 */
import { buildBuretteGeometry, buretteGlassProfile, calibratedBarrelDiameterM, DEFAULT_BURETTE_CONFIG } from '../geometry';
import { containerFromProfilePoints, profileBoundingDimensions } from '../container';
import { dimensionSource } from '../sources';
import { IDENTITY_TRANSFORM, uprightSocketTransform } from '../transforms';
import type { ApparatusDefinition, GraduationSpec } from '../types';

const config = DEFAULT_BURETTE_CONFIG;
const build = buildBuretteGeometry(config);
const profile = buretteGlassProfile(config);
const container = containerFromProfilePoints(profile);
const bounds = profileBoundingDimensions(profile);
const barrelDiameterM = calibratedBarrelDiameterM(config);
const capacityML = Math.round(container.capacityL * 1000 * 100) / 100;
// The jaw grips closer to the tip than to the funnel mouth: most of a real titration setup's
// clamp height budget goes to tip clearance above the receiving flask, with the funnel mouth
// (already elevated on a stand) still easily reachable for refilling from above.
const barrelSocketYM = config.tipHeightM + (config.totalHeightM - config.funnelHeightM - config.tipHeightM) * 0.25;

const graduation: GraduationSpec = {
  capacityML,
  majorIntervalML: 1,
  minorIntervalML: 0.1,
  labelEveryNMajor: 5,
  toleranceML: 0.05,
  zeroAtTop: true,
  evidence: 'REFERENCE_MEASURED',
};

export const BURETTE_50ML_CLASS_A: ApparatusDefinition = {
  id: 'burette-50ml-class-a',
  kind: 'BURETTE',
  category: 'fluid-control',
  label: '50 mL Burette (Class A)',
  shortLabel: 'Burette',
  description: 'A graduated burette with a glass-key stopcock. Delivers a precisely metered, variable-flow titrant.',
  version: 1,
  dimensionsM: { width: bounds.widthM, depth: bounds.widthM, height: config.totalHeightM },
  massKg: 0.22,
  collision: { kind: 'cylinder', radiusM: bounds.widthM / 2, heightM: config.totalHeightM, centerM: [0, config.totalHeightM / 2, 0] },
  capabilities: ['CONTAINER', 'FLOW_SOURCE'],
  sockets: [
    {
      id: 'barrel',
      label: 'Barrel (held by a clamp)',
      kind: 'MECHANICAL',
      role: 'burette-barrel',
      accepts: ['clamp-jaw'],
      gender: 'MALE',
      mate: 'coincident',
      transform: uprightSocketTransform([0, barrelSocketYM, 0]),
      geometryCheck: { kind: 'none' },
      nominalDiameterM: barrelDiameterM,
      maxConnections: 1,
      highlightRadiusM: 0.02,
    },
    {
      id: 'tip-outlet',
      label: 'Delivery tip',
      kind: 'FLUID',
      role: 'liquid-outlet-valved',
      accepts: ['liquid-inlet-open'],
      gender: 'NEUTRAL',
      mate: 'proximity',
      transform: IDENTITY_TRANSFORM,
      geometryCheck: { kind: 'none' },
      maxConnections: 1,
      highlightRadiusM: 0.015,
    },
  ],
  flowPorts: [{ id: 'tip', label: 'Delivery tip', direction: 'OUTLET', transform: IDENTITY_TRANSFORM, maxFlowRateLPerS: 0.002 }],
  controls: [
    {
      id: 'stopcock',
      label: 'Stopcock',
      kind: 'VALVE',
      actionType: 'SET_VALVE',
      description: 'Opens the glass-key stopcock from fully closed (0) to fully open (1), setting the titrant flow rate.',
      valueType: 'number',
      range: { min: 0, max: 1, step: 0.01, unit: 'open fraction', default: 0 },
      requiresCapability: 'FLOW_SOURCE',
    },
    {
      id: 'fill',
      label: 'Fill to volume',
      kind: 'FILL',
      actionType: 'FILL',
      description: 'Fills the barrel with the chosen titrant up to the given volume, measured from the tip.',
      valueType: 'number',
      range: { min: 0, max: container.capacityL, step: 0.0005, unit: 'L', default: 0 },
      requiresCapability: 'CONTAINER',
    },
  ],
  container,
  graduation,
  defaultConfig: { contentsLabel: '' },
  configSchema: [
    {
      key: 'contentsLabel',
      label: 'Contents label',
      type: 'string',
      default: '',
      description: 'Free-text note for the inspector (e.g. "0.100 mol/L NaOH"). Display only — the simulated species and concentration are set by the FILL action, not read from this field.',
    },
  ],
  placement: { allowedSurfaceRoles: ['clamp-jaw'], allowRotationAboutUpAxis: false },
  asset: {
    source: 'procedural',
    proceduralBuilderId: 'burette-50ml-class-a',
    polyCount: build.polyCount,
    materialSlots: ['glass', 'stopcock-body', 'stopcock-key'],
    textureMemoryKB: 256,
    license: 'Procedural geometry authored for MATTER LAB; no external assets or textures used.',
    isPlaceholder: false,
    notes: 'The stopcock key is a solid box, not a bored plug — it rotates to show valve state but has no modeled internal bore.',
  },
  thumbnail: { icon: 'TestTube2', previewColor: '#cfe8ea' },
  focusPointM: [0, config.tipHeightM * 0.65, 0],
  guidedHighlight: { anchorM: [0, config.tipHeightM * 0.65, 0], radiusM: 0.03 },
  tags: ['burette', 'glassware', 'fluid-control', 'titration'],
  provenance: {
    dimensions: 'REFERENCE_MEASURED',
    notes:
      `${dimensionSource('iso-385-burette-50ml').detail} The barrel radius here is calibrated so the modeled vessel holds exactly the rated ` +
      `50.00 mL (see \`capacityScaleFactor\` in \`container.ts\`), which lands the modeled bore at ${(barrelDiameterM * 1000).toFixed(1)} mm — ` +
      'narrower than the cited ~11 mm ISO figure, because this single-taper procedural profile is a simplified silhouette, not a literal cross-section.',
    sourceIds: [dimensionSource('iso-385-burette-50ml').id],
  },
};
