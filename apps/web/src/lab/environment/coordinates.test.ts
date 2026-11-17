import { describe, expect, it } from 'vitest';
import {
  clamp,
  composeTransforms,
  conjugate,
  distance,
  GRID_CELL_M,
  multiplyQuaternions,
  rotateVector,
  snapPointToGrid,
  snapToGrid,
  stationToWorld,
  worldToLocal,
  worldToStation,
  yawOf,
  yawQuaternion,
} from './coordinates';
import type { QuatTuple, Vec3M, WorldTransform } from './types';

/** Independent reference implementation (the classic rotation matrix about Y), to cross-check {@link rotateVector}. */
function rotateYByMatrix(v: Vec3M, theta: number): Vec3M {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return [c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]];
}

function expectClose(a: Vec3M, b: Vec3M, precision = 10): void {
  expect(a[0]).toBeCloseTo(b[0], precision);
  expect(a[1]).toBeCloseTo(b[1], precision);
  expect(a[2]).toBeCloseTo(b[2], precision);
}

function expectQuatClose(a: QuatTuple, b: QuatTuple, precision = 10): void {
  expect(a[0]).toBeCloseTo(b[0], precision);
  expect(a[1]).toBeCloseTo(b[1], precision);
  expect(a[2]).toBeCloseTo(b[2], precision);
  expect(a[3]).toBeCloseTo(b[3], precision);
}

describe('clamp', () => {
  it('keeps values inside the range unchanged', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });
  it('clamps to the bounds', () => {
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
  });
});

describe('snapToGrid', () => {
  it('rounds to the nearest cell', () => {
    expect(snapToGrid(0.123, 0.05)).toBeCloseTo(0.1, 10);
    expect(snapToGrid(0.137, 0.05)).toBeCloseTo(0.15, 10);
  });
  it('defaults to the standard placement grid', () => {
    expect(snapToGrid(0.123)).toBeCloseTo(0.1, 10);
    expect(GRID_CELL_M).toBeGreaterThan(0);
  });
  it('is a no-op for a non-positive cell size', () => {
    expect(snapToGrid(0.123, 0)).toBe(0.123);
  });
});

describe('snapPointToGrid', () => {
  it('snaps X and Z but leaves height untouched', () => {
    const snapped = snapPointToGrid([0.123, 0.9123, -0.07], 0.05);
    expect(snapped[0]).toBeCloseTo(0.1, 10);
    expect(snapped[1]).toBe(0.9123);
    expect(snapped[2]).toBeCloseTo(-0.05, 10);
  });
});

describe('yawQuaternion / yawOf', () => {
  it('round-trips an angle through the quaternion representation', () => {
    for (const angle of [0, 0.1, Math.PI / 2, -Math.PI / 3, Math.PI - 0.01]) {
      expect(yawOf(yawQuaternion(angle))).toBeCloseTo(angle, 10);
    }
  });

  it('produces a unit quaternion', () => {
    const q = yawQuaternion(1.234);
    const normSq = q[0] ** 2 + q[1] ** 2 + q[2] ** 2 + q[3] ** 2;
    expect(normSq).toBeCloseTo(1, 10);
  });
});

describe('rotateVector', () => {
  it('leaves a vector unchanged under the identity quaternion', () => {
    expectClose(rotateVector([1, 2, 3], [0, 0, 0, 1]), [1, 2, 3]);
  });

  it('matches the classic Y-rotation matrix for several angles and vectors', () => {
    const vectors: Vec3M[] = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [0.3, -1.2, 2.5],
    ];
    for (const angle of [Math.PI / 2, Math.PI / 4, -Math.PI / 3, 2.1]) {
      const q = yawQuaternion(angle);
      for (const v of vectors) {
        expectClose(rotateVector(v, q), rotateYByMatrix(v, angle));
      }
    }
  });
});

describe('conjugate / multiplyQuaternions', () => {
  it('a quaternion times its conjugate is the identity', () => {
    const q = yawQuaternion(0.77);
    expectQuatClose(multiplyQuaternions(q, conjugate(q)), [0, 0, 0, 1]);
  });
});

describe('composeTransforms / worldToLocal', () => {
  it('round-trips an arbitrary local transform through a parent', () => {
    const parent: WorldTransform = { positionM: [1.5, 0.9, -2.2], quaternion: yawQuaternion(0.8) };
    const local: WorldTransform = { positionM: [0.2, 0.05, -0.1], quaternion: yawQuaternion(-1.1) };
    const world = composeTransforms(parent, local);
    const recovered = worldToLocal(parent, world);
    expectClose(recovered.positionM, local.positionM);
    expectQuatClose(recovered.quaternion, local.quaternion);
  });

  it('with an identity parent, world equals local', () => {
    const identityParent: WorldTransform = { positionM: [0, 0, 0], quaternion: [0, 0, 0, 1] };
    const local: WorldTransform = { positionM: [1, 2, 3], quaternion: yawQuaternion(0.4) };
    const world = composeTransforms(identityParent, local);
    expectClose(world.positionM, local.positionM);
    expectQuatClose(world.quaternion, local.quaternion);
  });
});

describe('stationToWorld / worldToStation', () => {
  it('round-trips a point through an arbitrary station origin', () => {
    const origin: WorldTransform = { positionM: [3, 0.9, -1], quaternion: yawQuaternion(1.0) };
    const point: Vec3M = [0.4, 0.1, -0.2];
    const world = stationToWorld(origin, point);
    const back = worldToStation(origin, world);
    expectClose(back, point);
  });

  it('is a plain translation when the station is unrotated', () => {
    const origin: WorldTransform = { positionM: [2, 0, 5], quaternion: [0, 0, 0, 1] };
    expectClose(stationToWorld(origin, [1, 0, 0]), [3, 0, 5]);
  });
});

describe('distance', () => {
  it('computes Euclidean distance', () => {
    expect(distance([0, 0, 0], [3, 4, 0])).toBeCloseTo(5, 10);
  });
});
