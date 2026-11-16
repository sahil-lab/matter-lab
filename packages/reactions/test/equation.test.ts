import { describe, expect, it } from 'vitest';
import { ChemicalSyntaxError, checkConservation, formatEquation, parseEquation, reverseEquation, scaleEquation } from '../src';
import type { ReactionEquation } from '../src';

const summary = (eq: ReactionEquation): { reactants: string[]; products: string[] } => {
  const term = (t: ReactionEquation['reactants'][number]): string => `${t.coefficient} ${t.formula}${t.phase ? `(${t.phase})` : ''}`;
  return { reactants: eq.reactants.map(term), products: eq.products.map(term) };
};

describe('parseEquation', () => {
  it('reads coefficients, formulas and phase labels', () => {
    const eq = parseEquation('2 H2(g) + O2(g) -> 2 H2O(l)');
    expect(summary(eq)).toEqual({ reactants: ['2 H2(g)', '1 O2(g)'], products: ['2 H2O(l)'] });
    expect(eq.reversible).toBe(false);
    expect(eq.reactants[0]!.parsed).toEqual({ elements: { H: 2 }, charge: 0 });
    expect(eq.products[0]!.phase).toBe('l');
    expect(eq.reactants[1]!.coefficient).toBe(1);
  });

  it('accepts every arrow form', () => {
    for (const arrow of ['->', '=>', '=', '\u2192', '\u27f6', '\u21d2']) {
      const eq = parseEquation(`N2 + 3 H2 ${arrow} 2 NH3`);
      expect(summary(eq), arrow).toEqual({ reactants: ['1 N2', '3 H2'], products: ['2 NH3'] });
      expect(eq.reversible, arrow).toBe(false);
    }
    for (const arrow of ['<=>', '<->', '\u21cc', '\u21c4', '\u21cb', '\u2194']) {
      const eq = parseEquation(`N2 + 3 H2 ${arrow} 2 NH3`);
      expect(summary(eq), arrow).toEqual({ reactants: ['1 N2', '3 H2'], products: ['2 NH3'] });
      expect(eq.reversible, arrow).toBe(true);
    }
  });

  it('reads whole-number, decimal and fractional coefficients, with or without a space', () => {
    expect(summary(parseEquation('H2 + 1/2 O2 -> H2O')).reactants).toEqual(['1 H2', '0.5 O2']);
    expect(summary(parseEquation('H2 + 0.5 O2 -> H2O')).reactants).toEqual(['1 H2', '0.5 O2']);
    expect(summary(parseEquation('2H2+O2->2H2O'))).toEqual({ reactants: ['2 H2', '1 O2'], products: ['2 H2O'] });
    expect(parseEquation('C2H6 + 7/2 O2 -> 2 CO2 + 3 H2O').reactants[1]!.coefficient).toBe(3.5);
    expect(parseEquation('12 H2O -> 12 H2O').reactants[0]!.coefficient).toBe(12);
  });

  it('reads the four phase labels and treats (cr) as solid', () => {
    const eq = parseEquation('CaCO3(s) + 2 H+(aq) -> Ca^2+(aq) + CO2(g) + H2O(l)');
    expect(eq.reactants.map((t) => t.phase)).toEqual(['s', 'aq']);
    expect(eq.products.map((t) => t.phase)).toEqual(['aq', 'g', 'l']);
    expect(parseEquation('C(cr) + O2(g) -> CO2(g)').reactants[0]!.phase).toBe('s');
    expect(parseEquation('H2O (l) -> H2O (g)').reactants[0]!.phase).toBe('l');
    expect(parseEquation('H2 + Cl2 -> 2 HCl').reactants[0]!.phase).toBeUndefined();
  });

  it('tells a charge from the plus sign between terms', () => {
    expect(summary(parseEquation('Na+ + Cl- -> NaCl'))).toEqual({ reactants: ['1 Na+', '1 Cl-'], products: ['1 NaCl'] });
    expect(summary(parseEquation('Na++Cl-->NaCl'))).toEqual({ reactants: ['1 Na+', '1 Cl-'], products: ['1 NaCl'] });
    expect(summary(parseEquation('H+(aq) + OH-(aq) -> H2O(l)'))).toEqual({ reactants: ['1 H+(aq)', '1 OH-(aq)'], products: ['1 H2O(l)'] });
    expect(summary(parseEquation('H+(aq)+OH-(aq)->H2O(l)'))).toEqual({ reactants: ['1 H+(aq)', '1 OH-(aq)'], products: ['1 H2O(l)'] });
    expect(summary(parseEquation('Fe^3+ + e- -> Fe^2+'))).toEqual({ reactants: ['1 Fe^3+', '1 e-'], products: ['1 Fe^2+'] });
    expect(summary(parseEquation('2 H+ + 2 e- -> H2'))).toEqual({ reactants: ['2 H+', '2 e-'], products: ['1 H2'] });
    expect(summary(parseEquation('Ca++ + 2 Cl- -> CaCl2'))).toEqual({ reactants: ['1 Ca++', '2 Cl-'], products: ['1 CaCl2'] });
    expect(summary(parseEquation('AgCl -> Ag+ + Cl-'))).toEqual({ reactants: ['1 AgCl'], products: ['1 Ag+', '1 Cl-'] });
    expect(parseEquation('Ag+ + Cl- -> AgCl').reactants.map((t) => t.parsed.charge)).toEqual([1, -1]);
  });

  it('reads the charge notation of the CODATA table', () => {
    const eq = parseEquation('Zn + Cu+2 -> Zn+2 + Cu');
    expect(summary(eq)).toEqual({ reactants: ['1 Zn', '1 Cu+2'], products: ['1 Zn+2', '1 Cu'] });
    expect(eq.reactants[1]!.parsed).toEqual({ elements: { Cu: 1 }, charge: 2 });
    expect(parseEquation('Cu+2(aq) + SO4-2(aq) -> CuSO4(s)').reactants.map((t) => t.parsed.charge)).toEqual([2, -2]);
    expect(summary(parseEquation('Fe+3+3e-->Fe')).reactants).toEqual(['1 Fe+3', '3 e-']);
    // A number that starts the next term is a coefficient, not a charge.
    expect(summary(parseEquation('H2+2O2->2H2O2')).reactants).toEqual(['1 H2', '2 O2']);
  });

  it('reads Unicode subscripts, superscripts and hydrates inside an equation', () => {
    const eq = parseEquation('CuSO\u2084\u00b75H\u2082O \u2192 Cu\u00b2\u207a + SO\u2084\u00b2\u207b + 5 H\u2082O');
    expect(eq.reactants[0]!.parsed.elements).toEqual({ Cu: 1, S: 1, O: 9, H: 10 });
    expect(eq.products.map((t) => t.parsed.charge)).toEqual([2, -2, 0]);
    expect(eq.products[2]!.coefficient).toBe(5);
  });

  it('rejects malformed equations with a descriptive error', () => {
    const cases: Array<[string, RegExp]> = [
      ['', /empty/i],
      ['H2 + O2', /No reaction arrow/],
      ['H2 -> H2O -> O2', /More than one reaction arrow/],
      ['-> H2O', /before the arrow/],
      ['H2 + O2 ->', /after the arrow/],
      ['H2 + + O2 -> H2O', /term is missing/],
      ['H2 + -> H2O', /term is missing/],
      ['+ H2 -> H2O', /term is missing/],
      ['2 -> H2O', /not followed by a formula/],
      ['0 H2 + O2 -> H2O', /must be positive/],
      ['H2 + Xx -> H2O', /Unknown element symbol "Xx"/],
      ['H2 + (g) -> H2O', /Empty brackets|capital letter|phase label/],
      ['Fe3+ + e- -> Fe2+', /Ambiguous charge/],
    ];
    for (const [input, pattern] of cases) {
      expect(() => parseEquation(input), input).toThrow(ChemicalSyntaxError);
      expect(() => parseEquation(input), input).toThrow(pattern);
    }
  });
});

