import { describe, expect, it } from 'vitest';
import { balanceEquation, checkConservation, formatEquation, parseEquation } from '../src';
import { add, approximateFraction, compare, divide, fraction, gcd, lcm, multiply, parseRational, subtract, toNumber, toSmallestIntegers } from '../src/rational';

/** Balances an equation and returns it as text, after checking that the result really conserves everything. */
function balanced(text: string): string {
  const result = balanceEquation(text);
  expect(result.status, `${text}: ${result.message}`).toBe('balanced');
  expect(result.independentSolutions).toBe(1);
  const equation = result.equation!;
  expect(checkConservation(equation).balanced).toBe(true);
  const coefficients = [...equation.reactants, ...equation.products].map((t) => t.coefficient);
  // Smallest positive whole numbers: all integers, all positive, no common divisor.
  expect(coefficients.every((c) => Number.isInteger(c) && c > 0)).toBe(true);
  expect(coefficients.reduce((g, c) => Number(gcd(BigInt(g), BigInt(c))), 0)).toBe(1);
  return formatEquation(equation);
}

describe('balanceEquation: equations with a unique solution', () => {
  it('balances combustion reactions', () => {
    expect(balanced('H2 + O2 -> H2O')).toBe('2 H2 + O2 -> 2 H2O');
    expect(balanced('CH4 + O2 -> CO2 + H2O')).toBe('CH4 + 2 O2 -> CO2 + 2 H2O');
    expect(balanced('C2H6 + O2 -> CO2 + H2O')).toBe('2 C2H6 + 7 O2 -> 4 CO2 + 6 H2O');
    expect(balanced('C3H8 + O2 -> CO2 + H2O')).toBe('C3H8 + 5 O2 -> 3 CO2 + 4 H2O');
    expect(balanced('C8H18 + O2 -> CO2 + H2O')).toBe('2 C8H18 + 25 O2 -> 16 CO2 + 18 H2O');
    expect(balanced('C2H5OH + O2 -> CO2 + H2O')).toBe('C2H5OH + 3 O2 -> 2 CO2 + 3 H2O');
    expect(balanced('C6H12O6 + O2 -> CO2 + H2O')).toBe('C6H12O6 + 6 O2 -> 6 CO2 + 6 H2O');
    expect(balanced('C6H6 + O2 -> CO2 + H2O')).toBe('2 C6H6 + 15 O2 -> 12 CO2 + 6 H2O');
    expect(balanced('NH3 + O2 -> NO + H2O')).toBe('4 NH3 + 5 O2 -> 4 NO + 6 H2O');
    expect(balanced('FeS2 + O2 -> Fe2O3 + SO2')).toBe('4 FeS2 + 11 O2 -> 2 Fe2O3 + 8 SO2');
  });

  it('balances redox reactions in acidic solution, using the charge as well as the atoms', () => {
    expect(balanced('MnO4- + Fe^2+ + H+ -> Mn^2+ + Fe^3+ + H2O')).toBe('MnO4- + 5 Fe^2+ + 8 H+ -> Mn^2+ + 5 Fe^3+ + 4 H2O');
    expect(balanced('Cr2O7^2- + Fe^2+ + H+ -> Cr^3+ + Fe^3+ + H2O')).toBe('Cr2O7^2- + 6 Fe^2+ + 14 H+ -> 2 Cr^3+ + 6 Fe^3+ + 7 H2O');
    expect(balanced('Cu + NO3- + H+ -> Cu^2+ + NO + H2O')).toBe('3 Cu + 2 NO3- + 8 H+ -> 3 Cu^2+ + 2 NO + 4 H2O');
    expect(balanced('MnO4- + C2O4^2- + H+ -> Mn^2+ + CO2 + H2O')).toBe('2 MnO4- + 5 C2O4^2- + 16 H+ -> 2 Mn^2+ + 10 CO2 + 8 H2O');
    expect(balanced('Zn + Ag+ -> Zn^2+ + Ag')).toBe('Zn + 2 Ag+ -> Zn^2+ + 2 Ag');
  });

  it('needs the charge row: these have the same atoms on both sides for many coefficient choices', () => {
    // Without charge conservation "Fe^3+ + Sn^2+ -> Fe^2+ + Sn^4+" would be accepted as written.
    expect(balanced('Fe^3+ + Sn^2+ -> Fe^2+ + Sn^4+')).toBe('2 Fe^3+ + Sn^2+ -> 2 Fe^2+ + Sn^4+');
    expect(balanced('Al + H+ -> Al^3+ + H2')).toBe('2 Al + 6 H+ -> 2 Al^3+ + 3 H2');
  });

  it('balances half-reactions that contain electrons, and reactions in basic solution', () => {
    expect(balanced('MnO4- + H+ + e- -> Mn^2+ + H2O')).toBe('MnO4- + 8 H+ + 5 e- -> Mn^2+ + 4 H2O');
    expect(balanced('O2 + H+ + e- -> H2O')).toBe('O2 + 4 H+ + 4 e- -> 2 H2O');
    expect(balanced('Cr2O7^2- + H+ + e- -> Cr^3+ + H2O')).toBe('Cr2O7^2- + 14 H+ + 6 e- -> 2 Cr^3+ + 7 H2O');
    expect(balanced('MnO4- + H2O + e- -> MnO2 + OH-')).toBe('MnO4- + 2 H2O + 3 e- -> MnO2 + 4 OH-');
    expect(balanced('Cl2 + OH- -> Cl- + ClO3- + H2O')).toBe('3 Cl2 + 6 OH- -> 5 Cl- + ClO3- + 3 H2O');
  });

  it('balances precipitation and other double-displacement reactions', () => {
    expect(balanced('Pb(NO3)2 + KI -> PbI2 + KNO3')).toBe('Pb(NO3)2 + 2 KI -> PbI2 + 2 KNO3');
    expect(balanced('BaCl2 + Na2SO4 -> BaSO4 + NaCl')).toBe('BaCl2 + Na2SO4 -> BaSO4 + 2 NaCl');
    expect(balanced('Ca^2+ + PO4^3- -> Ca3(PO4)2')).toBe('3 Ca^2+ + 2 PO4^3- -> Ca3(PO4)2');
    expect(balanced('Al2(SO4)3 + Ca(OH)2 -> Al(OH)3 + CaSO4')).toBe('Al2(SO4)3 + 3 Ca(OH)2 -> 2 Al(OH)3 + 3 CaSO4');
    expect(balanced('Fe^3+ + OH- -> Fe(OH)3')).toBe('Fe^3+ + 3 OH- -> Fe(OH)3');
  });

  it('balances equations with hydrates, brackets and large coefficients', () => {
    expect(balanced('CuSO4.5H2O -> CuSO4 + H2O')).toBe('CuSO4.5H2O -> CuSO4 + 5 H2O');
    expect(balanced('K4[Fe(CN)6] + KMnO4 + H2SO4 -> KHSO4 + Fe2(SO4)3 + MnSO4 + HNO3 + CO2 + H2O')).toBe(
      '10 K4[Fe(CN)6] + 122 KMnO4 + 299 H2SO4 -> 162 KHSO4 + 5 Fe2(SO4)3 + 122 MnSO4 + 60 HNO3 + 60 CO2 + 188 H2O',
    );
    expect(balanced('P4O10 + H2O -> H3PO4')).toBe('P4O10 + 6 H2O -> 4 H3PO4');
  });

  it('ignores the coefficients of an unbalanced input and keeps phases and the arrow', () => {
    expect(balanced('5 H2 + 3 O2 -> 7 H2O')).toBe('2 H2 + O2 -> 2 H2O');
    expect(balanced('N2(g) + H2(g) <=> NH3(g)')).toBe('N2(g) + 3 H2(g) <=> 2 NH3(g)');
  });

  it('accepts an already parsed equation', () => {
    const result = balanceEquation(parseEquation('Fe + O2 -> Fe2O3'));
    expect(result.status).toBe('balanced');
    expect(formatEquation(result.equation!)).toBe('4 Fe + 3 O2 -> 2 Fe2O3');
  });
});

