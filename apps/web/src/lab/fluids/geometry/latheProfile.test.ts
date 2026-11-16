import { describe, expect, it } from 'vitest';
import { buretteProfile, volumeAtHeight } from './vesselProfile';
import { glassShellPoints, liquidBodyPoints, toLathePoints } from './latheProfile';

describe('toLathePoints', () => {
  it('maps (heightM, radiusM) to Vector2(radius, height) in order', () => {
    const points = toLathePoints([
      { heightM: 0, radiusM: 0.01 },
      { heightM: 0.05, radiusM: 0.02 },
    ]);
    expect(points).toHaveLength(2);
    expect(points[0]!.x).toBeCloseTo(0.01, 9);
    expect(points[0]!.y).toBeCloseTo(0, 9);
    expect(points[1]!.x).toBeCloseTo(0.02, 9);
    expect(points[1]!.y).toBeCloseTo(0.05, 9);
  });

  it('never produces a negative radius', () => {
    const points = toLathePoints([{ heightM: 0, radiusM: -0.001 }]);
    expect(points[0]!.x).toBe(0);
  });
});

describe('glassShellPoints', () => {
  it('offsets every point outward by the wall thickness', () => {
    const profile = buretteProfile('b');
    const shell = glassShellPoints(profile);
    expect(shell).toHaveLength(profile.points.length);
    shell.forEach((p, i) => {
      expect(p.x).toBeCloseTo(profile.points[i]!.radiusM + profile.wallThicknessM, 9);
      expect(p.y).toBeCloseTo(profile.points[i]!.heightM, 9);
    });
  });
});

describe('liquidBodyPoints', () => {
  it('ends exactly at the requested fill height, using the inner (liquid-contact) profile', () => {
    const profile = buretteProfile('b', 50);
    const fillHeightM = profile.graduation!.topHeightM - 0.01;
    const points = liquidBodyPoints(profile, fillHeightM);
    expect(points[points.length - 1]!.y).toBeCloseTo(fillHeightM, 9);
    expect(points.length).toBeGreaterThanOrEqual(2);
  });

  it('is empty-looking (near-zero radii throughout) for a near-zero fill height', () => {
    const profile = buretteProfile('b', 50);
    const points = liquidBodyPoints(profile, 0);
    const emptyVolumeL = volumeAtHeight(profile.points, 0);
    expect(emptyVolumeL).toBe(0);
    expect(points.every((p) => p.y <= 1e-6)).toBe(true);
  });
});
