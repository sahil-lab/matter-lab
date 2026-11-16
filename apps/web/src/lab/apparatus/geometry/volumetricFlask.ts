/** Procedural geometry for a volumetric flask (VOLUMETRIC_FLASK): a pear-shaped bulb with a long
 * calibrated neck. Overall height and bulb diameter follow ISO 1042 250 mL catalog figures (see
 * `sources.ts`); the radii are then calibrated so the single-mark capacity is exactly `capacityL`
 * — a volumetric flask's "250 mL" is the calibration mark partway up the neck, which this model
 * treats as coincident with the declared capacity (see `capacityScaleFactor` in `../container`). */
import { capacityScaleFactor } from '../container';
import { volumetricFlaskProfile, buildRevolutionMesh } from './profiles';
import { combineBuildResults, type GeometryBuildResult } from './types';

export interface VolumetricFlaskGeometryConfig {
  readonly bulbRadiusM: number;
  readonly bulbHeightM: number;
  readonly neckRadiusM: number;
  readonly neckHeightM: number;
  /** Simulated liquid capacity at the calibration mark, in liters. */
  readonly capacityL: number;
}

export const DEFAULT_VOLUMETRIC_FLASK_CONFIG: VolumetricFlaskGeometryConfig = {
  bulbRadiusM: 0.04,
  bulbHeightM: 0.095,
  neckRadiusM: 0.009,
  neckHeightM: 0.125,
  capacityL: 0.25,
};

export function volumetricFlaskGlassProfile(config: VolumetricFlaskGeometryConfig = DEFAULT_VOLUMETRIC_FLASK_CONFIG) {
  const raw = volumetricFlaskProfile(config);
  const factor = capacityScaleFactor(raw, config.capacityL);
  return raw.map((p) => ({ ...p, r: p.r * factor }));
}

export function buildVolumetricFlaskGeometry(config: VolumetricFlaskGeometryConfig = DEFAULT_VOLUMETRIC_FLASK_CONFIG): GeometryBuildResult {
  const mesh = buildRevolutionMesh(volumetricFlaskGlassProfile(config), 32);
  return combineBuildResults([{ materialSlot: 'glass', geometry: mesh.geometry }]);
}