describe('balanceEquation: already balanced input', () => {
  it('returns the equation unchanged', () => {
    for (const text of ['2 H2 + O2 -> 2 H2O', 'AgNO3 + NaCl -> AgCl + NaNO3', 'Ag+ + Cl- -> AgCl', 'Fe^3+ + e- -> Fe^2+', 'CH4 + 2 O2 -> CO2 + 2 H2O']) {
      const result = balanceEquation(text);
      expect(result.status, text).toBe('already-balanced');
      expect(formatEquation(result.equation!)).toBe(text);
      expect(result.message).toMatch(/already balanced/);
    }
  });

  it('keeps fractional or multiplied coefficients and mentions the smallest whole-number form', () => {
    const half = balanceEquation('H2 + 1/2 O2 -> H2O');
    expect(half.status).toBe('already-balanced');
    expect(formatEquation(half.equation!)).toBe('H2 + 1/2 O2 -> H2O');
    expect(half.message).toContain('2 H2 + O2 -> 2 H2O');
    const doubled = balanceEquation('4 H2 + 2 O2 -> 4 H2O');
    expect(doubled.status).toBe('already-balanced');
    expect(doubled.message).toContain('2 H2 + O2 -> 2 H2O');
  });

  it('says so when the balanced input is only one of many possible sets of coefficients', () => {
    const result = balanceEquation('2 C + 3/2 O2 -> CO + CO2');
    expect(result.status).toBe('already-balanced');
    expect(result.independentSolutions).toBe(2);
    expect(result.message).toMatch(/one valid choice among many/);
  });
});

