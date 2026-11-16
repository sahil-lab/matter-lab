/** Procedural geometry for the workbench (BENCH): a tabletop plus four legs. A development
 * placeholder — see `asset.isPlaceholder` on the definition. */
import { at, boxGroup } from './hardware';
import { combineBuildResults, type GeometryBuildResult } from './types';

export interface WorkbenchGeometryConfig {
  readonly widthM: number;
  readonly depthM: number;
  readonly heightM: number;
  readonly topThicknessM: number;
}

export const DEFAULT_WORKBENCH_CONFIG: WorkbenchGeometryConfig = {
  widthM: 1.2,
  depthM: 0.6,
  heightM: 0.9,
  topThicknessM: 0.04,
};

export function buildWorkbenchGeometry(config: WorkbenchGeometryConfig = DEFAULT_WORKBENCH_CONFIG): GeometryBuildResult {
  const { widthM, depthM, heightM, topThicknessM } = config;
  const legInsetM = 0.05;
  const legThicknessM = 0.06;
  const legHeightM = heightM - topThicknessM;
  const legX = widthM / 2 - legInsetM - legThicknessM / 2;
  const legZ = depthM / 2 - legInsetM - legThicknessM / 2;

  return combineBuildResults([
    boxGroup('bench-top', widthM, topThicknessM, depthM, at(0, heightM - topThicknessM / 2, 0)),
    boxGroup('bench-leg', legThicknessM, legHeightM, legThicknessM, at(legX, legHeightM / 2, legZ)),
    boxGroup('bench-leg', legThicknessM, legHeightM, legThicknessM, at(-legX, legHeightM / 2, legZ)),
    boxGroup('bench-leg', legThicknessM, legHeightM, legThicknessM, at(legX, legHeightM / 2, -legZ)),
    boxGroup('bench-leg', legThicknessM, legHeightM, legThicknessM, at(-legX, legHeightM / 2, -legZ)),
  ]);
}
