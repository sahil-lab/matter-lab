import { describe, expect, it } from 'vitest';
import {
  BURETTE_CAPACITY_ML,
  DEFAULT_TITRATION_FIXTURE,
  buretteLevelsScene,
  clearLiquidScene,
  devOnlyTitrationPh,
  endpointTitrationProfiles,
  equivalenceVolumeMl,
  swirlingScene,
  tintedLiquidScene,
} from './fixtures';

describe('devOnlyTitrationPh (dev-harness fixture, not production chemistry)', () => {
  it('reads close to the strong-acid starting pH before any base is delivered', () => {
    const ph = devOnlyTitrationPh(DEFAULT_TITRATION_FIXTURE, 0);
    expect(ph).toBeCloseTo(1.0, 2); // 0.1 mol/L HCl: pH ~= 1
  });

  it('reads pH 7 at the exact equivalence point, matching the shared contract vertical slice', () => {
    const equivalenceL = equivalenceVolumeMl(DEFAULT_TITRATION_FIXTURE) / 1000;
    const ph = devOnlyTitrationPh(DEFAULT_TITRATION_FIXTURE, equivalenceL);
    expect(ph).toBeCloseTo(7.0, 6);
  });

  it('rises monotonically as more base is delivered', () => {
    let previous = -Infinity;
    for (let ml = 0; ml <= 50; ml += 2) {
      const ph = devOnlyTitrationPh(DEFAULT_TITRATION_FIXTURE, ml / 1000);
      expect(ph).toBeGreaterThanOrEqual(previous);
      previous = ph;
    }
  });

  it('approaches a high pH well past equivalence (excess strong base)', () => {
    const ph = devOnlyTitrationPh(DEFAULT_TITRATION_FIXTURE, 0.05); // 2x the equivalence volume
    expect(ph).toBeGreaterThan(11.5);
  });
});

describe('equivalenceVolumeMl', () => {
  it('matches the shared contract vertical slice (25.00 mL for 0.100 mol/L HCl/NaOH, 25 mL aliquot)', () => {
    expect(equivalenceVolumeMl(DEFAULT_TITRATION_FIXTURE)).toBeCloseTo(25, 9);
  });
});

describe('regression scenario fixtures', () => {
  it('clearLiquidScene and tintedLiquidScene each produce one vessel within its own capacity', () => {
    for (const scene of [clearLiquidScene(), tintedLiquidScene()]) {
      expect(scene).toHaveLength(1);
      expect(scene[0]!.volumeL).toBeGreaterThan(0);
      expect(scene[0]!.volumeL).toBeLessThanOrEqual(scene[0]!.profile.capacityL);
    }
  });

  it('buretteLevelsScene produces three distinctly positioned, non-overlapping burettes', () => {
    const scene = buretteLevelsScene();
    expect(scene).toHaveLength(3);
    const xPositions = scene.map((v) => v.positionM[0]);
    expect(new Set(xPositions).size).toBe(3);
    for (const vessel of scene) expect(vessel.volumeL).toBeGreaterThan(0);
  });

  it('swirlingScene has a positive agitation (otherwise it is not actually swirling)', () => {
    expect(swirlingScene()[0]!.agitation).toBeGreaterThan(0);
  });

  it('endpointTitrationProfiles supplies a burette matching the fixture capacity and a flask', () => {
    const { burette, flask } = endpointTitrationProfiles();
    expect(burette.graduation!.maxML).toBeCloseTo(BURETTE_CAPACITY_ML, 9);
    expect(flask.capacityL).toBeGreaterThan(0);
  });
});