describe('balanceEquation: impossible equations', () => {
  it('reports that no coefficients exist when an element appears on one side only', () => {
    for (const text of ['H2O -> H2 + Cl2', 'NaCl -> KCl', 'H2 + O2 -> NH3']) {
      const result = balanceEquation(text);
      expect(result.status, text).toBe('impossible');
      expect(result.equation).toBeUndefined();
      expect(result.independentSolutions).toBe(0);
      expect(result.message).toMatch(/No choice of coefficients/);
    }
  });

  it('names a species that could only take part with a coefficient of zero', () => {
    const spectator = balanceEquation('H2 + N2 + O2 -> H2O');
    expect(spectator.status).toBe('impossible');
    expect(spectator.message).toMatch(/N2 a coefficient of zero/);
    const extra = balanceEquation('H2 + O2 -> H2O + CO2');
    expect(extra.status).toBe('impossible');
    expect(extra.message).toMatch(/CO2 a coefficient of zero/);
  });

  it('names a species that would have to move to the other side', () => {
    const result = balanceEquation('H2 + H2O -> O2');
    expect(result.status).toBe('impossible');
    expect(result.message).toMatch(/negative coefficient/);
    expect(result.message).toMatch(/other side/);
  });

  it('reports a charge that cannot be conserved', () => {
    const result = balanceEquation('Fe^2+ -> Fe^3+');
    expect(result.status).toBe('impossible');
    expect(result.independentSolutions).toBe(0);
  });

  it('recognises an impossible equation even when conservation has several solutions', () => {
    // Two independent solutions exist, but none with every coefficient positive.
    const result = balanceEquation('H2O + CO2 -> H2 + O2 + C + N2');
    expect(result.status).toBe('impossible');
    const other = balanceEquation('C + CO -> CO2 + O2');
    expect(other.status).toBe('impossible');
  });
});

describe('balanceEquation: underdetermined equations', () => {
  it('refuses to pick coefficients when two reactions are written as one', () => {
    for (const text of ['C + O2 -> CO + CO2', 'CH4 + O2 -> CO2 + CO + H2O', 'KMnO4 + H2O2 + H2SO4 -> MnSO4 + K2SO4 + O2 + H2O', 'NH3 + O2 -> NO + NO2 + H2O']) {
      const result = balanceEquation(text);
      expect(result.status, text).toBe('underdetermined');
      expect(result.equation).toBeUndefined();
      expect(result.independentSolutions).toBeGreaterThanOrEqual(2);
      expect(result.message).toMatch(/independent solutions/);
      expect(result.message).toMatch(/two or more reactions/);
    }
  });

  it('points at a species written on both sides', () => {
    const result = balanceEquation('H2O2 + I- -> H2O + O2 + I-');
    expect(result.status).toBe('underdetermined');
    expect(result.message).toMatch(/I- appears on both sides/);
  });

  it('points at a species written twice on one side', () => {
    const result = balanceEquation('H2 + H2 + O2 -> H2O');
    expect(result.status).toBe('underdetermined');
    expect(result.message).toMatch(/H2 is written more than once/);
  });

  it('becomes unique once the equation is split into its separate reactions', () => {
    expect(balanced('C + O2 -> CO')).toBe('2 C + O2 -> 2 CO');
    expect(balanced('CO + O2 -> CO2')).toBe('2 CO + O2 -> 2 CO2');
    const complete = balanceEquation('C + O2 -> CO2');
    expect(complete.status).toBe('already-balanced');
    expect(complete.independentSolutions).toBe(1);
  });
});

