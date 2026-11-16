/** Procedural geometry for the burette clamp (CLAMP): a boss head gripping the stand rod and a
 * jaw gripping the burette barrel. Approximated with simple primitives — a development
 * placeholder, not a shipping asset (no boolean-cut bore holes). */
import { at, boxGroup, cylinderGroup } from './hardware';
import { combineBuildResults, type GeometryBuildResult } from './types';

export interface BuretteClampGeometryConfig {
  readonly bossSizeM: number;
  readonly armLengthM: number;
  readonly armThicknessM: number;
  readonly jawRadiusM: number;
  readonly jawHeightM: number;
}

export const DEFAULT_BURETTE_CLAMP_CONFIG: BuretteClampGeometryConfig = {
  bossSizeM: 0.05,
  armLengthM: 0.09,
  armThicknessM: 0.018,
  jawRadiusM: 0.011,
  jawHeightM: 0.05,
};

export function buildBuretteClampGeometry(config: BuretteClampGeometryConfig = DEFAULT_BURETTE_CLAMP_CONFIG): GeometryBuildResult {
  const { bossSizeM, armLengthM, armThicknessM, jawRadiusM, jawHeightM } = config;

  return combineBuildResults([
    // Boss head: grips the stand's vertical rod.
    boxGroup('clamp-metal', bossSizeM, bossSizeM, bossSizeM, at(0, 0, 0)),
    // Arm reaching out from the boss to the jaw.
    boxGroup('clamp-metal', armLengthM, armThicknessM, armThicknessM, at(armLengthM / 2, 0, 0)),
    // Jaw: a split ring (approximated as an open cylinder shell) that grips the burette barrel.
    cylinderGroup('clamp-jaw-pad', jawRadiusM, jawRadiusM, jawHeightM, at(armLengthM, 0, 0), 20),
  ]);
}
