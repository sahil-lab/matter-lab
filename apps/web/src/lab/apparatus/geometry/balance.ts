/** Procedural geometry for a digital balance (BALANCE): a flat body, a circular weighing pan, and
 * a small raised display panel. */
import { at, boxGroup, cylinderGroup } from './hardware';
import { combineBuildResults, type GeometryBuildResult } from './types';

export interface BalanceGeometryConfig {
  readonly bodyWidthM: number;
  readonly bodyDepthM: number;
  readonly bodyHeightM: number;
  readonly panRadiusM: number;
  readonly panHeightM: number;
  readonly displayWidthM: number;
  readonly displayHeightM: number;
}

export const DEFAULT_BALANCE_CONFIG: BalanceGeometryConfig = {
  bodyWidthM: 0.22,
  bodyDepthM: 0.28,
  bodyHeightM: 0.06,
  panRadiusM: 0.07,
  panHeightM: 0.01,
  displayWidthM: 0.08,
  displayHeightM: 0.03,
};

export function buildBalanceGeometry(config: BalanceGeometryConfig = DEFAULT_BALANCE_CONFIG): GeometryBuildResult {
  const { bodyWidthM, bodyDepthM, bodyHeightM, panRadiusM, panHeightM, displayWidthM, displayHeightM } = config;
  const displayDepthM = 0.012;

  return combineBuildResults([
    boxGroup('balance-body', bodyWidthM, bodyHeightM, bodyDepthM, at(0, bodyHeightM / 2, 0)),
    cylinderGroup('balance-pan', panRadiusM, panRadiusM, panHeightM, at(0, bodyHeightM + panHeightM / 2, bodyDepthM * 0.05), 32),
    boxGroup('balance-display', displayWidthM, displayHeightM, displayDepthM, at(0, bodyHeightM + displayHeightM / 2, -bodyDepthM / 2 + displayDepthM / 2)),
  ]);
}
