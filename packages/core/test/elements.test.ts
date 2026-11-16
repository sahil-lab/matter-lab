import { describe, expect, it } from 'vitest';
import { ELEMENTS, ELEMENT_DATA_SOURCES, elementBySymbol, findElement, getElement, isAtomicNumber } from '../src';

describe('element table', () => {
  it('contains exactly the 118 recognised elements in atomic-number order', () => {
    expect(ELEMENTS).toHaveLength(118);
    ELEMENTS.forEach((e, i) => expect(e.z).toBe(i + 1));
    expect(new Set(ELEMENTS.map((e) => e.symbol)).size).toBe(118);
    expect(new Set(ELEMENTS.map((e) => e.name)).size).toBe(118);
  });

  it('looks elements up by number and symbol', () => {
    expect(getElement(6).symbol).toBe('C');
    expect(getElement(79).name).toBe('Gold');
    expect(getElement(118).symbol).toBe('Og');
    expect(elementBySymbol('cl')?.z).toBe(17);
    expect(elementBySymbol(' Fe ')?.z).toBe(26);
    expect(elementBySymbol('Xx')).toBeUndefined();
  });

  it('rejects atomic numbers outside 1-118', () => {
    for (const z of [0, 119, -1, 1.5, Number.NaN]) {
      expect(isAtomicNumber(z)).toBe(false);
      expect(findElement(z)).toBeUndefined();
      expect(() => getElement(z)).toThrow(RangeError);
    }
  });

  it('places elements in the right period, group and block', () => {
    const expected: Array<[string, number, number | null, string]> = [
      ['H', 1, 1, 's'],
      ['He', 1, 18, 's'],
      ['C', 2, 14, 'p'],
      ['Na', 3, 1, 's'],
      ['Cl', 3, 17, 'p'],
      ['Fe', 4, 8, 'd'],
      ['Zn', 4, 12, 'd'],
      ['Br', 4, 17, 'p'],
      ['Ag', 5, 11, 'd'],
      ['Ba', 6, 2, 's'],
      ['La', 6, null, 'f'],
      ['Lu', 6, null, 'f'],
      ['Hf', 6, 4, 'd'],
      ['Au', 6, 11, 'd'],
      ['Rn', 6, 18, 'p'],
      ['U', 7, null, 'f'],
      ['Rf', 7, 4, 'd'],
      ['Og', 7, 18, 'p'],
    ];
    for (const [symbol, period, group, block] of expected) {
      const e = elementBySymbol(symbol)!;
      expect([e.symbol, e.period, e.group, e.block]).toEqual([symbol, period, group, block]);
    }
  });

  it('gives every element a unique cell in the long-form table', () => {
    const cells = new Set(ELEMENTS.map((e) => `${e.tableRow}:${e.tableColumn}`));
    expect(cells.size).toBe(118);
    for (const e of ELEMENTS) {
      expect(e.tableColumn).toBeGreaterThanOrEqual(1);
      expect(e.tableColumn).toBeLessThanOrEqual(18);
      if (e.group !== null) expect([e.tableRow, e.tableColumn]).toEqual([e.period, e.group]);
    }
    expect(ELEMENTS.filter((e) => e.tableRow === 9).map((e) => e.symbol)).toEqual(
      'La Ce Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu'.split(' '),
    );
    expect(ELEMENTS.filter((e) => e.tableRow === 10)).toHaveLength(15);
  });

  it('has physically sensible values for every element', () => {
    for (const e of ELEMENTS) {
      expect(e.atomicWeight).toBeGreaterThan(1);
      expect(e.covalentRadius).toBeGreaterThan(0.2);
      expect(e.covalentRadius).toBeLessThan(3);
      expect(e.vdwRadius).toBeGreaterThanOrEqual(e.covalentRadius);
      expect(e.color).toMatch(/^#[0-9A-F]{6}$/);
      expect(e.mostCommonIsotope).toBeGreaterThanOrEqual(e.z);
      expect(e.valenceUnconstrained || e.valences.length > 0).toBe(true);
    }
    const weights = ELEMENTS.map((e) => e.atomicWeight);
    const inversions = weights.filter((w, i) => i > 0 && w < weights[i - 1]!).length;
    // The known atomic-weight inversions: Ar/K, Co/Ni, Te/I, Th/Pa, U/Np, Pu/Am and a few superheavies.
    expect(inversions).toBeLessThan(12);
  });

  it('matches well-established reference values', () => {
    expect(getElement(1).atomicWeight).toBeCloseTo(1.008, 3);
    expect(getElement(6).atomicWeight).toBeCloseTo(12.011, 3);
    expect(getElement(8).atomicWeight).toBeCloseTo(15.999, 3);
    expect(getElement(6).mostCommonIsotopeMass).toBe(12);
    expect(getElement(6).valences).toEqual([4]);
    expect(getElement(7).valences).toEqual([3]);
    expect(getElement(8).valences).toEqual([2]);
    expect(getElement(16).valences).toEqual([2, 4, 6]);
    expect(getElement(9).electronegativityPauling).toBeCloseTo(3.98, 2);
    expect(getElement(80).standardState).toBe('liquid');
    expect(getElement(35).standardState).toBe('liquid');
    expect(getElement(2).category).toBe('noble-gas');
  });

  it('flags predicted or missing data instead of inventing it', () => {
    const og = getElement(118);
    expect(og.standardStatePredicted).toBe(true);
    expect(og.electronConfigurationPredicted).toBe(true);
    expect(og.meltingPointK).toBeNull();
    expect(og.colorSource).toBe('fallback');
    expect(getElement(68).colorSource).toBe('jmol');
  });

  it('records where the data came from', () => {
    expect(ELEMENT_DATA_SOURCES.map((s) => s.id)).toEqual(
      expect.arrayContaining(['pubchem-periodic-table', 'rdkit-periodic-table']),
    );
    for (const s of ELEMENT_DATA_SOURCES) expect(s.url).toMatch(/^https:\/\//);
  });
});
