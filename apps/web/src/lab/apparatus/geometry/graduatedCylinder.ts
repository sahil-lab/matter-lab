/** Procedural geometry for a graduated cylinder (GRADUATED_CYLINDER): a tall, narrow cylinder with
 * a small pour spout lip. Radii are calibrated so it holds exactly `capacityL` (see
 * `capacityScaleFactor` in `../container`), the same pattern every other vessel in this module uses. */
import { capacityScaleFactor } from '../container';
import { cylinderProfile, buildRevolutionMesh } from './profiles';
import { combineBuildResults, type GeometryBuildResult } from './types';

export interface GraduatedCylinderGeometryConfig {
  readonly radiusM: number;
  readonly heightM: number;
  /** Simulated liquid capacity, in liters. The cylinder's nominal rated volume. */
  readonly capacityL: number;
}

export const DEFAULT_GRADUATED_CYLINDER_CONFIG: GraduatedCylinderGeometryConfig = { radiusM: 0.016, heightM: 0.2, capacityL: 0.1 };

function rawGraduatedCylinderProfile(config: GraduatedCylinderGeometryConfig) {
  const profile = cylinderProfile(config.radiusM, config.heightM);
  // A small pour spout lip at the rim, like the beaker's.
  profile[profile.length - 1] = { r: config.radiusM * 1.08, y: config.heightM };
  return profile;
}

export function graduatedCylinderGlassProfile(config: GraduatedCylinderGeometryConfig = DEFAULT_GRADUATED_CYLINDER_CONFIG) {
  const raw = rawGraduatedCylinderProfile(config);
  const factor = capacityScaleFactor(raw, config.capacityL);
  return raw.map((p) => ({ ...p, r: p.r * factor }));
}

export function buildGraduatedCylinderGeometry(config: GraduatedCylinderGeometryConfig = DEFAULT_GRADUATED_CYLINDER_CONFIG): GeometryBuildResult {
  const mesh = buildRevolutionMesh(graduatedCylinderGlassProfile(config), 24);
  return combineBuildResults([{ materialSlot: 'glass', geometry: mesh.geometry }]);
}
