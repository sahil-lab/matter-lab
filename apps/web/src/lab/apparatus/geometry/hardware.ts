/** Primitive builders for non-axisymmetric hardware (stands, clamps, benches, instrument bodies).
 * Each returns one `GeometryGroup`; instrument files compose a handful of these. Three.js box and
 * cylinder primitives are centered on their local origin, so callers position each group with its
 * own `transform` rather than re-deriving offsets by hand at each call site. */
import { BoxGeometry, CylinderGeometry, SphereGeometry } from 'three';
import { IDENTITY_TRANSFORM } from '../types';
import type { Transform } from '../types';
import type { GeometryGroup } from './types';

export function boxGroup(
  materialSlot: string,
  widthM: number,
  heightM: number,
  depthM: number,
  transform: Transform = IDENTITY_TRANSFORM,
): GeometryGroup {
  return { materialSlot, geometry: new BoxGeometry(widthM, heightM, depthM), transform };
}

export function cylinderGroup(
  materialSlot: string,
  radiusTopM: number,
  radiusBottomM: number,
  heightM: number,
  transform: Transform = IDENTITY_TRANSFORM,
  radialSegments = 24,
): GeometryGroup {
  return { materialSlot, geometry: new CylinderGeometry(radiusTopM, radiusBottomM, heightM, radialSegments), transform };
}

export function sphereGroup(
  materialSlot: string,
  radiusM: number,
  transform: Transform = IDENTITY_TRANSFORM,
  widthSegments = 16,
  heightSegments = 12,
): GeometryGroup {
  return { materialSlot, geometry: new SphereGeometry(radiusM, widthSegments, heightSegments), transform };
}

/** A transform that just translates by `[x, y, z]` meters with no rotation — the common case when composing groups. */
export function at(x: number, y: number, z: number): Transform {
  return { positionM: [x, y, z], quaternion: [0, 0, 0, 1] };
}