describe('formatEquation', () => {
  it('writes a form that parses back to the same equation', () => {
    for (const text of [
      '2 H2(g) + O2(g) -> 2 H2O(l)',
      'N2(g) + 3 H2(g) <=> 2 NH3(g)',
      'H2 + 1/2 O2 -> H2O',
      'MnO4- + 5 Fe^2+ + 8 H+ -> Mn^2+ + 5 Fe^3+ + 4 H2O',
      'CuSO4.5H2O -> CuSO4 + 5 H2O',
      'Fe^3+ + e- -> Fe^2+',
      'C2H6 + 7/2 O2 -> 2 CO2 + 3 H2O',
    ]) {
      const eq = parseEquation(text);
      expect(formatEquation(eq)).toBe(text);
      expect(parseEquation(formatEquation(eq))).toEqual(eq);
    }
  });

  it('normalizes typography', () => {
    expect(formatEquation(parseEquation('2H\u2082 + O\u2082 \u2192 2H\u2082O'))).toBe('2 H2 + O2 -> 2 H2O');
    expect(formatEquation(parseEquation('N2O4 \u21cc 2 NO2'))).toBe('N2O4 <=> 2 NO2');
    expect(formatEquation(parseEquation('H2 + 0.5 O2 = H2O'))).toBe('H2 + 1/2 O2 -> H2O');
    expect(formatEquation(parseEquation('SO\u2084\u00b2\u207b + Ba\u00b2\u207a -> BaSO4'))).toBe('SO4^2- + Ba^2+ -> BaSO4');
  });
});

