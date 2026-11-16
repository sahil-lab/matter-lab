import { describe, expect, it } from 'vitest';
import { BufferAttribute } from 'three';
import { STILL_MENISCUS, applyMeniscusDisplacement, buildMeniscusDisc, meniscusDisplacement } from './meniscusSurface';

describe('buildMeniscusDisc', () => {
  it('produces a flat (y=0) disc whose vertices never exceed the requested radius', () => {
    const geometry = buildMeniscusDisc(0.03, 4, 16);
    const position = geometry.getAttribute('position') as BufferAttribute;
    expect(position.count).toBeGreaterThan(1);
    for (let i = 0; i < position.count; i++) {
      expect(position.getY(i)).toBe(0);
      const r = Math.hypot(position.getX(i), position.getZ(i));
      expect(r).toBeLessThanOrEqual(0.03 + 1e-9);
    }
  });

  it('includes a centre vertex at the origin', () => {
    const geometry = buildMeniscusDisc(0.02, 3, 12);
    const position = geometry.getAttribute('position') as BufferAttribute;
    expect(position.getX(0)).toBe(0);
    expect(position.getZ(0)).toBe(0);
  });
});

describe('meniscusDisplacement', () => {
  it('is zero everywhere for a zero-radius (empty) vessel', () => {
    expect(meniscusDisplacement(0, 0, 0, 5, STILL_MENISCUS)).toBe(0);
  });

  it('is deepest at the centre and relaxes to zero at the wall when still', () => {
    const centre = meniscusDisplacement(0, 0, 0.03, 0, STILL_MENISCUS);
    const wall = meniscusDisplacement(0.03, 0, 0.03, 0, STILL_MENISCUS);
    expect(centre).toBeCloseTo(-STILL_MENISCUS.dipDepthM, 9);
    expect(wall).toBeCloseTo(0, 9);
    expect(centre).toBeLessThan(wall);
  });

  it('does not depend on time when agitation is zero', () => {
    const a = meniscusDisplacement(0.01, 1.2, 0.03, 0, STILL_MENISCUS);
    const b = meniscusDisplacement(0.01, 1.2, 0.03, 50, STILL_MENISCUS);
    expect(a).toBeCloseTo(b, 12);
  });

  it('varies with time once agitation is positive (decorative motion only)', () => {
    const agitated = { dipDepthM: 0.0005, agitation: 1, swirlSpeedRadPerS: 2 };
    const a = meniscusDisplacement(0.02, 0.4, 0.03, 0, agitated);
    const b = meniscusDisplacement(0.02, 0.4, 0.03, 1, agitated);
    expect(a).not.toBeCloseTo(b, 6);
  });
});

describe('applyMeniscusDisplacement', () => {
  it('moves every vertex to a finite height and recomputes normals without throwing', () => {
    const geometry = buildMeniscusDisc(0.025, 4, 16);
    applyMeniscusDisplacement(geometry, 0.025, 3, { dipDepthM: 0.0004, agitation: 0.6, swirlSpeedRadPerS: 1.5 });
    const position = geometry.getAttribute('position') as BufferAttribute;
    for (let i = 0; i < position.count; i++) expect(Number.isFinite(position.getY(i))).toBe(true);
    expect(geometry.getAttribute('normal')).toBeDefined();
  });
});
