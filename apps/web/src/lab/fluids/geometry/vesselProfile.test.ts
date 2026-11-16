import { describe, expect, it } from 'vitest';
import type { VesselProfilePoint } from '../contracts';
import {
  beakerProfile,
  buretteProfile,
  erlenmeyerFlaskProfile,
  heightForReadingML,
  heightForVolume,
  profilePointsUpTo,
  radiusAtHeight,
  readingML,
  reagentBottleProfile,
  volumeAtHeight,
} from './vesselProfile';

const CYLINDER: readonly VesselProfilePoint[] = [
  { heightM: 0, radiusM: 0.05 },
  { heightM: 1, radiusM: 0.05 },
];

describe('volumeAtHeight', () => {
  it('matches the analytic cylinder volume (liters) exactly', () => {
    const halfway = volumeAtHeight(CYLINDER, 0.5);
    const expected = Math.PI * 0.05 * 0.05 * 0.5 * 1000;
    expect(halfway).toBeCloseTo(expected, 9);
  });

  it('is zero at or below the base and clamps at or above the rim', () => {
    expect(volumeAtHeight(CYLINDER, 0)).toBe(0);
    expect(volumeAtHeight(CYLINDER, -5)).toBe(0);
    const full = volumeAtHeight(CYLINDER, 1);
    expect(volumeAtHeight(CYLINDER, 50)).toBeCloseTo(full, 9);
  });

  it('is strictly increasing with height for a non-monotonic-radius flask', () => {
    const profile = erlenmeyerFlaskProfile('flask-250');
    const top = profile.points[profile.points.length - 1]!.heightM;
    let previous = -1;
    for (let h = 0; h <= top; h += top / 200) {
      const v = volumeAtHeight(profile.points, h);
      expect(v).toBeGreaterThanOrEqual(previous);
      previous = v;
    }
  });
});

describe('heightForVolume', () => {
  it('round-trips with volumeAtHeight on a cylinder', () => {
    for (const volumeL of [0, 0.5, 1.25, 3.9269908169])
      {
        const h = heightForVolume(CYLINDER, volumeL);
        const back = volumeAtHeight(CYLINDER, h);
        expect(back).toBeCloseTo(Math.min(volumeL, volumeAtHeight(CYLINDER, 1)), 4);
      }
  });

  it('round-trips on a flask whose radius is not monotonic', () => {
    const profile = erlenmeyerFlaskProfile('flask-250');
    const full = volumeAtHeight(profile.points, profile.points[profile.points.length - 1]!.heightM);
    for (const fraction of [0, 0.1, 0.4, 0.75, 1]) {
      const volumeL = full * fraction;
      const h = heightForVolume(profile.points, volumeL);
      expect(volumeAtHeight(profile.points, h)).toBeCloseTo(volumeL, 4);
    }
  });

  it('clamps to the profile extent outside [0, full]', () => {
    expect(heightForVolume(CYLINDER, -1)).toBe(0);
    expect(heightForVolume(CYLINDER, 1e6)).toBe(1);
  });
});

describe('radiusAtHeight', () => {
  it('interpolates linearly between control points', () => {
    const points: VesselProfilePoint[] = [
      { heightM: 0, radiusM: 0.01 },
      { heightM: 0.1, radiusM: 0.02 },
    ];
    expect(radiusAtHeight(points, 0.05)).toBeCloseTo(0.015, 9);
  });

  it('clamps outside the profile', () => {
    expect(radiusAtHeight(CYLINDER, -1)).toBe(0.05);
    expect(radiusAtHeight(CYLINDER, 5)).toBe(0.05);
  });
});

describe('profilePointsUpTo', () => {
  it('ends exactly at the requested height and keeps earlier points', () => {
    const profile = buretteProfile('burette-50');
    const target = profile.points[1]!.heightM + 0.01;
    const truncated = profilePointsUpTo(profile.points, target);
    expect(truncated[truncated.length - 1]!.heightM).toBeCloseTo(target, 9);
    expect(truncated.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < truncated.length; i++) expect(truncated[i]!.heightM).toBeGreaterThan(truncated[i - 1]!.heightM);
  });

  it('never returns fewer than two points even at the base', () => {
    const profile = buretteProfile('burette-50');
    const truncated = profilePointsUpTo(profile.points, 0);
    expect(truncated.length).toBeGreaterThanOrEqual(2);
  });
});

