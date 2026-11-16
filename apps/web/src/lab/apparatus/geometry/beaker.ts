/** Procedural geometry for a low-form beaker (BEAKER). Silhouette follows ISO 3819 250 mL catalog
 * figures (see `sources.ts`); radii are calibrated so the modeled vessel holds exactly `capacityL`
 * (beakers are non-volumetric glassware, so this is the simulated working capacity, not a
 * manufacturing tolerance claim — see `capacityScaleFactor` in `../container`). */
import { capacityScaleFactor } from '../container';
import { cylinderProfile, buildRevolutionMesh } from './profiles';
import { combineBuildResults, type GeometryBuildResult } from './types';

export interface BeakerGeometryConfig {
  readonly radiusM: number;
  readonly heightM: number;
  /** Simulated liquid capacity, in liters. The beaker's nominal rated volume. */
  readonly capacityL: number;
}

export const DEFAULT_BEAKER_CONFIG: BeakerGeometryConfig = { radiusM: 0.035, heightM: 0.095, capacityL: 0.25 };

function rawBeakerProfile(config: BeakerGeometryConfig) {
  const profile = cylinderProfile(config.radiusM, config.heightM);
  // A small flared lip at the rim and a slightly wider foot, rather than a perfectly straight cylinder.
  profile[profile.length - 1] = { r: config.radiusM * 1.05, y: config.heightM };
  return profile;
}

export function beakerGlassProfile(config: BeakerGeometryConfig = DEFAULT_BEAKER_CONFIG) {
  const raw = rawBeakerProfile(config);
  const factor = capacityScaleFactor(raw, config.capacityL);
  return raw.map((p) => ({ ...p, r: p.r * factor }));
}

export function buildBeakerGeometry(config: BeakerGeometryConfig = DEFAULT_BEAKER_CONFIG): GeometryBuildResult {
  const mesh = buildRevolutionMesh(beakerGlassProfile(config), 28);
  return combineBuildResults([{ materialSlot: 'glass', geometry: mesh.geometry }]);
}
