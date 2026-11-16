/**
 * Shared revolution-profile machinery for glassware (and similar axisymmetric parts). Every
 * vessel's visual mesh and its volume calibration (`container.ts`) are derived from the *same*
 * list of (radius, height) points, so the meniscus Agent 05 renders can never disagree with the
 * glass Agent 03 modeled — the acceptance test "burette remaining volume and visible meniscus
 * agree" is a structural property of this module, not something tuned by hand.
 *
 * Coordinates follow the renderer's Y-up convention. A profile's local origin is the outer
 * base center of the vessel, which is also each definition's placement origin.
 */
import { BufferGeometry, LatheGeometry, Vector2 } from 'three';

export interface ProfilePoint {
  /** Radius from the revolution axis, in meters. */
  readonly r: number;
  /** Height above the vessel's base, in meters. */
  readonly y: number;
}

export interface RevolutionMesh {
  readonly geometry: BufferGeometry;
  readonly polyCount: number;
}

/** Triangle count of a geometry, counting indexed triangles if indexed, else assuming an unindexed triangle list. */
export function countTriangles(geometry: BufferGeometry): number {
  const index = geometry.index;
  if (index) return index.count / 3;
  const position = geometry.getAttribute('position');
  return position ? position.count / 3 : 0;
}

/** Revolves a 2D (radius, height) profile about the vertical axis into a thin-shell outer surface
 * — deliberately not a double-walled solid, which is the usual cause of z-fighting/sorting
 * artifacts in transparent glass (brief: "transparency-friendly meshes"). Agent 05's glass
 * material supplies apparent thickness via its transmission shader, not extra geometry. */
export function buildRevolutionMesh(points: readonly ProfilePoint[], segments = 48): RevolutionMesh {
  if (points.length < 2) throw new Error('A revolution profile needs at least two points.');
  const vec2Points = points.map((p) => new Vector2(Math.max(0, p.r), p.y));
  const geometry = new LatheGeometry(vec2Points, segments);
  geometry.computeVertexNormals();
  return { geometry, polyCount: countTriangles(geometry) };
}

function round(n: number, decimals = 6): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

/** A plain right cylinder: beakers, test tubes (body), graduated cylinders, the burette barrel. */
export function cylinderProfile(radiusM: number, heightM: number): ProfilePoint[] {
  return [
    { r: 0, y: 0 },
    { r: radiusM, y: 0 },
    { r: radiusM, y: heightM },
    { r: 0, y: heightM },
  ];
}

/** A cylindrical body rounded into a hemispherical bottom, e.g. a test tube. `segments` controls
 * how many points approximate the hemisphere quarter-arc. */
export function roundedBottomCylinderProfile(radiusM: number, heightM: number, segments = 8): ProfilePoint[] {
  const points: ProfilePoint[] = [];
  for (let i = 0; i <= segments; i++) {
    const theta = (Math.PI / 2) * (i / segments); // 0 at the pole (bottom tip) to pi/2 at the equator
    points.push({ r: round(radiusM * Math.sin(theta)), y: round(radiusM - radiusM * Math.cos(theta)) });
  }
  points.push({ r: radiusM, y: heightM });
  return points;
}

export interface ConicalFlaskProfileOptions {
  readonly baseRadiusM: number;
  readonly neckRadiusM: number;
  readonly totalHeightM: number;
  readonly neckHeightM: number;
  readonly lipFlareM?: number;
}

/** An Erlenmeyer (conical) flask: flat bottom, straight conical taper, cylindrical neck, flared lip. */
export function conicalFlaskProfile(options: ConicalFlaskProfileOptions): ProfilePoint[] {
  const { baseRadiusM, neckRadiusM, totalHeightM, neckHeightM, lipFlareM = neckRadiusM * 0.18 } = options;
  const shoulderHeightM = totalHeightM - neckHeightM;
  return [
    { r: 0, y: 0 },
    { r: baseRadiusM, y: 0 },
    { r: baseRadiusM, y: shoulderHeightM * 0.08 },
    { r: neckRadiusM, y: shoulderHeightM },
    { r: neckRadiusM, y: totalHeightM - neckRadiusM * 0.3 },
    { r: neckRadiusM + lipFlareM, y: totalHeightM },
  ];
}

