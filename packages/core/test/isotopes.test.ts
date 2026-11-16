import { describe, expect, it } from 'vitest';
import {
  ELEMENTS,
  ISOTOPE_DATA_SOURCE,
  describeStability,
  findIsotope,
  formatHalfLife,
  getIsotopes,
  isotopeMass,
  naturalIsotopes,
  representativeIsotope,
} from '../src';

const YEAR = 3.15576e7;

describe('isotope table', () => {
  it('covers every element and thousands of evaluated nuclides', () => {
    let total = 0;
    for (const e of ELEMENTS) {
      const isotopes = getIsotopes(e.z);
      expect(isotopes.length).toBeGreaterThan(0);
      total += isotopes.length;
      for (let i = 1; i < isotopes.length; i++) expect(isotopes[i]!.a).toBeGreaterThan(isotopes[i - 1]!.a);
      for (const iso of isotopes) expect(iso.a).toBe(iso.z + iso.n);
    }
    expect(total).toBeGreaterThan(3000);
  });

  it('defines carbon-12 as exactly 12 u and carries evaluated masses for neighbours', () => {
    expect(isotopeMass(6, 6)).toBe(12);
    expect(isotopeMass(6, 7)).toBeCloseTo(13.0033548, 5);
    expect(isotopeMass(1, 0)).toBeCloseTo(1.007825, 5);
    expect(isotopeMass(1, 1)).toBeCloseTo(2.0141018, 5);
    expect(isotopeMass(8, 8)).toBeCloseTo(15.9949146, 5);
    expect(isotopeMass(6, 500)).toBeNull();
  });

  it('reports natural abundances that sum to 100% for each naturally occurring element', () => {
    for (const e of ELEMENTS) {
      const natural = naturalIsotopes(e.z);
      if (natural.length === 0) continue;
      const sum = natural.reduce((s, iso) => s + iso.abundance!, 0);
      expect(sum, `${e.symbol} abundances`).toBeGreaterThan(0.998);
      expect(sum, `${e.symbol} abundances`).toBeLessThan(1.002);
    }
    const carbon = naturalIsotopes(6);
    expect(carbon.map((i) => i.a)).toEqual([12, 13]);
    expect(carbon[1]!.abundance).toBeGreaterThan(0.0095);
    expect(carbon[1]!.abundance).toBeLessThan(0.0116);
    expect(naturalIsotopes(50).filter((i) => i.stability === 'S')).toHaveLength(10);
  });

  it('distinguishes stable from radioactive nuclides', () => {
    expect(findIsotope(6, 6)?.stability).toBe('S');
    const c14 = findIsotope(6, 8)!;
    expect(c14.stability).toBe('R');
    expect(c14.halfLifeSeconds! / YEAR).toBeGreaterThan(5600);
    expect(c14.halfLifeSeconds! / YEAR).toBeLessThan(5800);
    expect(c14.decayMode).toBe('B-');

    const tritium = findIsotope(1, 2)!;
    expect(tritium.halfLifeSeconds! / YEAR).toBeCloseTo(12.32, 1);

    const u238 = findIsotope(92, 146)!;
    expect(u238.halfLifeSeconds! / YEAR / 1e9).toBeCloseTo(4.468, 2);
    expect(u238.decayMode).toBe('A');

    // Technetium and promethium have no stable isotope.
    for (const z of [43, 61]) expect(getIsotopes(z).some((i) => i.stability === 'S')).toBe(false);
    for (let z = 84; z <= 118; z++) expect(getIsotopes(z).some((i) => i.stability === 'S')).toBe(false);
  });

  it('agrees with the element table about the most common isotope of naturally occurring elements', () => {
    for (const e of ELEMENTS) {
      if (naturalIsotopes(e.z).length === 0) continue;
      expect(representativeIsotope(e.z)!.a, e.symbol).toBe(e.mostCommonIsotope);
    }
    expect(representativeIsotope(43)!.stability).toBe('R');
  });

  it('formats half-lives with readable units', () => {
    expect(formatHalfLife(5700 * YEAR)).toBe('5.7 ky');
    expect(formatHalfLife(12.32 * YEAR)).toBe('12.3 y');
    expect(formatHalfLife(613.9)).toBe('10.2 min');
    expect(formatHalfLife(0.00058)).toBe('580 µs');
    expect(formatHalfLife(4.468e9 * YEAR)).toBe('4.47 Gy');
    expect(formatHalfLife(Number.NaN)).toBe('unknown');
    expect(describeStability(findIsotope(6, 6)!)).toBe('Stable');
    expect(describeStability(findIsotope(6, 8)!)).toBe('Half-life 5.7 ky (B-)');
  });

  it('records its provenance', () => {
    expect(ISOTOPE_DATA_SOURCE.source).toMatch(/IAEA/);
    expect(ISOTOPE_DATA_SOURCE.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(ISOTOPE_DATA_SOURCE.citations!.length).toBeGreaterThan(0);
  });
});
