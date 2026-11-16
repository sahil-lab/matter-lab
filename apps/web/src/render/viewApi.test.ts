import { describe, expect, it } from 'vitest';
import { nearestTurn } from './viewApi';

const TURN = 2 * Math.PI;
const sameDirection = (a: number, b: number): void => {
  expect(Math.cos(a)).toBeCloseTo(Math.cos(b), 12);
  expect(Math.sin(a)).toBeCloseTo(Math.sin(b), 12);
};

describe('nearestTurn', () => {
  it('leaves an angle alone that is already within half a turn', () => {
    expect(nearestTurn(0, 0.42)).toBe(0.42);
    expect(nearestTurn(1.9, -1.2)).toBe(-1.2);
  });

  it('crosses the seam instead of going the long way round', () => {
    // From 344 degrees to 24 degrees is 40 degrees on, not 320 degrees back.
    expect(nearestTurn(6.0, 0.42)).toBeCloseTo(0.42 + TURN, 12);
    expect(nearestTurn(-6.0, -0.42)).toBeCloseTo(-0.42 - TURN, 12);
  });

  it('never asks for more than half a turn, however often the camera has gone round', () => {
    for (const current of [3 * TURN + 1, -5 * TURN - 2.5, 40.3, -17.9, 1000]) {
      for (const wanted of [0, 0.42, Math.PI / 2, Math.PI, -Math.PI / 2, Math.PI / 4]) {
        const target = nearestTurn(current, wanted);
        expect(Math.abs(target - current), `${current} to ${wanted}`).toBeLessThanOrEqual(Math.PI + 1e-9);
        sameDirection(target, wanted);
      }
    }
  });
});