export interface RoundShoulderBottleProfileOptions {
  readonly bodyRadiusM: number;
  readonly neckRadiusM: number;
  readonly totalHeightM: number;
  readonly neckHeightM: number;
  readonly shoulderHeightM: number;
}

/** A reagent-bottle-like silhouette: cylindrical body, rounded shoulder, narrow neck with a lip. */
export function roundShoulderBottleProfile(options: RoundShoulderBottleProfileOptions): ProfilePoint[] {
  const { bodyRadiusM, neckRadiusM, totalHeightM, neckHeightM, shoulderHeightM } = options;
  const shoulderStartY = totalHeightM - neckHeightM - shoulderHeightM;
  const neckStartY = totalHeightM - neckHeightM;
  return [
    { r: 0, y: 0 },
    { r: bodyRadiusM, y: 0 },
    { r: bodyRadiusM, y: shoulderStartY },
    { r: bodyRadiusM * 0.75, y: shoulderStartY + shoulderHeightM * 0.55 },
    { r: neckRadiusM, y: neckStartY },
    { r: neckRadiusM, y: totalHeightM - neckRadiusM * 0.25 },
    { r: neckRadiusM * 1.3, y: totalHeightM },
  ];
}

export interface BuretteProfileOptions {
  readonly barrelRadiusM: number;
  readonly totalHeightM: number;
  readonly tipRadiusM: number;
  readonly tipHeightM: number;
  readonly funnelTopRadiusM: number;
  readonly funnelHeightM: number;
}

/** A graduated burette: a long thin barrel, a small funnel mouth at the top, and a narrow tapered tip at the bottom above the stopcock. */
export function buretteProfile(options: BuretteProfileOptions): ProfilePoint[] {
  const { barrelRadiusM, totalHeightM, tipRadiusM, tipHeightM, funnelTopRadiusM, funnelHeightM } = options;
  return [
    { r: 0, y: 0 },
    { r: tipRadiusM, y: 0 },
    { r: tipRadiusM, y: tipHeightM * 0.4 },
    { r: barrelRadiusM, y: tipHeightM },
    { r: barrelRadiusM, y: totalHeightM - funnelHeightM },
    { r: funnelTopRadiusM, y: totalHeightM },
  ];
}

export interface VolumetricFlaskProfileOptions {
  readonly bulbRadiusM: number;
  readonly bulbHeightM: number;
  readonly neckRadiusM: number;
  readonly neckHeightM: number;
}

/** A volumetric flask: a flattened pear-shaped bulb and a long thin calibrated neck. */
export function volumetricFlaskProfile(options: VolumetricFlaskProfileOptions): ProfilePoint[] {
  const { bulbRadiusM, bulbHeightM, neckRadiusM, neckHeightM } = options;
  return [
    { r: 0, y: 0 },
    { r: bulbRadiusM * 0.55, y: 0 },
    { r: bulbRadiusM, y: bulbHeightM * 0.42 },
    { r: bulbRadiusM * 0.85, y: bulbHeightM * 0.8 },
    { r: neckRadiusM, y: bulbHeightM },
    { r: neckRadiusM, y: bulbHeightM + neckHeightM },
    { r: neckRadiusM * 1.25, y: bulbHeightM + neckHeightM },
  ];
}

/** A simple cone open at the wide end, e.g. a filter funnel's bowl (the stem is a separate cylinder). */
export function funnelBowlProfile(topRadiusM: number, bottomRadiusM: number, heightM: number): ProfilePoint[] {
  return [
    { r: bottomRadiusM, y: 0 },
    { r: topRadiusM, y: heightM },
  ];
}
