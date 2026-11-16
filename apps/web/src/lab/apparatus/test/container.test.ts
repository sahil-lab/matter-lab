import { describe, expect, it } from 'vitest';
import { BEAKER_250ML_LOW_FORM } from '../definitions/beaker';
import { BURETTE_50ML_CLASS_A } from '../definitions/burette';
import { CONICAL_FLASK_250ML } from '../definitions/conicalFlask';
import { PIPETTE_25ML_VOLUMETRIC } from '../definitions/pipette';
import { REAGENT_BOTTLE_250ML } from '../definitions/reagentBottle';
import { TEST_TUBE_16X100MM } from '../definitions/testTube';
import { VOLUMETRIC_FLASK_250ML } from '../definitions/volumetricFlask';
import { buildGraduationTicks, capacityScaleFactor, containerFromProfilePoints, profileBoundingDimensions, scaleProfileRadiiForCapacity } from '../container';
import { cylinderProfile } from '../geometry/profiles';

describe('every vessel definition holds exactly its declared nominal capacity', () => {
  const cases: Array<[string, { container?: { capacityL: number } }, number]> = [
    ['burette', BURETTE_50ML_CLASS_A, 0.05],
    ['conical flask', CONICAL_FLASK_250ML, 0.25],
    ['beaker', BEAKER_250ML_LOW_FORM, 0.25],
    ['reagent bottle', REAGENT_BOTTLE_250ML, 0.25],
    ['volumetric flask', VOLUMETRIC_FLASK_250ML, 0.25],
    ['test tube', TEST_TUBE_16X100MM, 0.013],
    ['pipette', PIPETTE_25ML_VOLUMETRIC, 0.025],
  ];

  it.each(cases)('%s container.capacityL matches its nominal rating', (_label, def, expected) => {
    expect(def.container?.capacityL).toBeCloseTo(expected, 9);
  });
});

describe('containerFromProfilePoints', () => {
  it('computes the exact analytic volume of a plain cylinder', () => {
    // A 1 m tall, 0.1 m radius cylinder holds pi * r^2 * h cubic meters = 1000 * that in liters.
    const container = containerFromProfilePoints(cylinderProfile(0.1, 1));
    const expectedLiters = Math.PI * 0.1 * 0.1 * 1 * 1000;
    expect(container.capacityL).toBeCloseTo(expectedLiters, 6);
  });

  it('fillLevelForVolume and volumeForFillHeight are inverses of each other', () => {
    const container = containerFromProfilePoints(cylinderProfile(0.1, 1));
    for (const targetL of [0, 7.85, 15.7, 31.4]) {
      const { heightM } = container.fillLevelForVolume(targetL);
      expect(container.volumeForFillHeight(heightM)).toBeCloseTo(targetL, 3);
    }
  });

  it('clamps out-of-range volumes to the vessel\u2019s empty and full levels', () => {
    const container = containerFromProfilePoints(cylinderProfile(0.1, 1));
    expect(container.fillLevelForVolume(-5).heightM).toBe(0);
    expect(container.fillLevelForVolume(container.capacityL + 1000).heightM).toBeCloseTo(1, 9);
  });
});

describe('capacity calibration', () => {
  it('capacityScaleFactor brings a profile to any target capacity exactly', () => {
    const raw = cylinderProfile(0.1, 1);
    const scaled = scaleProfileRadiiForCapacity(raw, 0.5);
    expect(containerFromProfilePoints(scaled).capacityL).toBeCloseTo(0.5, 9);
  });

  it('throws on a zero-capacity profile', () => {
    expect(() => capacityScaleFactor(cylinderProfile(0, 1), 0.5)).toThrow();
  });
});

describe('profileBoundingDimensions', () => {
  it('reports twice the widest radius and the topmost height', () => {
    const bounds = profileBoundingDimensions([
      { r: 0, y: 0 },
      { r: 0.03, y: 0.1 },
      { r: 0.05, y: 0.2 },
    ]);
    expect(bounds.widthM).toBeCloseTo(0.1, 9);
    expect(bounds.heightM).toBeCloseTo(0.2, 9);
  });
});

describe('the burette\u2019s graduation', () => {
  const graduation = BURETTE_50ML_CLASS_A.graduation!;
  const container = BURETTE_50ML_CLASS_A.container!;

  it('is rated at 50.00 mL with a Class A tolerance', () => {
    expect(graduation.capacityML).toBeCloseTo(50, 1);
    expect(graduation.toleranceML).toBeCloseTo(0.05, 6);
    expect(graduation.zeroAtTop).toBe(true);
  });

  it('reads 0 mL delivered at the top (full) and the full capacity delivered at the bottom (empty)', () => {
    const ticks = buildGraduationTicks(graduation, container);
    expect(ticks.length).toBeGreaterThan(0);
    const topTick = ticks.reduce((a, b) => (a.heightM > b.heightM ? a : b));
    const bottomTick = ticks.reduce((a, b) => (a.heightM < b.heightM ? a : b));
    expect(topTick.valueML).toBeCloseTo(0, 6);
    expect(bottomTick.valueML).toBeCloseTo(graduation.capacityML, 6);
  });

  it('labels every 5 mL major tick and nothing in between', () => {
    const ticks = buildGraduationTicks(graduation, container);
    const labeled = ticks.filter((t) => t.label !== undefined);
    expect(labeled.length).toBeGreaterThan(0);
    for (const tick of labeled) {
      expect(tick.valueML % 5).toBeCloseTo(0, 6);
    }
  });
});
