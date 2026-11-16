/** Procedural geometry for the conical (Erlenmeyer) flask (FLASK). Silhouette (base/neck diameter,
 * height) follows ISO 1773 narrow-neck 250 mL catalog figures (see `sources.ts`); the radii are
 * then calibrated so the modeled vessel holds exactly `capacityL` — real Erlenmeyer flasks curve
 * inward more than this straight-taper profile, so taking the cited radii literally would
 * integrate to noticeably more than the rated 250 mL (see `capacityScaleFactor` in `../container`). */
import { capacityScaleFactor } from '../container';
import { conicalFlaskProfile, buildRevolutionMesh } from './profiles';
import { combineBuildResults, type GeometryBuildResult } from './types';

export interface ConicalFlaskGeometryConfig {
  readonly baseRadiusM: number;
  readonly neckRadiusM: number;
  readonly totalHeightM: number;
  readonly neckHeightM: number;
  /** Simulated liquid capacity, in liters. The flask's nominal rated volume. */
  readonly capacityL: number;
}

export const DEFAULT_CONICAL_FLASK_CONFIG: ConicalFlaskGeometryConfig = {
  baseRadiusM: 0.0425,
  neckRadiusM: 0.017,
  totalHeightM: 0.145,
  neckHeightM: 0.035,
  capacityL: 0.25,
};

/** The profile actually used for the glass mesh and the `ContainerSpec`, scaled so its integrated
 * volume is exactly `config.capacityL`. */
export function conicalFlaskGlassProfile(config: ConicalFlaskGeometryConfig = DEFAULT_CONICAL_FLASK_CONFIG) {
  const raw = conicalFlaskProfile(config);
  const factor = capacityScaleFactor(raw, config.capacityL);
  return raw.map((p) => ({ ...p, r: p.r * factor }));
}

export function buildConicalFlaskGeometry(config: ConicalFlaskGeometryConfig = DEFAULT_CONICAL_FLASK_CONFIG): GeometryBuildResult {
  const mesh = buildRevolutionMesh(conicalFlaskGlassProfile(config), 32);
  return combineBuildResults([{ materialSlot: 'glass', geometry: mesh.geometry }]);
}
