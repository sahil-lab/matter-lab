/**
 * Volumetric pipette (PIPETTE): a calibrated transfer instrument for manual, free-play transfers.
 * Drawing liquid up into the bulb is represented abstractly via its `fill` control (see
 * `provenance`/README "known gaps"); only dispensing out the tip is modeled as a `FLUID` socket.
 */
import { buildPipetteGeometry, pipetteGlassProfile, DEFAULT_PIPETTE_CONFIG } from '../geometry';
import { containerFromProfilePoints, profileBoundingDimensions } from '../container';
import { dimensionSource } from '../sources';
import { IDENTITY_TRANSFORM } from '../transforms';
import type { ApparatusDefinition } from '../types';

const config = DEFAULT_PIPETTE_CONFIG;
const build = buildPipetteGeometry(config);
const profile = pipetteGlassProfile(config);
const container = containerFromProfilePoints(profile);
const bounds = profileBoundingDimensions(profile);

export const PIPETTE_25ML_VOLUMETRIC: ApparatusDefinition = {
  id: 'pipette-25ml-volumetric',
  kind: 'PIPETTE',
  category: 'glassware',
  label: '25 mL Volumetric Pipette',
  shortLabel: 'Pipette',
  description: 'A single-mark volumetric (transfer) pipette. Delivers one exact, calibrated volume — used to measure out an aliquot by hand.',
  version: 1,
  dimensionsM: { width: bounds.widthM, depth: bounds.widthM, height: config.totalHeightM },
  massKg: 0.03,
  collision: { kind: 'cylinder', radiusM: bounds.widthM / 2, heightM: config.totalHeightM, centerM: [0, config.totalHeightM / 2, 0] },
  capabilities: ['CONTAINER', 'FLOW_SOURCE'],
  sockets: [
    {
      id: 'tip-outlet',
      label: 'Delivery tip',
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
  flowPorts: [{ id: 'tip', label: 'Delivery tip', direction: 'OUTLET', transform: IDENTITY_TRANSFORM, maxFlowRateLPerS: 0.005 }],
  controls: [
    {
      id: 'fill',
      label: 'Draw up',
      kind: 'FILL',
      actionType: 'FILL',
      description: 'Draws up the chosen species to the given volume (normally the full calibrated 25.00 mL), ready to dispense.',
      valueType: 'number',
      range: { min: 0, max: container.capacityL, step: 0.0005, unit: 'L', default: 0 },
      requiresCapability: 'CONTAINER',
    },
    {
      id: 'release',
      label: 'Release',
      kind: 'CUSTOM',
      actionType: 'CUSTOM',
      description: 'Squeezes the bulb to release the held volume into whatever vessel the tip is positioned over. Agent 07 resolves the actual transfer.',
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
    proceduralBuilderId: 'pipette-25ml-volumetric',
    polyCount: build.polyCount,
    materialSlots: ['glass'],
    textureMemoryKB: 96,
    license: 'Procedural geometry authored for MATTER LAB; no external assets or textures used.',
    isPlaceholder: true,
    notes: 'Models the glass tube only; no pipette bulb/filler or safety pipette-filler bulb is modeled as a separate attached part.',
  },
  thumbnail: { icon: 'Pipette', previewColor: '#cdeaf0' },
  focusPointM: [0, config.totalHeightM - config.bulbCenterFromTopM, 0],
  tags: ['pipette', 'glassware', 'precision'],
  provenance: {
    dimensions: 'REFERENCE_MEASURED',
    notes: dimensionSource('iso-835-volumetric-pipette-25ml').detail,
    sourceIds: [dimensionSource('iso-835-volumetric-pipette-25ml').id],
  },
};
