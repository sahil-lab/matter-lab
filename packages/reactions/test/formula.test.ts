import { ELECTRON_MASS_U, ELEMENTS, elementBySymbol } from '@matterlab/core';
import { describe, expect, it } from 'vitest';
import { ChemicalSyntaxError, hillFormula, molarMass, parseFormula } from '../src';

const weight = (symbol: string): number => {
  const element = elementBySymbol(symbol);
  if (!element || element.symbol !== symbol) throw new Error(`no element ${symbol}`);
  return element.atomicWeight;
};

describe('parseFormula', () => {
  it('reads simple formulas and keeps the order of first appearance', () => {
    expect(parseFormula('H2O')).toEqual({ elements: { H: 2, O: 1 }, charge: 0 });
    expect(parseFormula('C6H12O6')).toEqual({ elements: { C: 6, H: 12, O: 6 }, charge: 0 });
    expect(Object.keys(parseFormula('NaHCO3').elements)).toEqual(['Na', 'H', 'C', 'O']);
    expect(parseFormula('  O2 ')).toEqual({ elements: { O: 2 }, charge: 0 });
  });

  it('adds up repeated elements', () => {
    expect(parseFormula('CH3COOH')).toEqual({ elements: { C: 2, H: 4, O: 2 }, charge: 0 });
    expect(parseFormula('C6H5CH3')).toEqual({ elements: { C: 7, H: 8 }, charge: 0 });
  });

  it('distinguishes symbols by case', () => {
    expect(parseFormula('CO')).toEqual({ elements: { C: 1, O: 1 }, charge: 0 });
    expect(parseFormula('Co')).toEqual({ elements: { Co: 1 }, charge: 0 });
    expect(parseFormula('HF')).toEqual({ elements: { H: 1, F: 1 }, charge: 0 });
    expect(parseFormula('Hf')).toEqual({ elements: { Hf: 1 }, charge: 0 });
  });

  it('reads every element symbol of the periodic table', () => {
    for (const element of ELEMENTS) {
      expect(parseFormula(`${element.symbol}2`).elements).toEqual({ [element.symbol]: 2 });
    }
  });

  it('expands nested round, square and curly brackets', () => {
    expect(parseFormula('Ca(OH)2').elements).toEqual({ Ca: 1, O: 2, H: 2 });
    expect(parseFormula('Ca3(PO4)2').elements).toEqual({ Ca: 3, P: 2, O: 8 });
    expect(parseFormula('(NH4)2SO4').elements).toEqual({ N: 2, H: 8, S: 1, O: 4 });
    expect(parseFormula('K4[Fe(CN)6]').elements).toEqual({ K: 4, Fe: 1, C: 6, N: 6 });
    expect(parseFormula('[Co(NH3)5Cl]Cl2').elements).toEqual({ Co: 1, N: 5, H: 15, Cl: 3 });
    expect(parseFormula('Al2(SO4)3').elements).toEqual({ Al: 2, S: 3, O: 12 });
    expect(parseFormula('{[Fe(CN)6]2Cu3}').elements).toEqual({ Fe: 2, C: 12, N: 12, Cu: 3 });
    expect(parseFormula('((CH3)3C)2O').elements).toEqual({ C: 8, H: 18, O: 1 });
  });

  it('reads hydrates written with a dot, a middle dot or an asterisk', () => {
    const expected = { Cu: 1, S: 1, O: 9, H: 10 };
    expect(parseFormula('CuSO4.5H2O').elements).toEqual(expected);
    expect(parseFormula('CuSO4\u00b75H2O').elements).toEqual(expected);
    expect(parseFormula('CuSO4*5H2O').elements).toEqual(expected);
    expect(parseFormula('CuSO4 \u00b7 5 H2O').elements).toEqual(expected);
    expect(parseFormula('CaSO4.2H2O').elements).toEqual({ Ca: 1, S: 1, O: 6, H: 4 });
    expect(parseFormula('Na2CO3.10H2O').elements).toEqual({ Na: 2, C: 1, O: 13, H: 20 });
    expect(parseFormula('MgSO4.H2O').elements).toEqual({ Mg: 1, S: 1, O: 5, H: 2 });
    expect(parseFormula('KAl(SO4)2.12H2O').elements).toEqual({ K: 1, Al: 1, S: 2, O: 20, H: 24 });
  });

  it('reads charges in every supported notation', () => {
    expect(parseFormula('NH4+')).toEqual({ elements: { N: 1, H: 4 }, charge: 1 });
    expect(parseFormula('Cl-')).toEqual({ elements: { Cl: 1 }, charge: -1 });
    expect(parseFormula('SO4^2-')).toEqual({ elements: { S: 1, O: 4 }, charge: -2 });
    expect(parseFormula('Fe^3+')).toEqual({ elements: { Fe: 1 }, charge: 3 });
    expect(parseFormula('Fe^+3').charge).toBe(3);
    expect(parseFormula('PO4^-3').charge).toBe(-3);
    expect(parseFormula('Na^+').charge).toBe(1);
    expect(parseFormula('SO4-2').charge).toBe(-2);
    expect(parseFormula('Hg2+2')).toEqual({ elements: { Hg: 2 }, charge: 2 });
    expect(parseFormula('Ca++').charge).toBe(2);
    expect(parseFormula('O--').charge).toBe(-2);
    expect(parseFormula('H3O+')).toEqual({ elements: { H: 3, O: 1 }, charge: 1 });
    expect(parseFormula('Al(OH)4-')).toEqual({ elements: { Al: 1, O: 4, H: 4 }, charge: -1 });
    expect(parseFormula('[Fe(CN)6]^4-')).toEqual({ elements: { Fe: 1, C: 6, N: 6 }, charge: -4 });
    expect(parseFormula('[Cu(NH3)4]^2+').charge).toBe(2);
    expect(parseFormula('Cr2O7^2-')).toEqual({ elements: { Cr: 2, O: 7 }, charge: -2 });
    expect(parseFormula('I3^-')).toEqual({ elements: { I: 3 }, charge: -1 });
  });

  it('reads Unicode subscripts, superscripts and minus signs', () => {
    expect(parseFormula('H\u2082O')).toEqual({ elements: { H: 2, O: 1 }, charge: 0 });
    expect(parseFormula('SO\u2084\u00b2\u207b')).toEqual({ elements: { S: 1, O: 4 }, charge: -2 });
    expect(parseFormula('Fe\u00b3\u207a')).toEqual({ elements: { Fe: 1 }, charge: 3 });
    expect(parseFormula('NH\u2084\u207a')).toEqual({ elements: { N: 1, H: 4 }, charge: 1 });
    expect(parseFormula('Cl\u2212')).toEqual({ elements: { Cl: 1 }, charge: -1 });
    expect(parseFormula('C\u2081\u2082H\u2082\u2082O\u2081\u2081').elements).toEqual({ C: 12, H: 22, O: 11 });
  });

  it('reads the electron', () => {
    expect(parseFormula('e-')).toEqual({ elements: {}, charge: -1 });
    expect(parseFormula('e^-')).toEqual({ elements: {}, charge: -1 });
    expect(parseFormula('e\u207b')).toEqual({ elements: {}, charge: -1 });
  });

  it('returns frozen results', () => {
    const parsed = parseFormula('H2O');
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.elements)).toBe(true);
  });

  it('rejects unknown symbols and bad syntax with a message that names the problem', () => {
    const cases: Array<[string, RegExp]> = [
      ['', /empty/i],
      ['   ', /empty/i],
      ['Xx2', /Unknown element symbol "Xx"/],
      ['Zz', /Unknown element symbol "Zz"/],
      ['NaCL', /Unknown element symbol "L"/],
      ['D2O', /Unknown element symbol "D"/],
      ['h2o', /capital letter/],
      ['H2O)', /Unmatched "\)"/],
      ['(H2O', /never closed/],
      ['Ca(OH]2', /Expected "\)" but found "\]"/],
      ['Ca()2', /Empty brackets/],
      ['2H2O', /cannot start with a number/],
      ['H0', /zero/],
      ['H2 O', /Unexpected space/],
      ['CH2=CH2', /Unexpected "="/],
      ['H2O^', /Unexpected "\^"/],
      ['Fe^0+', /non-zero/],
      ['e', /electron/],
      ['e+', /electron/],
      ['CuSO4.', /Expected an element symbol/],
      ['CuSO4..5H2O', /Expected an element symbol/],
      ['H2O(l)', /phase label/],
      ['NaCl(aq)', /phase label/],
      ['Na+Cl-', /Unexpected "\+"/],
    ];
    for (const [input, pattern] of cases) {
      expect(() => parseFormula(input), input).toThrow(ChemicalSyntaxError);
      expect(() => parseFormula(input), input).toThrow(pattern);
    }
  });

  it('refuses an ambiguous charge instead of guessing', () => {
    // Is "Fe3+" three iron atoms with one charge, or one iron atom with three?
    for (const input of ['Fe3+', 'O2-', 'Cu2+', 'I3-', 'SO42-', '[Fe(CN)6]4-', '(SO4)2-']) {
      expect(() => parseFormula(input), input).toThrow(/Ambiguous charge/);
    }
    expect(() => parseFormula('Fe3+')).toThrow(/"Fe3\^\+" \(charge 1\+\) or "Fe\^3\+" \(charge 3\+\)/);
    expect(() => parseFormula('SO42-')).toThrow(/"SO4\^2-"/);
    // The count plainly belongs to one atom among several, so these are not ambiguous.
    expect(parseFormula('NO3-').charge).toBe(-1);
    expect(parseFormula('MnO4-').charge).toBe(-1);
    expect(parseFormula('HSO4-').charge).toBe(-1);
  });

  it('reports the offending text on the error', () => {
    try {
      parseFormula('Xx2');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ChemicalSyntaxError);
      expect((error as ChemicalSyntaxError).input).toBe('Xx2');
      expect((error as ChemicalSyntaxError).position).toBe(0);
    }
  });
});

