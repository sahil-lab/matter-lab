/** Procedural geometry for the reagent bottle (BOTTLE): a round-shouldered glass body with a screw
 * cap. No specific ISO figure was found for this screw-cap style (ISO 4796 covers ground-joint
 * narrow-neck bottles, a different common style — see `sources.ts`), so the silhouette is a
 * generic proportion reference, not a cited reproduction; radii are calibrated so the modeled
 * bottle holds exactly `capacityL`. */
import { capacityScaleFactor } from '../container';
import { at, cylinderGroup } from './hardware';
import { buildRevolutionMesh, roundShoulderBottleProfile } from './profiles';
import { combineBuildResults, type GeometryBuildResult } from './types';

export interface ReagentBottleGeometryConfig {
  readonly bodyRadiusM: number;
  readonly neckRadiusM: number;
  readonly totalHeightM: number;
  readonly neckHeightM: number;
  readonly shoulderHeightM: number;
  readonly capHeightM: number;
  /** Simulated liquid capacity, in liters. */
  readonly capacityL: number;
}

export const DEFAULT_REAGENT_BOTTLE_CONFIG: ReagentBottleGeometryConfig = {
  bodyRadiusM: 0.038,
  neckRadiusM: 0.013,
  totalHeightM: 0.16,
  neckHeightM: 0.02,
  shoulderHeightM: 0.025,
  capHeightM: 0.018,
  capacityL: 0.25,
};

function calibrate(config: ReagentBottleGeometryConfig) {
  const points = roundShoulderBottleProfile(config);
  return { points, factor: capacityScaleFactor(points, config.capacityL) };
}

export function reagentBottleGlassProfile(config: ReagentBottleGeometryConfig = DEFAULT_REAGENT_BOTTLE_CONFIG) {
  const { points, factor } = calibrate(config);
  return points.map((p) => ({ ...p, r: p.r * factor }));
}

export function buildReagentBottleGeometry(config: ReagentBottleGeometryConfig = DEFAULT_REAGENT_BOTTLE_CONFIG): GeometryBuildResult {
  const { factor } = calibrate(config);
  const mesh = buildRevolutionMesh(reagentBottleGlassProfile(config), 28);
  // The cap is sized off the neck radius, so it must scale with the same factor as the glass or it
  // would stop fitting a neck that was calibrated to a different capacity.
  const scaledNeckRadius = config.neckRadiusM * factor;
  return combineBuildResults([
    { materialSlot: 'glass', geometry: mesh.geometry },
    cylinderGroup('cap-plastic', scaledNeckRadius * 1.35, scaledNeckRadius * 1.35, config.capHeightM, at(0, config.totalHeightM + config.capHeightM / 2 - 0.004, 0), 20),
  ]);
}
