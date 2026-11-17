/** Procedural geometry for a support (ring) clamp (SUPPORT_RING): a boss head gripping a stand's
 * rod, an arm, and a flat wire ring that other apparatus (a funnel, an evaporating dish) rests in.
 * Structurally the mirror image of the burette clamp — a ring instead of a jaw at the end of the arm. */
import { at, boxGroup, torusGroup } from './hardware';
import { combineBuildResults, type GeometryBuildResult } from './types';

export interface SupportRingGeometryConfig {
  readonly bossSizeM: number;
  readonly armLengthM: number;
  readonly armThicknessM: number;
  readonly ringRadiusM: number;
  readonly tubeRadiusM: number;
}

export const DEFAULT_SUPPORT_RING_CONFIG: SupportRingGeometryConfig = {
  bossSizeM: 0.045,
  armLengthM: 0.1,
  armThicknessM: 0.016,
  ringRadiusM: 0.045,
  tubeRadiusM: 0.004,
};

export function buildSupportRingGeometry(config: SupportRingGeometryConfig = DEFAULT_SUPPORT_RING_CONFIG): GeometryBuildResult {
  const { bossSizeM, armLengthM, armThicknessM, ringRadiusM, tubeRadiusM } = config;
  const ringCenterX = armLengthM + ringRadiusM;

  return combineBuildResults([
    // Boss head: grips the stand's vertical rod.
    boxGroup('ring-metal', bossSizeM, bossSizeM, bossSizeM, at(0, 0, 0)),
    // Arm reaching out from the boss to the ring's edge.
    boxGroup('ring-metal', armLengthM, armThicknessM, armThicknessM, at(armLengthM / 2, 0, 0)),
    // The ring itself, centered past the end of the arm.
    torusGroup('ring-metal', ringRadiusM, tubeRadiusM, at(ringCenterX, 0, 0)),
  ]);
}
