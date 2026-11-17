/** Procedural geometry for a lab jack (LAB_JACK): a base plate, a fixed-height platform, and a
 * pair of crossed struts standing in for a scissor-lift mechanism. The mechanism is not
 * functionally articulated — this is a static placeholder, not a height-adjustable prop (see
 * `definitions/labJack.ts`). */
import { at, boxGroup } from './hardware';
import { combineBuildResults, type GeometryBuildResult } from './types';
import type { Transform } from '../types';

export interface LabJackGeometryConfig {
  readonly baseWidthM: number;
  readonly baseDepthM: number;
  readonly baseThicknessM: number;
  readonly platformWidthM: number;
  readonly platformDepthM: number;
  readonly platformThicknessM: number;
  readonly heightM: number;
}

export const DEFAULT_LAB_JACK_CONFIG: LabJackGeometryConfig = {
  baseWidthM: 0.15,
  baseDepthM: 0.15,
  baseThicknessM: 0.015,
  platformWidthM: 0.13,
  platformDepthM: 0.13,
  platformThicknessM: 0.015,
  heightM: 0.12,
};

function strutTransform(heightM: number, yawDeg: number): Transform {
  const yawRad = (yawDeg * Math.PI) / 180;
  return { positionM: [0, heightM / 2, 0], quaternion: [0, Math.sin(yawRad / 2), 0, Math.cos(yawRad / 2)] };
}

export function buildLabJackGeometry(config: LabJackGeometryConfig = DEFAULT_LAB_JACK_CONFIG): GeometryBuildResult {
  const { baseWidthM, baseDepthM, baseThicknessM, platformWidthM, platformDepthM, platformThicknessM, heightM } = config;
  const strutSpanM = Math.min(baseWidthM, platformWidthM) * 0.85;
  const strutThicknessM = 0.012;

  return combineBuildResults([
    boxGroup('jack-metal', baseWidthM, baseThicknessM, baseDepthM, at(0, baseThicknessM / 2, 0)),
    boxGroup('jack-metal', strutSpanM, strutThicknessM, strutThicknessM, strutTransform(heightM, 45)),
    boxGroup('jack-metal', strutSpanM, strutThicknessM, strutThicknessM, strutTransform(heightM, -45)),
    boxGroup('jack-platform', platformWidthM, platformThicknessM, platformDepthM, at(0, heightM - platformThicknessM / 2, 0)),
  ]);
}
