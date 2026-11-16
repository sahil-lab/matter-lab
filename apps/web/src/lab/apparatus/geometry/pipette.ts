/** Procedural geometry for a volumetric pipette (PIPETTE): a thin calibrated tube with a bulge
 * reservoir. Overall length follows ISO 835/648 25 mL catalog figures (see `sources.ts`); the
 * radii are then calibrated so the pipette's calibrated delivery volume is exactly `capacityL`. */
import { capacityScaleFactor } from '../container';
import { buildRevolutionMesh } from './profiles';
import type { ProfilePoint } from './profiles';
import { combineBuildResults, type GeometryBuildResult } from './types';

export interface PipetteGeometryConfig {
  readonly tubeRadiusM: number;
  readonly totalHeightM: number;
  readonly bulbRadiusM: number;
  readonly bulbHeightM: number;
  readonly bulbCenterFromTopM: number;
  /** Simulated calibrated delivery volume, in liters. */
  readonly capacityL: number;
}

// A real 25 mL Class A/B volumetric pipette is ~520 mm overall (ISO 835/648 catalog figures,
// see `sources.ts`), not a tabletop-scale prop — it is long and thin enough that users dip one
// end into a reagent bottle while the other is well above the bench.
export const DEFAULT_PIPETTE_CONFIG: PipetteGeometryConfig = {
  tubeRadiusM: 0.003,
  totalHeightM: 0.52,
  bulbRadiusM: 0.014,
  bulbHeightM: 0.1,
  bulbCenterFromTopM: 0.225,
  capacityL: 0.025,
};

function rawPipetteProfile(config: PipetteGeometryConfig): ProfilePoint[] {
  const { tubeRadiusM, totalHeightM, bulbRadiusM, bulbHeightM, bulbCenterFromTopM } = config;
  const bulbCenterY = totalHeightM - bulbCenterFromTopM;
  const bulbTop = bulbCenterY + bulbHeightM / 2;
  const bulbBottom = bulbCenterY - bulbHeightM / 2;
  return [
    { r: 0, y: 0 },
    { r: tubeRadiusM, y: 0 },
    { r: tubeRadiusM, y: bulbBottom },
    { r: bulbRadiusM, y: bulbCenterY },
    { r: tubeRadiusM, y: bulbTop },
    { r: tubeRadiusM, y: totalHeightM },
  ];
}

export function pipetteGlassProfile(config: PipetteGeometryConfig = DEFAULT_PIPETTE_CONFIG): ProfilePoint[] {
  const raw = rawPipetteProfile(config);
  const factor = capacityScaleFactor(raw, config.capacityL);
  return raw.map((p) => ({ ...p, r: p.r * factor }));
}

export function buildPipetteGeometry(config: PipetteGeometryConfig = DEFAULT_PIPETTE_CONFIG): GeometryBuildResult {
  const mesh = buildRevolutionMesh(pipetteGlassProfile(config), 20);
  return combineBuildResults([{ materialSlot: 'glass', geometry: mesh.geometry }]);
}
