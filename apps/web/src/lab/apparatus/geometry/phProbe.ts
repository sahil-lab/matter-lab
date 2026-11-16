/** Procedural geometry for the pH probe (PH_PROBE): a slim shaft with a sensing bulb tip. */
import { at, boxGroup, cylinderGroup, sphereGroup } from './hardware';
import { combineBuildResults, type GeometryBuildResult } from './types';

export interface PhProbeGeometryConfig {
  readonly shaftRadiusM: number;
  readonly shaftHeightM: number;
  readonly bulbRadiusM: number;
  readonly headSizeM: number;
}

export const DEFAULT_PH_PROBE_CONFIG: PhProbeGeometryConfig = {
  shaftRadiusM: 0.006,
  shaftHeightM: 0.16,
  bulbRadiusM: 0.0065,
  headSizeM: 0.03,
};

export function buildPhProbeGeometry(config: PhProbeGeometryConfig = DEFAULT_PH_PROBE_CONFIG): GeometryBuildResult {
  const { shaftRadiusM, shaftHeightM, bulbRadiusM, headSizeM } = config;
  const bulbCenterY = -bulbRadiusM * 0.3;
  return combineBuildResults([
    sphereGroup('probe-bulb', bulbRadiusM, at(0, bulbCenterY, 0), 16, 12),
    cylinderGroup('probe-shaft', shaftRadiusM, shaftRadiusM, shaftHeightM, at(0, shaftHeightM / 2, 0), 16),
    boxGroup('probe-head', headSizeM, headSizeM * 0.7, headSizeM, at(0, shaftHeightM + headSizeM * 0.35, 0)),
  ]);
}
