/** Procedural geometry for the magnetic stirrer (STIRRER): a flat hotplate body and a speed knob. */
import { at, boxGroup, cylinderGroup } from './hardware';
import { combineBuildResults, type GeometryBuildResult } from './types';

export interface MagneticStirrerGeometryConfig {
  readonly widthM: number;
  readonly depthM: number;
  readonly heightM: number;
  readonly plateRadiusM: number;
  readonly knobRadiusM: number;
}

export const DEFAULT_MAGNETIC_STIRRER_CONFIG: MagneticStirrerGeometryConfig = {
  widthM: 0.16,
  depthM: 0.16,
  heightM: 0.055,
  plateRadiusM: 0.07,
  knobRadiusM: 0.012,
};

export function buildMagneticStirrerGeometry(config: MagneticStirrerGeometryConfig = DEFAULT_MAGNETIC_STIRRER_CONFIG): GeometryBuildResult {
  const { widthM, depthM, heightM, plateRadiusM, knobRadiusM } = config;
  return combineBuildResults([
    boxGroup('stirrer-body', widthM, heightM, depthM, at(0, heightM / 2, 0)),
    cylinderGroup('stirrer-plate', plateRadiusM, plateRadiusM, heightM * 0.2, at(0, heightM + heightM * 0.1, 0), 32),
    // Speed knob; its rotation (driven by the R3F component from the stirrer-speed control value) gives a quick visual read of the setting.
    cylinderGroup('stirrer-knob', knobRadiusM, knobRadiusM, heightM * 0.5, at(widthM / 2 - knobRadiusM * 1.6, heightM / 2, depthM / 2 - knobRadiusM * 1.6), 16),
  ]);
}
