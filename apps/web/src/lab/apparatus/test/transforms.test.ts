import { describe, expect, it } from 'vitest';
import {
  applyTransformToPoint,
  approxEqualTransform,
  axisAngleBetween,
  composeTransforms,
  distanceBetween,
  invertTransform,
  offsetAlongLocalZ,
  solveCoincidentOrigin,
  transformFromEuler,
  uprightSocketTransform,
} from '../transforms';
import { IDENTITY_TRANSFORM } from '../types';

describe('composeTransforms / invertTransform', () => {
  it('composing a transform with its own inverse yields the identity', () => {
    const t = transformFromEuler([1, 2, 3], [30, 60, 90]);
    const result = composeTransforms(t, invertTransform(t));
    expect(approxEqualTransform(result, IDENTITY_TRANSFORM)).toBe(true);
  });

  it('is associative in the order position offsets compose', () => {
    const a = transformFromEuler([1, 0, 0]);
    const b = transformFromEuler([0, 2, 0]);
    const combined = composeTransforms(a, b);
    expect(combined.positionM[0]).toBeCloseTo(1, 9);
    expect(combined.positionM[1]).toBeCloseTo(2, 9);
  });
});

describe('transformFromEuler / applyTransformToPoint', () => {
  it('a 90 degree rotation about Y maps local +Z to world +X', () => {
    const t = transformFromEuler([0, 0, 0], [0, 90, 0]);
    const [x, y, z] = applyTransformToPoint(t, [0, 0, 1]);
    expect(x).toBeCloseTo(1, 6);
    expect(y).toBeCloseTo(0, 6);
    expect(z).toBeCloseTo(0, 6);
  });
});

describe('uprightSocketTransform', () => {
  it('maps local +Z to the object\u2019s own +Y, at the requested position', () => {
    const t = uprightSocketTransform([0.1, 0.2, 0.3]);
    const [x, y, z] = applyTransformToPoint(t, [0, 0, 1]);
    expect(x).toBeCloseTo(0.1, 6);
    expect(y).toBeCloseTo(1.2, 6);
    expect(z).toBeCloseTo(0.3, 6);
  });
});

describe('solveCoincidentOrigin', () => {
  it('finds a child origin such that composing it with the child socket reproduces the parent socket exactly', () => {
    const parentSocketWorld = transformFromEuler([1, 2, 3], [10, 20, 30]);
    const childSocketLocal = transformFromEuler([0.1, 0, 0], [0, 0, 45]);
    const childOrigin = solveCoincidentOrigin(parentSocketWorld, childSocketLocal);
    const reconstructed = composeTransforms(childOrigin, childSocketLocal);
    expect(approxEqualTransform(reconstructed, parentSocketWorld)).toBe(true);
  });
});

describe('distanceBetween / axisAngleBetween', () => {
  it('measures straight-line distance between two positions', () => {
    const a = { positionM: [0, 0, 0] as const, quaternion: [0, 0, 0, 1] as const };
    const b = { positionM: [3, 4, 0] as const, quaternion: [0, 0, 0, 1] as const };
    expect(distanceBetween(a, b)).toBeCloseTo(5, 9);
  });

  it('is zero for two transforms with the same orientation, and positive for a 90 degree difference', () => {
    const upright = uprightSocketTransform([0, 0, 0]);
    expect(axisAngleBetween(upright, upright)).toBeCloseTo(0, 9);
    expect(axisAngleBetween(IDENTITY_TRANSFORM, upright)).toBeCloseTo(Math.PI / 2, 6);
  });
});

describe('offsetAlongLocalZ', () => {
  it('translates purely along the transform\u2019s own local +Z axis', () => {
    const t = transformFromEuler([0, 0, 0], [0, 90, 0]); // local +Z now points at world +X
    const offset = offsetAlongLocalZ(t, 2);
    expect(offset.positionM[0]).toBeCloseTo(2, 6);
    expect(offset.positionM[2]).toBeCloseTo(0, 6);
  });
});

describe('approxEqualTransform', () => {
  it('treats q and -q as the same rotation', () => {
    const a = transformFromEuler([0, 0, 0], [45, 0, 0]);
    const b = { positionM: a.positionM, quaternion: a.quaternion.map((c) => -c) as [number, number, number, number] };
    expect(approxEqualTransform(a, b)).toBe(true);
  });

  it('is false once positions differ beyond the tolerance', () => {
    const a = IDENTITY_TRANSFORM;
    const b = { positionM: [0, 0, 0.01] as const, quaternion: [0, 0, 0, 1] as const };
    expect(approxEqualTransform(a, b, 1e-5)).toBe(false);
  });
});