describe('checkConservation', () => {
  it('reports a balanced equation', () => {
    const report = checkConservation(parseEquation('CH4 + 2 O2 -> CO2 + 2 H2O'));
    expect(report).toEqual({ balanced: true, elementImbalance: { C: 0, H: 0, O: 0 }, chargeImbalance: 0 });
  });

  it('reports products minus reactants for every element', () => {
    const report = checkConservation(parseEquation('H2 + O2 -> H2O'));
    expect(report.balanced).toBe(false);
    expect(report.elementImbalance).toEqual({ H: 0, O: -1 });
    expect(report.chargeImbalance).toBe(0);
    expect(checkConservation(parseEquation('C3H8 + O2 -> CO2 + H2O')).elementImbalance).toEqual({ C: -2, H: -6, O: 1 });
  });

  it('lists an element that appears on one side only', () => {
    expect(checkConservation(parseEquation('NaCl -> KCl')).elementImbalance).toEqual({ K: 1, Cl: 0, Na: -1 });
  });

  it('checks the charge as well as the atoms', () => {
    const atomsOnly = checkConservation(parseEquation('Fe^2+ -> Fe^3+'));
    expect(atomsOnly.elementImbalance).toEqual({ Fe: 0 });
    expect(atomsOnly.chargeImbalance).toBe(1);
    expect(atomsOnly.balanced).toBe(false);
    expect(checkConservation(parseEquation('Fe^2+ -> Fe^3+ + e-')).balanced).toBe(true);
    expect(checkConservation(parseEquation('MnO4- + 5 Fe^2+ + 8 H+ -> Mn^2+ + 5 Fe^3+ + 4 H2O')).balanced).toBe(true);
    // Atoms balance here, but the charge does not.
    const zinc = checkConservation(parseEquation('Zn + Ag+ -> Zn^2+ + Ag'));
    expect(zinc.elementImbalance).toEqual({ Zn: 0, Ag: 0 });
    expect(zinc.chargeImbalance).toBe(1);
    expect(zinc.balanced).toBe(false);
  });

  it('handles fractional and decimal coefficients without rounding artefacts', () => {
    expect(checkConservation(parseEquation('H2 + 1/2 O2 -> H2O')).balanced).toBe(true);
    expect(checkConservation(parseEquation('C2H6 + 7/2 O2 -> 2 CO2 + 3 H2O')).balanced).toBe(true);
    expect(checkConservation(parseEquation('0.1 Fe2O3 + 0.3 CO -> 0.2 Fe + 0.3 CO2')).balanced).toBe(true);
    expect(checkConservation(parseEquation('1/3 N2 + H2 -> 2/3 NH3')).balanced).toBe(true);
    expect(checkConservation(parseEquation('1/3 N2 + H2 -> 0.66 NH3')).balanced).toBe(false);
  });
});

describe('reverseEquation and scaleEquation', () => {
  it('swap the sides and multiply the coefficients', () => {
    const eq = parseEquation('N2(g) + 3 H2(g) <=> 2 NH3(g)');
    expect(formatEquation(reverseEquation(eq))).toBe('2 NH3(g) <=> N2(g) + 3 H2(g)');
    expect(formatEquation(scaleEquation(eq, 2))).toBe('2 N2(g) + 6 H2(g) <=> 4 NH3(g)');
    expect(formatEquation(scaleEquation(eq, 0.5))).toBe('1/2 N2(g) + 3/2 H2(g) <=> NH3(g)');
    expect(checkConservation(scaleEquation(eq, 1 / 3)).balanced).toBe(true);
    expect(() => scaleEquation(eq, 0)).toThrow(RangeError);
    expect(() => scaleEquation(eq, -1)).toThrow(RangeError);
  });
});
