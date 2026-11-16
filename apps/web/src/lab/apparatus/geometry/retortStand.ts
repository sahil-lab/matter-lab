/** Procedural geometry for the retort (ring) stand (STAND): a flat base plate and a vertical rod. */
import { at, boxGroup, cylinderGroup } from './hardware';
import { combineBuildResults, type GeometryBuildResult } from './types';

export interface RetortStandGeometryConfig {
  readonly baseWidthM: number;
  readonly baseDepthM: number;
  readonly baseThicknessM: number;
  readonly rodRadiusM: number;
  readonly rodHeightM: number;
}

export const DEFAULT_RETORT_STAND_CONFIG: RetortStandGeometryConfig = {
  baseWidthM: 0.21,
  baseDepthM: 0.13,
  baseThicknessM: 0.012,
  rodRadiusM: 0.005,
  rodHeightM: 0.6,
};

export function buildRetortStandGeometry(config: RetortStandGeometryConfig = DEFAULT_RETORT_STAND_CONFIG): GeometryBuildResult {
  const { baseWidthM, baseDepthM, baseThicknessM, rodRadiusM, rodHeightM } = config;
  // The rod is offset toward one edge of the base, as on a real stand, so clamped glassware hangs clear of the base plate.
  const rodOffsetZ = baseDepthM / 2 - rodRadiusM * 2;

  return combineBuildResults([
    boxGroup('stand-metal', baseWidthM, baseThicknessM, baseDepthM, at(0, baseThicknessM / 2, 0)),
    cylinderGroup('stand-metal', rodRadiusM, rodRadiusM, rodHeightM, at(0, baseThicknessM + rodHeightM / 2, rodOffsetZ), 16),
  ]);
}