describe('molarMass', () => {
  it('sums the standard atomic weights of the element table', () => {
    expect(molarMass('H2O')).toBeCloseTo(2 * weight('H') + weight('O'), 12);
    expect(molarMass('CO2')).toBeCloseTo(weight('C') + 2 * weight('O'), 12);
    expect(molarMass('C6H12O6')).toBeCloseTo(6 * weight('C') + 12 * weight('H') + 6 * weight('O'), 10);
    expect(molarMass('Ca3(PO4)2')).toBeCloseTo(3 * weight('Ca') + 2 * weight('P') + 8 * weight('O'), 10);
    expect(molarMass('K4[Fe(CN)6]')).toBeCloseTo(4 * weight('K') + weight('Fe') + 6 * weight('C') + 6 * weight('N'), 10);
    expect(molarMass('CuSO4.5H2O')).toBeCloseTo(weight('Cu') + weight('S') + 9 * weight('O') + 10 * weight('H'), 10);
    expect(molarMass('U3O8')).toBeCloseTo(3 * weight('U') + 8 * weight('O'), 10);
  });

  it('gives each element its own atomic weight', () => {
    for (const element of ELEMENTS) expect(molarMass(element.symbol)).toBe(element.atomicWeight);
  });

  it('accepts a parsed formula', () => {
    expect(molarMass(parseFormula('NaCl'))).toBeCloseTo(weight('Na') + weight('Cl'), 12);
  });

  it('accounts for the electrons of an ion, so that mass is conserved across a half-reaction', () => {
    expect(molarMass('e-')).toBe(ELECTRON_MASS_U);
    expect(molarMass('Na+')).toBeCloseTo(weight('Na') - ELECTRON_MASS_U, 12);
    expect(molarMass('SO4^2-')).toBeCloseTo(weight('S') + 4 * weight('O') + 2 * ELECTRON_MASS_U, 12);
    expect(molarMass('Fe^3+') + molarMass('e-')).toBeCloseTo(molarMass('Fe^2+'), 12);
  });
});

describe('hillFormula', () => {
  it('orders carbon, hydrogen, then the rest alphabetically', () => {
    expect(hillFormula('CH3CH2OH')).toBe('C2H6O');
    expect(hillFormula('C2H5OH')).toBe('C2H6O');
    expect(hillFormula('NaHCO3')).toBe('CHNaO3');
    expect(hillFormula('CO2')).toBe('CO2');
  });

  it('is purely alphabetical without carbon', () => {
    expect(hillFormula('H2SO4')).toBe('H2O4S');
    expect(hillFormula('NaCl')).toBe('ClNa');
    expect(hillFormula('Ca(OH)2')).toBe('CaH2O2');
  });

  it('appends the charge, so ions of the same composition differ', () => {
    expect(hillFormula('SO4^2-')).toBe('O4S^2-');
    expect(hillFormula('OH-')).toBe('HO-');
    expect(hillFormula('HO-')).toBe('HO-');
    expect(hillFormula('NH4+')).toBe('H4N+');
    expect(hillFormula('Fe^3+')).not.toBe(hillFormula('Fe^2+'));
    expect(hillFormula('e-')).toBe('e-');
  });
});
