/** Procedural geometry for a dropper (DROPPER): a short glass tube with a fine tapered tip and a
 * squeeze bulb at the top. Much shorter than the volumetric pipette and used for small,
 * approximate transfers rather than a single calibrated volume. */
import { capacityScaleFactor } from '../container';
import { sphereGroup } from './hardware';
import { buildRevolutionMesh } from './profiles';
import type { ProfilePoint } from './profiles';
import { combineBuildResults, type GeometryBuildResult } from './types';

export interface DropperGeometryConfig {
  readonly tipRadiusM: number;
  readonly bodyRadiusM: number;
  readonly glassHeightM: number;
  readonly bulbRadiusM: number;
  /** Simulated liquid capacity held in the glass tube, in liters (the bulb itself holds air, not liquid). */
  readonly capacityL: number;
}

export const DEFAULT_DROPPER_CONFIG: DropperGeometryConfig = {
  tipRadiusM: 0.0006,
  bodyRadiusM: 0.0035,
  glassHeightM: 0.15,
  bulbRadiusM: 0.011,
  capacityL: 0.002,
};

function rawDropperProfile(config: DropperGeometryConfig): ProfilePoint[] {
  const { tipRadiusM, bodyRadiusM, glassHeightM } = config;
  return [
    { r: 0, y: 0 },
    { r: tipRadiusM, y: 0 },
    { r: tipRadiusM, y: glassHeightM * 0.15 },
    { r: bodyRadiusM, y: glassHeightM * 0.35 },
    { r: bodyRadiusM, y: glassHeightM },
  ];
}

export function dropperGlassProfile(config: DropperGeometryConfig = DEFAULT_DROPPER_CONFIG): ProfilePoint[] {
  const raw = rawDropperProfile(config);
  const factor = capacityScaleFactor(raw, config.capacityL);
  return raw.map((p) => ({ ...p, r: p.r * factor }));
}

export function buildDropperGeometry(config: DropperGeometryConfig = DEFAULT_DROPPER_CONFIG): GeometryBuildResult {
  const mesh = buildRevolutionMesh(dropperGlassProfile(config), 16);
  return combineBuildResults([
    { materialSlot: 'glass', geometry: mesh.geometry },
    sphereGroup('rubber-bulb', config.bulbRadiusM, { positionM: [0, config.glassHeightM + config.bulbRadiusM * 0.75, 0], quaternion: [0, 0, 0, 1] }, 16, 12),
  ]);
}
