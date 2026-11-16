/**
 * Workbench (BENCH): the shared horizontal surface everything else in the vertical slice is
 * ultimately placed on, directly or via another apparatus's own surface (e.g. a stirrer plate).
 *
 * This is the one definition in this file explicitly marked `asset.isPlaceholder: true` per the
 * brief's "procedural placeholder ... visibly marked as incomplete, not a shipping feature" —
 * a four-legged box table is a reasonable stand-in for the vertical slice, not a finished asset.
 */
import { buildWorkbenchGeometry, DEFAULT_WORKBENCH_CONFIG } from '../geometry';
import { dimensionSource } from '../sources';
import { uprightSocketTransform } from '../transforms';
import type { ApparatusDefinition } from '../types';

const config = DEFAULT_WORKBENCH_CONFIG;
const build = buildWorkbenchGeometry(config);

export const WORKBENCH_STANDARD: ApparatusDefinition = {
  id: 'workbench-standard',
  kind: 'BENCH',
  category: 'surface',
  label: 'Laboratory Workbench',
  shortLabel: 'Bench',
  description: 'A standing-height workbench. Every station starts with one; other apparatus rests on its top surface.',
  version: 1,
  dimensionsM: { width: config.widthM, depth: config.depthM, height: config.heightM },
  massKg: 28,
  collision: { kind: 'box', halfExtentsM: [config.widthM / 2, config.heightM / 2, config.depthM / 2], centerM: [0, config.heightM / 2, 0] },
  capabilities: ['MOUNT'],
  sockets: [
    {
      id: 'top-surface',
      label: 'Bench top',
      kind: 'MECHANICAL',
      role: 'flat-surface',
      accepts: ['flat-bottom'],
      gender: 'NEUTRAL',
      mate: 'planar',
      // Local +Z is rotated onto the bench's own +Y ("up, away from the tabletop") so a 'planar'
      // mate's XY-plane offset lands items flat on the tabletop instead of on an unrotated face.
      transform: uprightSocketTransform([0, config.heightM, 0]),
      planarAreaM: { width: config.widthM * 0.92, depth: config.depthM * 0.92 },
      geometryCheck: { kind: 'footprint-fit', maxWidthM: config.widthM * 0.92, maxDepthM: config.depthM * 0.92 },
      maxConnections: 24,
      highlightRadiusM: 0.18,
    },
  ],
  controls: [],
  defaultConfig: {},
  configSchema: [],
  placement: { allowedSurfaceRoles: [], allowRotationAboutUpAxis: true, snapRotationDeg: 15 },
  asset: {
    source: 'procedural',
    proceduralBuilderId: 'workbench-standard',
    polyCount: build.polyCount,
    materialSlots: ['bench-top', 'bench-leg'],
    textureMemoryKB: 512,
    license: 'Procedural geometry authored for MATTER LAB; no external assets or textures used.',
    isPlaceholder: true,
    notes: 'A plain four-legged box table. Intended as the vertical-slice stand-in, not a finished asset — see module README.',
  },
  thumbnail: { icon: 'Table2', previewColor: '#b08a5a' },
  focusPointM: [0, config.heightM, 0],
  tags: ['bench', 'surface', 'furniture'],
  provenance: {
    dimensions: 'REFERENCE_MEASURED',
    notes: 'Standing-height work surface; height follows common laboratory bench planning guidance.',
    sourceIds: [dimensionSource('lab-bench-height-catalog').id],
  },
};