describe('exact rational arithmetic', () => {
  it('normalizes fractions', () => {
    expect(fraction(6, 4)).toEqual({ n: 3n, d: 2n });
    expect(fraction(3, -6)).toEqual({ n: -1n, d: 2n });
    expect(fraction(0, 5)).toEqual({ n: 0n, d: 1n });
    expect(() => fraction(1, 0)).toThrow(RangeError);
    expect(() => fraction(0.5)).toThrow(RangeError);
  });

  it('adds, subtracts, multiplies, divides and compares exactly', () => {
    const third = fraction(1, 3);
    const sixth = fraction(1, 6);
    expect(add(third, sixth)).toEqual(fraction(1, 2));
    expect(subtract(third, sixth)).toEqual(sixth);
    expect(multiply(third, sixth)).toEqual(fraction(1, 18));
    expect(divide(third, sixth)).toEqual(fraction(2));
    expect(compare(third, sixth)).toBeGreaterThan(0);
    expect(compare(sixth, third)).toBeLessThan(0);
    expect(compare(fraction(2, 6), third)).toBe(0);
    expect(() => divide(third, fraction(0))).toThrow(RangeError);
    // 0.1 + 0.2 is not 0.3 in floating point, but 1/10 + 2/10 is 3/10 exactly.
    expect(add(fraction(1, 10), fraction(2, 10))).toEqual(fraction(3, 10));
    expect(toNumber(fraction(7, 2))).toBe(3.5);
  });

  it('stays exact for numbers far beyond double precision', () => {
    const big = fraction(10n ** 40n + 1n, 10n ** 40n);
    expect(subtract(big, fraction(1))).toEqual(fraction(1n, 10n ** 40n));
    expect(gcd(2n ** 80n, 2n ** 70n * 3n)).toBe(2n ** 70n);
    expect(lcm(4n, 6n)).toBe(12n);
  });

  it('scales rationals to the smallest whole numbers', () => {
    expect(toSmallestIntegers([fraction(1, 2), fraction(1), fraction(3, 2)])).toEqual([1n, 2n, 3n]);
    expect(toSmallestIntegers([fraction(4), fraction(6)])).toEqual([2n, 3n]);
    expect(toSmallestIntegers([fraction(-1, 3), fraction(-1, 6)])).toEqual([2n, 1n]);
    expect(() => toSmallestIntegers([fraction(0), fraction(0)])).toThrow(RangeError);
  });

  it('reads coefficient literals exactly', () => {
    expect(parseRational('2')).toEqual(fraction(2));
    expect(parseRational('0.5')).toEqual(fraction(1, 2));
    expect(parseRational('7/2')).toEqual(fraction(7, 2));
    expect(parseRational('0.1')).toEqual(fraction(1, 10));
    expect(parseRational('1.5/3')).toEqual(fraction(1, 2));
    expect(parseRational('1/0')).toBeUndefined();
    expect(parseRational('abc')).toBeUndefined();
    expect(parseRational('-1')).toBeUndefined();
  });

  it('recovers simple fractions from decimals for display only', () => {
    expect(approximateFraction(0.5)).toEqual(fraction(1, 2));
    expect(approximateFraction(3.5)).toEqual(fraction(7, 2));
    expect(approximateFraction(1 / 3)).toEqual(fraction(1, 3));
    expect(approximateFraction(4)).toEqual(fraction(4));
    expect(approximateFraction(Math.PI)).toBeUndefined();
    expect(approximateFraction(Number.NaN)).toBeUndefined();
  });
});
