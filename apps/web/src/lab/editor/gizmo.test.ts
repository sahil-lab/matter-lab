import { describe, expect, it } from 'vitest';
import { IDENTITY_TRANSFORM } from './contracts';
import { applyRigidDelta, axisAngleQuat, centroid, rotateInstances, rotateTransformAroundPivot, snapPositionToGrid, snapToGrid, translateInstances } from './gizmo';

describe('axisAngleQuat', () => {
  it('a 180 degree rotation about Y maps +X to -X', () => {
    const q = axisAngleQuat('y', Math.PI);
    expect(q[1]).toBeCloseTo(1, 10);
    expect(q[3]).toBeCloseTo(0, 10);
  });
});

describe('rotateTransformAroundPivot', () => {
  it('rotating 90 degrees about Y around a pivot at the origin moves +X to -Z', () => {
    const transform = { positionM: [1, 0, 0] as const, quaternion: IDENTITY_TRANSFORM.quaternion };
    const rotated = rotateTransformAroundPivot(transform, [0, 0, 0], axisAngleQuat('y', Math.PI / 2));
    expect(rotated.positionM[0]).toBeCloseTo(0, 10);
    expect(rotated.positionM[2]).toBeCloseTo(-1, 10);
  });

  it('rotating about a pivot that is not the origin orbits the instance around that point', () => {
    const transform = { positionM: [2, 0, 0] as const, quaternion: IDENTITY_TRANSFORM.quaternion };
    const rotated = rotateTransformAroundPivot(transform, [1, 0, 0], axisAngleQuat('y', Math.PI));
    expect(rotated.positionM[0]).toBeCloseTo(0, 10);
    expect(rotated.positionM[2]).toBeCloseTo(0, 10);
  });
});

describe('applyRigidDelta', () => {
  it('keeps relative offsets between instances fixed when the group rotates about its pivot', () => {
    const pivotBefore = IDENTITY_TRANSFORM;
    const pivotAfter = { positionM: [0, 0, 0] as const, quaternion: axisAngleQuat('y', Math.PI / 2) };
    const instances = new Map([
      ['a', { positionM: [1, 0, 0] as const, quaternion: IDENTITY_TRANSFORM.quaternion }],
      ['b', { positionM: [2, 0, 0] as const, quaternion: IDENTITY_TRANSFORM.quaternion }],
    ]);
    const result = applyRigidDelta(pivotBefore, pivotAfter, instances);
    // Both instances rotate the same way about the shared pivot, so b stays twice as far as a.
    const a = result.get('a')!;
    const b = result.get('b')!;
    expect(a.positionM[2]).toBeCloseTo(-1, 10);
    expect(b.positionM[2]).toBeCloseTo(-2, 10);
  });

  it('a pure translation of the pivot translates every instance by the same amount', () => {
    const pivotBefore = IDENTITY_TRANSFORM;
    const pivotAfter = { positionM: [5, 0, 0] as const, quaternion: IDENTITY_TRANSFORM.quaternion };
    const instances = new Map([['a', { positionM: [1, 0, 0] as const, quaternion: IDENTITY_TRANSFORM.quaternion }]]);
    const result = applyRigidDelta(pivotBefore, pivotAfter, instances);
    expect(result.get('a')!.positionM).toEqual([6, 0, 0]);
  });
});

describe('translateInstances / rotateInstances', () => {
  it('translates every instance by the same world-space vector', () => {
    const instances = new Map([
      ['a', { positionM: [0, 0, 0] as const, quaternion: IDENTITY_TRANSFORM.quaternion }],
      ['b', { positionM: [1, 1, 1] as const, quaternion: IDENTITY_TRANSFORM.quaternion }],
    ]);
    const result = translateInstances(instances, [1, 0, 0]);
    expect(result.get('a')!.positionM).toEqual([1, 0, 0]);
    expect(result.get('b')!.positionM).toEqual([2, 1, 1]);
  });

  it('rotateInstances rotates every instance about a shared pivot by a typed angle', () => {
    const instances = new Map([['a', { positionM: [1, 0, 0] as const, quaternion: IDENTITY_TRANSFORM.quaternion }]]);
    const result = rotateInstances(instances, [0, 0, 0], 'y', Math.PI / 2);
    expect(result.get('a')!.positionM[0]).toBeCloseTo(0, 10);
    expect(result.get('a')!.positionM[2]).toBeCloseTo(-1, 10);
  });
});

describe('centroid', () => {
  it('averages a set of points', () => {
    expect(centroid([[0, 0, 0], [2, 0, 0], [1, 3, 0]])).toEqual([1, 1, 0]);
  });

  it('returns the origin for an empty set', () => {
    expect(centroid([])).toEqual([0, 0, 0]);
  });
});

describe('snapToGrid / snapPositionToGrid', () => {
  it('rounds to the nearest grid multiple', () => {
    expect(snapToGrid(0.123, 0.05)).toBeCloseTo(0.1, 10);
    expect(snapToGrid(0.07, 0.05)).toBeCloseTo(0.05, 10);
  });

  it('leaves the value untouched when gridM is 0 (free placement)', () => {
    expect(snapToGrid(0.1234, 0)).toBe(0.1234);
  });

  it('snaps every axis of a position', () => {
    const snapped = snapPositionToGrid([0.12, 0.26, 0.04], 0.1);
    expect(snapped[0]).toBeCloseTo(0.1, 10);
    expect(snapped[1]).toBeCloseTo(0.3, 10);
    expect(snapped[2]).toBeCloseTo(0, 10);
  });
});
