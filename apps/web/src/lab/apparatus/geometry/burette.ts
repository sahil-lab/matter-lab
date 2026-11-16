/** Procedural geometry for the graduated burette (BURETTE): a lathed glass barrel plus a stopcock
 * housing and key. Overall length and bore follow ISO 385 Class A/B 50 mL catalog figures (see
 * `sources.ts`); the barrel radius is then calibrated so the modeled vessel holds exactly
 * `capacityL` (see `capacityScaleFactor` in `../container`) rather than whatever this simplified
 * single-taper profile happens to integrate to at the cited bore diameter. */
import { capacityScaleFactor } from '../container';
import { at, boxGroup, cylinderGroup } from './hardware';
import { buildRevolutionMesh, buretteProfile } from './profiles';
import { combineBuildResults, type GeometryBuildResult } from './types';

export interface BuretteGeometryConfig {
  readonly barrelRadiusM: number;
  readonly totalHeightM: number;
  readonly tipRadiusM: number;
  readonly tipHeightM: number;
  readonly funnelTopRadiusM: number;
  readonly funnelHeightM: number;
  readonly stopcockHeightM: number;
  /** Simulated liquid capacity below the "0" mark, in liters. The burette's class rating. */
  readonly capacityL: number;
}

export const DEFAULT_BURETTE_CONFIG: BuretteGeometryConfig = {
  barrelRadiusM: 0.0048,
  totalHeightM: 0.78,
  tipRadiusM: 0.0015,
  tipHeightM: 0.05,
  funnelTopRadiusM: 0.011,
  funnelHeightM: 0.03,
  stopcockHeightM: 0.022,
  capacityL: 0.05,
};

/** The raw (uncalibrated) profile at this config's literal radii, and the factor that brings its
 * integrated volume to exactly `config.capacityL`. Exported together so both the glass mesh and
 * any radius-dependent hardware (the stopcock housing) scale consistently from one computation. */
function calibrate(config: BuretteGeometryConfig): { readonly points: ReturnType<typeof buretteProfile>; readonly factor: number } {
  const points = buretteProfile(config);
  return { points, factor: capacityScaleFactor(points, config.capacityL) };
}

/** The profile actually used for the glass mesh and the `ContainerSpec`, scaled so its integrated
 * volume is exactly `config.capacityL`. The funnel mouth above the barrel is not part of the
 * graduated range and is not counted toward capacity (see the burette definition's provenance notes). */
export function buretteGlassProfile(config: BuretteGeometryConfig = DEFAULT_BURETTE_CONFIG) {
  const { points, factor } = calibrate(config);
  return points.map((p) => ({ ...p, r: p.r * factor }));
}

export function buildBuretteGeometry(config: BuretteGeometryConfig = DEFAULT_BURETTE_CONFIG): GeometryBuildResult {
  const { points, factor } = calibrate(config);
  const mesh = buildRevolutionMesh(
    points.map((p) => ({ ...p, r: p.r * factor })),
    32,
  );
  const stopcockY = config.tipHeightM * 0.65;
  // The stopcock housing/key are sized off the tip radius, so scale them by the same factor as the
  // glass or they would silently stop matching a barrel that was calibrated to a different capacity.
  const scaledTipRadius = config.tipRadiusM * factor;

  return combineBuildResults([
    { materialSlot: 'glass', geometry: mesh.geometry },
    // Stopcock housing, just above the tip.
    cylinderGroup('stopcock-body', scaledTipRadius * 2.6, scaledTipRadius * 2.6, config.stopcockHeightM, at(0, stopcockY, 0), 16),
    // Stopcock key/lever — its rotation about Y represents valve state (0 = closed/across the bore, driven by the R3F component, not baked in here).
    boxGroup('stopcock-key', scaledTipRadius * 7, scaledTipRadius * 1.4, scaledTipRadius * 1.4, at(0, stopcockY, 0)),
  ]);
}

/** The barrel's outer diameter after capacity calibration — the figure the burette clamp's jaw
 * socket must declare a `cylinder-fit` range around. Derived rather than hand-typed so it can
 * never drift out of sync with `buildBuretteGeometry`'s actual mesh. */
export function calibratedBarrelDiameterM(config: BuretteGeometryConfig = DEFAULT_BURETTE_CONFIG): number {
  const { factor } = calibrate(config);
  return config.barrelRadiusM * 2 * factor;
}
