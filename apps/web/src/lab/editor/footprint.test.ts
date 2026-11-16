import { describe, expect, it } from 'vitest';
import type { Vec3 } from './types';
import { aabbContainsPoint, aabbsOverlap, orientedBoxFor, rayIntersectsAabb, rayIntersectsPlane, rotateVec3, worldAabbFor } from './footprint';
import type { ApparatusFootprint } from './types';

const IDENTITY_QUAT: readonly [number, number, number, number] = [0, 0, 0, 1];

function quatAroundY(radians: number): readonly [number, number, number, number] {
  return [0, Math.sin(radians / 2), 0, Math.cos(radians / 2)];
}

describe('rotateVec3', () => {
  it('leaves a vector unchanged under the identity quaternion', () => {
    expect(rotateVec3([1, 2, 3], IDENTITY_QUAT)).toEqual([1, 2, 3]);
  });

  it('rotates the +x axis to -z under a +90 degree yaw (right-hand rule about +y)', () => {
    const [x, y, z] = rotateVec3([1, 0, 0], quatAroundY(Math.PI / 2));
    expect(x).toBeCloseTo(0, 10);
    expect(y).toBeCloseTo(0, 10);
    expect(z).toBeCloseTo(-1, 10);
  });
});

describe('worldAabbFor', () => {
  const footprint: ApparatusFootprint = { halfExtents: [0.1, 0.2, 0.1], center: [0, 0.2, 0] };

  it('places the box at the instance origin plus the local footprint center, under the identity transform', () => {
    const box = worldAabbFor(footprint, { positionM: [1, 0, 2], quaternion: IDENTITY_QUAT });
    expect(box.min).toEqual([0.9, 0, 1.9]);
    expect(box.max).toEqual([1.1, 0.4, 2.1]);
  });

  it('produces a wider (conservative) axis-aligned box once the footprint is rotated 45 degrees', () => {
    const rotated = worldAabbFor({ halfExtents: [0.2, 0.1, 0.1], center: [0, 0, 0] }, { positionM: [0, 0, 0], quaternion: quatAroundY(Math.PI / 4) });
    const axisAligned = worldAabbFor({ halfExtents: [0.2, 0.1, 0.1], center: [0, 0, 0] }, { positionM: [0, 0, 0], quaternion: IDENTITY_QUAT });
    expect(rotated.max[0] - rotated.min[0]).toBeGreaterThan(axisAligned.max[0] - axisAligned.min[0]);
  });
});

describe('orientedBoxFor', () => {
  it('produces eight distinct corners for a non-degenerate footprint', () => {
    const box = orientedBoxFor({ halfExtents: [1, 1, 1], center: [0, 0, 0] }, { positionM: [0, 0, 0], quaternion: IDENTITY_QUAT });
    const unique = new Set(box.corners.map((c) => c.join(',')));
    expect(unique.size).toBe(8);
  });
});

describe('aabbsOverlap / aabbContainsPoint', () => {
  it('detects overlapping boxes and rejects separated ones', () => {
    const a = { min: [0, 0, 0] as Vec3, max: [1, 1, 1] as Vec3 };
    const b = { min: [0.5, 0.5, 0.5] as Vec3, max: [1.5, 1.5, 1.5] as Vec3 };
    const c = { min: [2, 2, 2] as Vec3, max: [3, 3, 3] as Vec3 };
    expect(aabbsOverlap(a, b)).toBe(true);
    expect(aabbsOverlap(a, c)).toBe(false);
  });

  it('treats boxes that merely touch at a face as not overlapping', () => {
    const a = { min: [0, 0, 0] as Vec3, max: [1, 1, 1] as Vec3 };
    const b = { min: [1, 0, 0] as Vec3, max: [2, 1, 1] as Vec3 };
    expect(aabbsOverlap(a, b)).toBe(false);
  });

  it('contains points inside the box and rejects points outside', () => {
    const box = { min: [0, 0, 0] as Vec3, max: [1, 1, 1] as Vec3 };
    expect(aabbContainsPoint(box, [0.5, 0.5, 0.5])).toBe(true);
    expect(aabbContainsPoint(box, [1.5, 0.5, 0.5])).toBe(false);
  });
});

describe('rayIntersectsAabb', () => {
  const box = { min: [-1, -1, -1] as Vec3, max: [1, 1, 1] as Vec3 };

  it('hits a box centred on the ray', () => {
    const t = rayIntersectsAabb({ origin: [0, 0, -5], direction: [0, 0, 1] }, box);
    expect(t).toBeCloseTo(4, 10);
  });

  it('misses a box the ray passes beside', () => {
    expect(rayIntersectsAabb({ origin: [5, 5, -5], direction: [0, 0, 1] }, box)).toBeNull();
  });

  it('misses a box that is behind the ray origin', () => {
    expect(rayIntersectsAabb({ origin: [0, 0, 5], direction: [0, 0, 1] }, box)).toBeNull();
  });

  it('returns 0 (the origin itself) when the ray starts inside the box', () => {
    expect(rayIntersectsAabb({ origin: [0, 0, 0], direction: [0, 0, 1] }, box)).toBe(0);
  });
});

describe('rayIntersectsPlane', () => {
  it('finds where a downward ray meets the ground plane', () => {
    const point = rayIntersectsPlane({ origin: [1, 5, 2], direction: [0, -1, 0] }, [0, 0, 0], [0, 1, 0]);
    expect(point).toEqual([1, 0, 2]);
  });

  it('returns null for a ray parallel to the plane', () => {
    expect(rayIntersectsPlane({ origin: [0, 1, 0], direction: [1, 0, 0] }, [0, 0, 0], [0, 1, 0])).toBeNull();
  });

  it('returns null when the plane is behind the ray origin', () => {
    expect(rayIntersectsPlane({ origin: [0, -1, 0], direction: [0, -1, 0] }, [0, 0, 0], [0, 1, 0])).toBeNull();
  });
});
