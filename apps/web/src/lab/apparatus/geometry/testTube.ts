/** Procedural geometry for a test tube (TEST_TUBE): a thin cylinder with a rounded bottom.
 * Diameter/length follow the common 16 x 100 mm catalog size (see `sources.ts`); the radius is
 * then calibrated so the modeled tube holds exactly `capacityL` of liquid (the thin-shell profile
 * used here does not model glass wall thickness, so the nominal 16 mm is the outer silhouette, not
 * the liquid-bearing bore — see `capacityScaleFactor` in `../container`). */
import { capacityScaleFactor } from '../container';
import { roundedBottomCylinderProfile, buildRevolutionMesh } from './profiles';
import { combineBuildResults, type GeometryBuildResult } from './types';

export interface TestTubeGeometryConfig {
  readonly radiusM: number;
  readonly heightM: number;
  /** Simulated liquid capacity, in liters. */
  readonly capacityL: number;
}

export const DEFAULT_TEST_TUBE_CONFIG: TestTubeGeometryConfig = { radiusM: 0.0075, heightM: 0.1, capacityL: 0.013 };

export function testTubeGlassProfile(config: TestTubeGeometryConfig = DEFAULT_TEST_TUBE_CONFIG) {
  const raw = roundedBottomCylinderProfile(config.radiusM, config.heightM, 8);
  const factor = capacityScaleFactor(raw, config.capacityL);
  return raw.map((p) => ({ ...p, r: p.r * factor }));
}

export function buildTestTubeGeometry(config: TestTubeGeometryConfig = DEFAULT_TEST_TUBE_CONFIG): GeometryBuildResult {
  const mesh = buildRevolutionMesh(testTubeGlassProfile(config), 20);
  return combineBuildResults([{ materialSlot: 'glass', geometry: mesh.geometry }]);
}
