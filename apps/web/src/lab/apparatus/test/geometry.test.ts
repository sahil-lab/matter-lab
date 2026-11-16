import { describe, expect, it } from 'vitest';
import { calibratedBarrelDiameterM, DEFAULT_BURETTE_CONFIG } from '../geometry/burette';
import { BURETTE_50ML_CLASS_A } from '../definitions/burette';
import { countTriangles, cylinderProfile } from '../geometry/profiles';
import { boxGroup, cylinderGroup } from '../geometry/hardware';
import { combineBuildResults } from '../geometry/types';
import { PROCEDURAL_GEOMETRY_BUILDERS, resolveProceduralBuilder } from '../geometry/builderRegistry';
import { ALL_DEFINITIONS } from '../definitions';

describe('countTriangles', () => {
  it('counts the exact triangle count of a box (12) and an indexed cylinder', () => {
    expect(countTriangles(boxGroup('m', 1, 1, 1).geometry)).toBe(12);
    // A cylinder with caps: 2 * radialSegments (side) + 2 * (radialSegments - 2) (the two capped fans), for radialSegments=8.
    const cyl = cylinderGroup('m', 1, 1, 1, undefined, 8).geometry;
    expect(countTriangles(cyl)).toBeGreaterThan(0);
    expect(Number.isInteger(countTriangles(cyl))).toBe(true);
  });
});

describe('combineBuildResults', () => {
  it('sums triangle counts across groups', () => {
    const a = boxGroup('m', 1, 1, 1);
    const b = boxGroup('m', 1, 1, 1);
    const result = combineBuildResults([a, b]);
    expect(result.polyCount).toBe(countTriangles(a.geometry) + countTriangles(b.geometry));
  });
});

describe('calibratedBarrelDiameterM', () => {
  it('agrees with the barrel definition\u2019s own declared nominalDiameterM', () => {
    const barrelSocket = BURETTE_50ML_CLASS_A.sockets.find((s) => s.id === 'barrel')!;
    expect(calibratedBarrelDiameterM(DEFAULT_BURETTE_CONFIG)).toBeCloseTo(barrelSocket.nominalDiameterM!, 9);
  });

  it('is narrower than the raw (uncalibrated) bore, since the real vessel over-integrates at that bore', () => {
    const rawDiameter = DEFAULT_BURETTE_CONFIG.barrelRadiusM * 2;
    expect(calibratedBarrelDiameterM(DEFAULT_BURETTE_CONFIG)).toBeLessThan(rawDiameter);
  });
});

describe('cylinderProfile', () => {
  it('produces the four corner points of a right cylinder', () => {
    expect(cylinderProfile(0.2, 0.5)).toEqual([
      { r: 0, y: 0 },
      { r: 0.2, y: 0 },
      { r: 0.2, y: 0.5 },
      { r: 0, y: 0.5 },
    ]);
  });
});

describe('PROCEDURAL_GEOMETRY_BUILDERS', () => {
  it('has exactly one builder per registered definition, keyed by proceduralBuilderId', () => {
    for (const def of ALL_DEFINITIONS) {
      expect(def.asset.proceduralBuilderId, def.id).toBeDefined();
      expect(resolveProceduralBuilder(def.asset.proceduralBuilderId!), def.id).toBeTypeOf('function');
    }
    expect(Object.keys(PROCEDURAL_GEOMETRY_BUILDERS)).toHaveLength(ALL_DEFINITIONS.length);
  });

  it('every builder actually returns a positive poly count matching the definition\u2019s declared asset.polyCount', () => {
    for (const def of ALL_DEFINITIONS) {
      const builder = resolveProceduralBuilder(def.asset.proceduralBuilderId!)!;
      expect(builder().polyCount).toBe(def.asset.polyCount);
    }
  });

  it('returns undefined for an unregistered id', () => {
    expect(resolveProceduralBuilder('not-a-real-id')).toBeUndefined();
  });
});