describe('burette readingML (acceptance: delivered mL agrees with the remaining-volume geometry)', () => {
  it('reads 0.00 mL when filled to the rim and the full graduated span at the bottom mark', () => {
    const profile = buretteProfile('burette-50', 50);
    const fullVolumeL = volumeAtHeight(profile.points, profile.graduation!.topHeightM);
    const deadVolumeL = volumeAtHeight(profile.points, profile.graduation!.bottomHeightM);
    expect(readingML(profile, fullVolumeL)).toBeCloseTo(0, 6);
    expect(readingML(profile, deadVolumeL)).toBeCloseTo(50, 6);
  });

  it('reads 10.00 mL delivered when the remaining volume is exactly capacity minus 10 mL in the graduated zone', () => {
    const profile = buretteProfile('burette-50', 50);
    const deadVolumeL = volumeAtHeight(profile.points, profile.graduation!.bottomHeightM);
    const remainingInColumnL = 0.04; // 50 mL column with 10 mL delivered leaves 40 mL in the column
    const volumeL = deadVolumeL + remainingInColumnL;

    const reading = readingML(profile, volumeL);
    expect(reading).toBeCloseTo(10, 3);

    // The meniscus height computed from the same volume must land at the same reading when fed
    // back through volumeAtHeight, i.e. the 3D fill level and the numeric readout cannot disagree.
    const meniscusHeightM = heightForVolume(profile.points, volumeL);
    const volumeFromMeniscus = volumeAtHeight(profile.points, meniscusHeightM);
    expect(readingML(profile, volumeFromMeniscus)).toBeCloseTo(reading, 3);
  });

  it('clamps reported readings to the graduated range', () => {
    const profile = buretteProfile('burette-50', 50);
    expect(readingML(profile, -1)).toBe(50);
    expect(readingML(profile, 10)).toBe(0);
  });
});

describe('heightForReadingML (inverse of readingML, used to place graduation ticks)', () => {
  it('round-trips with readingML across the graduated span of a burette', () => {
    const profile = buretteProfile('burette-50', 50);
    for (const targetML of [0, 5, 10, 25, 37.5, 50]) {
      const heightM = heightForReadingML(profile, targetML);
      const volumeL = volumeAtHeight(profile.points, heightM);
      expect(readingML(profile, volumeL)).toBeCloseTo(targetML, 2);
    }
  });

  it('agrees with the height the meniscus itself uses at a given volume', () => {
    const profile = buretteProfile('burette-50', 50);
    const deadVolumeL = volumeAtHeight(profile.points, profile.graduation!.bottomHeightM);
    const volumeL = deadVolumeL + 0.04; // 10 mL delivered, as in the readingML acceptance test above
    const reading = readingML(profile, volumeL);
    const meniscusHeightM = heightForVolume(profile.points, volumeL);
    const tickHeightM = heightForReadingML(profile, reading);
    expect(tickHeightM).toBeCloseTo(meniscusHeightM, 6);
  });

  it('clamps outside the graduated range', () => {
    const profile = buretteProfile('burette-50', 50);
    expect(heightForReadingML(profile, -10)).toBeCloseTo(heightForReadingML(profile, 0), 9);
    expect(heightForReadingML(profile, 1000)).toBeCloseTo(heightForReadingML(profile, 50), 9);
  });

  it('falls back to raw volume-based height for an ungraduated vessel', () => {
    const profile = erlenmeyerFlaskProfile('flask-250');
    expect(heightForReadingML(profile, 100)).toBeCloseTo(heightForVolume(profile.points, 0.1), 9);
  });
});

describe('builtin vessel profiles', () => {
  it('produce finite, positive capacities and non-negative radii', () => {
    for (const profile of [buretteProfile('b'), erlenmeyerFlaskProfile('f'), beakerProfile('k'), reagentBottleProfile('r')]) {
      expect(profile.capacityL).toBeGreaterThan(0);
      expect(Number.isFinite(profile.capacityL)).toBe(true);
      for (const point of profile.points) expect(point.radiusM).toBeGreaterThanOrEqual(0);
    }
  });

  it('builds a 50 mL burette whose graduated span matches the requested capacity', () => {
    const profile = buretteProfile('b', 50);
    const span = volumeAtHeight(profile.points, profile.graduation!.topHeightM) - volumeAtHeight(profile.points, profile.graduation!.bottomHeightM);
    expect(span * 1000).toBeCloseTo(50, 6);
  });
});
