/**
 * Converts `VesselProfile` control points (Agent 05's own geometry model, see `vesselProfile.ts`)
 * into the `(radius, height)` point lists `THREE.LatheGeometry` revolves around the vertical axis.
 * Kept separate from `vesselProfile.ts` so that file stays free of a `three` import and is usable
 * from a plain Node test environment without a GPU.
 */
import { Vector2 } from 'three';
import type { VesselProfile, VesselProfilePoint } from '../contracts';
import { profilePointsUpTo } from './vesselProfile';

/** `LatheGeometry` reads `x` as radius and `y` as height; points must run base (y=0) to rim. */
export function toLathePoints(points: readonly VesselProfilePoint[]): Vector2[] {
  return points.map((p) => new Vector2(Math.max(p.radiusM, 0), p.heightM));
}

/**
 * Outer-wall points for the glass shell mesh: the inner (liquid-contact) radius plus the vessel's
 * wall thickness at every height. This offsets radius uniformly rather than along the true wall
 * normal, which is a deliberate simplification for the gently sloped profiles modeled here (see
 * `lab/fluids/README.md`); a steeply angled wall would want a normal-vector offset instead.
 */
export function glassShellPoints(profile: VesselProfile): Vector2[] {
  return toLathePoints(profile.points.map((p) => ({ heightM: p.heightM, radiusM: p.radiusM + profile.wallThicknessM })));
}

/**
 * Inner-wall points for the liquid body's side wall, from the vessel base up to the meniscus
 * height. Always ends with a point exactly at `fillHeightM`, which is what lets the liquid mesh's
 * rim sit precisely at the computed meniscus height (see `profilePointsUpTo`).
 */
export function liquidBodyPoints(profile: VesselProfile, fillHeightM: number): Vector2[] {
  return toLathePoints(profilePointsUpTo(profile.points, fillHeightM));
}
