import { AVOGADRO, GAS_CONSTANT_J_PER_MOL_K } from '@matterlab/core';
import { describe, expect, it } from 'vitest';
import {
  KINETICS_SOLVER_METHOD,
  KINETIC_DATA_SOURCES,
  KINETIC_MODELS,
  MOLECULES_PER_CM3_PER_MOL_PER_L,
  SUPPORTED_REACTION_CLASSES,
  checkConservation,
  findKineticModels,
  kineticEvidence,
  parseEquation,
  parseFormula,
  powerLawDecay,
  powerLawHalfLife,
  rateConstant,
  secondOrderTwoReactants,
  simulateKinetics,
  toMolarUnits,
} from '../src';
import type { KineticModel, KineticsResult } from '../src';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function model(id: string): KineticModel {
  const found = KINETIC_MODELS.find((m) => m.id === id);
  if (!found) throw new Error(`no kinetic model ${id}`);
  return found;
}

/** A model with made-up parameters, for exercising the solver on rate laws the shipped models do not have. */
function fixture(overrides: Partial<KineticModel> = {}): KineticModel {
  return {
    id: 'test-fixture',
    name: 'Solver test fixture',
    reactionClass: 'test',
    equation: 'N2O4 -> 2 NO2',
    medium: 'gas',
    rateLaw: { orders: { N2O4: 1 }, description: 'rate = k [N2O4]' },
    // Ea = 0 makes k equal to A at every temperature.
    arrhenius: { A: 0.5, AUnits: 's-1', EaKJPerMol: 0 },
    validTemperatureRangeK: [200, 400],
    notes: 'Made-up parameters for testing the solver. Not data.',
    provenance: { source: 'test fixture' },
    concentrationUnit: 'mol/L',
    parameterEvidence: 'user-input',
    ...overrides,
  };
}

/** Initial concentrations (molecule cm-3), duration (s) and a temperature inside the validated range, per shipped model. */
const SCENARIOS: Readonly<Record<string, { initial: Record<string, number>; duration: number; temperature: number }>> = {
  'no-o3': { initial: { NO: 1e12, O3: 3e12 }, duration: 300, temperature: 298 },
  'no2-o3': { initial: { NO2: 5e12, O3: 2e12 }, duration: 2e4, temperature: 298 },
  'o-o3': { initial: { O: 1e9, O3: 1e13 }, duration: 60, temperature: 250 },
  'oh-h2': { initial: { OH: 1e7, H2: 1.3e13 }, duration: 60, temperature: 298 },
  'no-no3': { initial: { NO: 1e10, NO3: 2e9 }, duration: 20, temperature: 298 },
  'no-o2-termolecular': { initial: { NO: 2e17, O2: 1e17 }, duration: 5000, temperature: 298 },
  'acetylperoxy-self': { initial: { C2H3O3: 5e12 }, duration: 0.1, temperature: 298 },
  'mpan-decomposition': { initial: { C4H5NO5: 2.5e10 }, duration: 3 * 3600, temperature: 298 },
};

function run(id: string, overrides: Partial<Parameters<typeof simulateKinetics>[0]> = {}): KineticsResult {
  const scenario = SCENARIOS[id]!;
  return simulateKinetics({ model: model(id), temperatureK: scenario.temperature, initialConcentrations: scenario.initial, durationSeconds: scenario.duration, ...overrides });
}

/** Largest deviation of a computed curve from an exact one, as a fraction of `scale`. */
function worst(result: KineticsResult, species: string, exact: (t: number) => number, scale: number): number {
  let error = 0;
  result.times.forEach((t, i) => {
    error = Math.max(error, Math.abs(result.concentrations[species]![i]! - exact(t)) / scale);
  });
  return error;
}

describe('kinetic models', () => {
  it('ships between four and eight models, one scenario of this test file for each', () => {
    expect(KINETIC_MODELS.length).toBeGreaterThanOrEqual(4);
    expect(KINETIC_MODELS.length).toBeLessThanOrEqual(8);
    expect(new Set(KINETIC_MODELS.map((m) => m.id)).size).toBe(KINETIC_MODELS.length);
    expect(Object.keys(SCENARIOS).sort()).toEqual(KINETIC_MODELS.map((m) => m.id).sort());
  });

  it('gives every model a provenance with an https URL, a retrieval date, a citation and a licence', () => {
    for (const m of KINETIC_MODELS) {
      const p = m.provenance;
      expect(p.source.length, m.id).toBeGreaterThan(0);
      expect(p.url, m.id).toMatch(/^https:\/\/\S+$/);
      expect(p.retrieved, m.id).toMatch(ISO_DATE);
      expect(Number.isNaN(Date.parse(p.retrieved!)), m.id).toBe(false);
      expect(p.citations, m.id).toHaveLength(1);
      const citation = p.citations![0]!;
      expect(citation.authors, m.id).toMatch(/^Atkinson, R\., Baulch, D\. L\., Cox, R\. A\./);
      expect(citation.title, m.id).toMatch(/^Evaluated kinetic and photochemical data for atmospheric chemistry: Volume I/);
      expect(citation.source, m.id).toMatch(/^Atmospheric Chemistry and Physics \d+, \d+-\d+$/);
      expect(citation.doi, m.id).toMatch(/^10\.5194\/acp-/);
      expect(citation.url, m.id).toMatch(/^https:\/\/doi\.org\/10\.5194\//);
      expect(p.license, m.id).toMatch(/Creative Commons Attribution-NonCommercial-ShareAlike 2\.5 License/);
      expect(p.version, m.id).toBe(`data sheet ${m.asPublished!.dataSheet}`);
      expect(p.notes, m.id).toMatch(/packages\/reactions\/data\/sources\/iupac\/acp-\d-\d+-\d{4}\.excerpts\.txt/);
      expect(p.notes, m.id).toMatch(/SHA-256 of the PDF as retrieved: [0-9a-f]{64}/);
      expect(m.notes.length, m.id).toBeGreaterThan(100);
    }
    expect(KINETIC_DATA_SOURCES).toHaveLength(2);
    expect(KINETIC_DATA_SOURCES.reduce((n, s) => n + s.modelCount, 0)).toBe(KINETIC_MODELS.length);
    for (const source of KINETIC_DATA_SOURCES) {
      expect(source.retrieved).toMatch(ISO_DATE);
      expect(source.statements.map((s) => s.text)).toContain('All of the reactions in the table are elementary processes.');
      expect(source.statements.some((s) => /expanded uncertainties corresponding approximately to a 95% con\S+dence limit/.test(s.text))).toBe(true);
    }
  });

  it('states a rate law that agrees with the equation and with the units of k', () => {
    const unitsOfOrder: Record<number, string> = { 1: 's-1', 2: 'cm3 molecule-1 s-1', 3: 'cm6 molecule-2 s-1' };
    const kineticClasses = SUPPORTED_REACTION_CLASSES.filter((c) => c.supports.kinetics).map((c) => c.id);
    for (const m of KINETIC_MODELS) {
      const equation = parseEquation(m.equation);
      expect(checkConservation(equation).balanced, m.id).toBe(true);
      // The source lists elementary reactions, so each reactant enters the rate law with its coefficient.
      const expectedOrders: Record<string, number> = {};
      for (const t of equation.reactants) expectedOrders[t.formula] = (expectedOrders[t.formula] ?? 0) + t.coefficient;
      expect(m.rateLaw.orders, m.id).toEqual(expectedOrders);
      const overall = Object.values(m.rateLaw.orders).reduce((a, b) => a + b, 0);
      expect(m.arrhenius.AUnits, m.id).toBe(unitsOfOrder[overall]);
      expect(m.rateLaw.description, m.id).toMatch(/^rate = k \[/);
      expect(m.concentrationUnit, m.id).toBe('molecule cm-3');
      expect(m.medium, m.id).toBe('gas');
      expect(m.parameterEvidence, m.id).toBe('reference');
      expect(kineticClasses, m.id).toContain(m.reactionClass);
      const [low, high] = m.validTemperatureRangeK;
      expect(low, m.id).toBeLessThan(high);
      expect(low, m.id).toBeGreaterThan(100);
      expect(high, m.id).toBeLessThan(1000);
      for (const t of [...equation.reactants, ...equation.products]) expect(m.speciesNames?.[t.formula], `${m.id} ${t.formula}`).toBeTruthy();
    }
    expect(model('no-o2-termolecular').rateLaw).toEqual({
      orders: { NO: 2, O2: 1 },
      description: 'rate = k [NO]^2 [O2]; d[NO]/dt = -2 rate, d[O2]/dt = -rate, d[NO2]/dt = +2 rate.',
    });
    expect(new Set(KINETIC_MODELS.map((m) => Object.values(m.rateLaw.orders).reduce((a, b) => a + b, 0)))).toEqual(new Set([1, 2, 3]));
  });

  it('keeps the expression as published next to the parameters derived from it', () => {
    for (const m of KINETIC_MODELS) {
      const published = m.asPublished!;
      expect(m.arrhenius.A, m.id).toBe(published.A);
      expect(m.arrhenius.AUnits, m.id).toBe(published.AUnits);
      // The source gives E/R in kelvin; the activation energy is that times the gas constant.
      expect(m.arrhenius.EaKJPerMol, m.id).toBeCloseTo((published.EOverRK * GAS_CONSTANT_J_PER_MOL_K) / 1000, 12);
      expect(published.expression, m.id).toContain('exp(');
      expect(published.expression, m.id).toContain(`over the temperature range ${m.validTemperatureRangeK[0]}\u2013${m.validTemperatureRangeK[1]} K`);
      expect(published.expression, m.id).toContain(`${Math.abs(published.EOverRK)}/T`);
      expect(published.dataSheet, m.id).toMatch(/^I{1,2}\.A\d\.\d+$/);
      expect(m.reliability!.deltaLog10K298, m.id).toBeGreaterThan(0);
      expect(m.reliability!.deltaEOverRK, m.id).toBeGreaterThan(0);
      expect(m.reliability!.meaning, m.id).toMatch(/95 % confidence/);
    }
    expect(model('mpan-decomposition').conditions).toBe('1 bar total pressure');
    expect(model('no-o3').conditions).toBeUndefined();
  });
});

describe('rateConstant', () => {
  it('evaluates k = A exp(−Ea/RT), which is A exp(−(E/R)/T) in the form of the source', () => {
    for (const m of KINETIC_MODELS) {
      const [low, high] = m.validTemperatureRangeK;
      for (const temperature of [low, (low + high) / 2, high]) {
        const { k, withinValidatedRange } = rateConstant(m, temperature);
        const expected = m.asPublished!.A * Math.exp(-m.asPublished!.EOverRK / temperature);
        expect(k.value / expected, `${m.id} at ${temperature} K`).toBeCloseTo(1, 12);
        expect(k.unit).toBe(m.arrhenius.AUnits);
        expect(withinValidatedRange).toBe(true);
        expect(k.evidence).toBe('computed');
        expect(k.provenance?.url).toMatch(/^https:\/\//);
      }
    }
  });

  it('reproduces the 298 K value printed on each data sheet to within the rounding of the evaluation', () => {
    for (const m of KINETIC_MODELS) {
      // The evaluators round the 298 K value and the Arrhenius parameters separately, to two figures.
      expect(Math.abs(rateConstant(m, 298).k.value / m.asPublished!.k298 - 1), m.id).toBeLessThan(0.05);
    }
  });

  it('rises with temperature for a positive activation energy and falls for a negative one', () => {
    for (const m of KINETIC_MODELS) {
      const [low, high] = m.validTemperatureRangeK;
      const ratio = rateConstant(m, high).k.value / rateConstant(m, low).k.value;
      if (m.arrhenius.EaKJPerMol > 0) expect(ratio, m.id).toBeGreaterThan(1);
      else expect(ratio, m.id).toBeLessThan(1);
    }
    expect(model('no-o3').arrhenius.EaKJPerMol).toBeGreaterThan(0);
    // The oxidation of NO by O2 is the textbook case of a rate that falls on heating.
    expect(model('no-o2-termolecular').arrhenius.EaKJPerMol).toBeLessThan(0);
  });

  it('still computes outside the validated range, but flags and relabels the result', () => {
    const m = model('no-o3');
    const [low, high] = m.validTemperatureRangeK;
    for (const temperature of [low, high]) {
      const inside = rateConstant(m, temperature);
      expect(inside.withinValidatedRange).toBe(true);
      expect(inside.warnings).toEqual([]);
    }
    for (const [temperature, side] of [
      [low - 0.5, 'below'],
      [high + 0.5, 'above'],
      [1500, 'above'],
    ] as const) {
      const outside = rateConstant(m, temperature);
      expect(outside.withinValidatedRange).toBe(false);
      expect(outside.k.value).toBeCloseTo(m.arrhenius.A * Math.exp(-m.asPublished!.EOverRK / temperature), 25);
      expect(outside.k.evidence).toBe('rule-based');
      expect(outside.warnings).toHaveLength(1);
      expect(outside.warnings[0]).toMatch(/^TEMPERATURE OUTSIDE THE VALIDATED RANGE/);
      expect(outside.warnings[0]).toContain(`recommended for ${low} K to ${high} K, and ${temperature} K is ${side} that range`);
      expect(outside.warnings[0]).toMatch(/extrapolation/);
      expect(outside.log10Uncertainty).toBeUndefined();
    }
  });

  it('always repeats the conditions a model is restricted to', () => {
    expect(rateConstant(model('mpan-decomposition'), 300).warnings).toEqual(['The rate expression applies at 1 bar total pressure only.']);
    const outside = rateConstant(model('mpan-decomposition'), 400).warnings;
    expect(outside).toHaveLength(2);
    expect(outside[0]).toMatch(/^TEMPERATURE OUTSIDE THE VALIDATED RANGE/);
  });

  it('estimates the uncertainty of k from the reliability figures of the source', () => {
    for (const m of KINETIC_MODELS) {
      const { deltaLog10K298, deltaEOverRK } = m.reliability!;
      const [low, high] = m.validTemperatureRangeK;
      if (low <= 298 && high >= 298) expect(rateConstant(m, 298).log10Uncertainty, m.id).toBeCloseTo(deltaLog10K298, 12);
      for (const temperature of [low, high]) {
        const expected = deltaLog10K298 + 0.4343 * deltaEOverRK * Math.abs(1 / temperature - 1 / 298);
        expect(rateConstant(m, temperature).log10Uncertainty, m.id).toBeCloseTo(expected, 12);
        expect(rateConstant(m, temperature).log10Uncertainty!, m.id).toBeGreaterThanOrEqual(deltaLog10K298);
      }
    }
  });

  it('labels results from parameters that are not reference data with the label of the parameters', () => {
    const made = fixture();
    const inside = rateConstant(made, 300);
    expect(inside.k.value).toBe(0.5);
    expect(inside.k.evidence).toBe('user-input');
    expect(inside.warnings).toEqual(['The rate parameters of "Solver test fixture" are labelled "user-input", not reference data.']);
    expect(inside.log10Uncertainty).toBeUndefined();
    expect(kineticEvidence(made, true)).toBe('user-input');
    expect(kineticEvidence(made, false)).toBe('user-input');
    expect(kineticEvidence(model('no-o3'), true)).toBe('computed');
    expect(kineticEvidence(model('no-o3'), false)).toBe('rule-based');
  });

  it('rejects a temperature that is not physical', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => rateConstant(model('no-o3'), bad), String(bad)).toThrow(RangeError);
  });
});

describe('toMolarUnits', () => {
  it('converts the pre-exponential factor with the exact Avogadro constant', () => {
    expect(MOLECULES_PER_CM3_PER_MOL_PER_L).toBe(AVOGADRO / 1000);
    const expectedUnits: Record<string, string> = { 's-1': 's-1', 'cm3 molecule-1 s-1': 'L mol-1 s-1', 'cm6 molecule-2 s-1': 'L2 mol-2 s-1' };
    for (const m of KINETIC_MODELS) {
      const molar = toMolarUnits(m);
      const order = Object.values(m.rateLaw.orders).reduce((a, b) => a + b, 0);
      expect(molar.concentrationUnit, m.id).toBe('mol/L');
      expect(molar.arrhenius.AUnits, m.id).toBe(expectedUnits[m.arrhenius.AUnits]);
      expect(molar.arrhenius.A / (m.arrhenius.A * (AVOGADRO / 1000) ** (order - 1)), m.id).toBeCloseTo(1, 12);
      expect(molar.arrhenius.EaKJPerMol, m.id).toBe(m.arrhenius.EaKJPerMol);
      expect(molar.validTemperatureRangeK, m.id).toEqual(m.validTemperatureRangeK);
      expect(molar.provenance, m.id).toBe(m.provenance);
      expect(molar.notes, m.id).toMatch(/Converted from molecule cm-3 to mol\/L/);
      // Converting twice changes nothing more.
      expect(toMolarUnits(molar), m.id).toBe(molar);
    }
    expect(() => toMolarUnits(fixture({ concentrationUnit: 'mol/kg' }))).toThrow(RangeError);
  });

  it('describes the same physical process in either unit system', () => {
    const scenario = SCENARIOS['no-o2-termolecular']!;
    const inMolecules = run('no-o2-termolecular');
    const molarInitial = Object.fromEntries(Object.entries(scenario.initial).map(([name, c]) => [name, c / MOLECULES_PER_CM3_PER_MOL_PER_L]));
    const inMoles = simulateKinetics({ model: toMolarUnits(model('no-o2-termolecular')), temperatureK: scenario.temperature, initialConcentrations: molarInitial, durationSeconds: scenario.duration });
    expect(inMoles.status).toBe('ok');
    expect(inMoles.concentrationUnit).toBe('mol/L');
    expect(inMoles.rateUnit).toBe('mol/L s-1');
    expect(inMoles.rateConstant.unit).toBe('L2 mol-2 s-1');
    for (const name of inMolecules.species) {
      inMolecules.times.forEach((_t, i) => {
        const converted = inMoles.concentrations[name]![i]! * MOLECULES_PER_CM3_PER_MOL_PER_L;
        expect(Math.abs(converted - inMolecules.concentrations[name]![i]!) / 2e17).toBeLessThan(1e-7);
      });
    }
    expect(inMoles.halfLifeSeconds! / inMolecules.halfLifeSeconds!).toBeCloseTo(1, 8);
  });
});

/**
 * Agreement with closed-form solutions. The solver is run at its default tolerance of 1e-8 (per step,
 * relative to the largest change a species can undergo); the curves are required to agree with the exact
 * solution to 1e-7 of the initial concentration at every output time.
 */
describe('simulateKinetics against analytic solutions (solver tolerance 1e-8, required agreement 1e-7)', () => {
  const AGREEMENT = 1e-7;

  it('first order: [A] = [A]0 exp(−kt), with a sourced model', () => {
    const a0 = SCENARIOS['mpan-decomposition']!.initial.C4H5NO5!;
    const result = run('mpan-decomposition');
    expect(result.status).toBe('ok');
    expect(result.solver.tolerance).toBe(1e-8);
    expect(result.times).toHaveLength(201);
    const k = result.rateConstant.value;
    expect(worst(result, 'C4H5NO5', (t) => a0 * Math.exp(-k * t), a0)).toBeLessThan(AGREEMENT);
    // One NO2 and one peroxy radical appear for every MPAN that decomposes.
    expect(worst(result, 'NO2', (t) => a0 * (1 - Math.exp(-k * t)), a0)).toBeLessThan(AGREEMENT);
    expect(worst(result, 'C4H5O3', (t) => a0 * (1 - Math.exp(-k * t)), a0)).toBeLessThan(AGREEMENT);
    // About five half-lives are covered, so the curve is not trivially flat.
    expect(result.concentrations.C4H5NO5![200]! / a0).toBeLessThan(0.05);
    expect(result.concentrations.C4H5NO5![200]! / a0).toBeGreaterThan(0.01);
  });

  it('first order: with made-up parameters, over twelve half-lives', () => {
    const result = simulateKinetics({ model: fixture(), temperatureK: 300, initialConcentrations: { N2O4: 0.02 }, durationSeconds: (12 * Math.LN2) / 0.5 });
    expect(result.status).toBe('ok');
    expect(worst(result, 'N2O4', (t) => 0.02 * Math.exp(-0.5 * t), 0.02)).toBeLessThan(AGREEMENT);
    expect(worst(result, 'NO2', (t) => 2 * 0.02 * (1 - Math.exp(-0.5 * t)), 0.02)).toBeLessThan(AGREEMENT);
    expect(result.concentrations.N2O4![200]! / 0.02).toBeCloseTo(2 ** -12, 7);
  });

  it('second order in one species: 1/[A] = 1/[A]0 + 2kt, with the factor 2 of the source convention', () => {
    const a0 = SCENARIOS['acetylperoxy-self']!.initial.C2H3O3!;
    const result = run('acetylperoxy-self');
    expect(result.status).toBe('ok');
    const k = result.rateConstant.value;
    // The data sheet defines k by −d[A]/dt = 2k[A]²; a missing factor of two would be far outside the tolerance.
    expect(worst(result, 'C2H3O3', (t) => a0 / (1 + 2 * k * a0 * t), a0)).toBeLessThan(AGREEMENT);
    expect(worst(result, 'C2H3O3', (t) => a0 / (1 + k * a0 * t), a0)).toBeGreaterThan(0.05);
    expect(worst(result, 'O2', (t) => (a0 - a0 / (1 + 2 * k * a0 * t)) / 2, a0)).toBeLessThan(AGREEMENT);
    expect(result.concentrations.C2H3O3![200]! / a0).toBeLessThan(0.1);
  });

  it('second order, A + B with unequal concentrations', () => {
    const { NO: a0, O3: b0 } = SCENARIOS['no-o3']!.initial as { NO: number; O3: number };
    const result = run('no-o3');
    expect(result.status).toBe('ok');
    const k = result.rateConstant.value;
    // Extent x(t) = a0 b0 (E − 1) / (b0 E − a0) with E = exp((b0 − a0) k t).
    const extent = (t: number): number => {
      const e = Math.exp((b0 - a0) * k * t);
      return (a0 * b0 * (e - 1)) / (b0 * e - a0);
    };
    expect(worst(result, 'NO', (t) => a0 - extent(t), a0)).toBeLessThan(AGREEMENT);
    expect(worst(result, 'O3', (t) => b0 - extent(t), a0)).toBeLessThan(AGREEMENT);
    expect(worst(result, 'NO2', (t) => extent(t), a0)).toBeLessThan(AGREEMENT);
    expect(worst(result, 'O2', (t) => extent(t), a0)).toBeLessThan(AGREEMENT);
    // The integrated rate law in its usual logarithmic form, while NO is still well above the tolerance.
    result.times.forEach((t, i) => {
      const a = result.concentrations.NO![i]!;
      const b = result.concentrations.O3![i]!;
      if (a > 0.01 * a0) expect(Math.log((b * a0) / (a * b0))).toBeCloseTo((b0 - a0) * k * t, 5);
    });
  });

  it('second order, A + B with equal concentrations: 1/[A] = 1/[A]0 + kt', () => {
    const a0 = 2e12;
    const result = run('no-o3', { initialConcentrations: { NO: a0, O3: a0 }, durationSeconds: 600 });
    const k = result.rateConstant.value;
    expect(worst(result, 'NO', (t) => a0 / (1 + k * a0 * t), a0)).toBeLessThan(AGREEMENT);
    expect(worst(result, 'O3', (t) => a0 / (1 + k * a0 * t), a0)).toBeLessThan(AGREEMENT);
  });

  it('third order with stoichiometric amounts: 1/[O2]² = 1/[O2]0² + 8kt', () => {
    const { NO: n0, O2: o0 } = SCENARIOS['no-o2-termolecular']!.initial as { NO: number; O2: number };
    expect(n0).toBe(2 * o0);
    const result = run('no-o2-termolecular');
    expect(result.status).toBe('ok');
    const k = result.rateConstant.value;
    // With [NO] = 2[O2] throughout, d[O2]/dt = −k (2[O2])² [O2] = −4k[O2]³.
    const oxygen = (t: number): number => (o0 ** -2 + 8 * k * t) ** -0.5;
    expect(worst(result, 'O2', oxygen, o0)).toBeLessThan(AGREEMENT);
    expect(worst(result, 'NO', (t) => 2 * oxygen(t), o0)).toBeLessThan(2 * AGREEMENT);
    expect(worst(result, 'NO2', (t) => 2 * (o0 - oxygen(t)), o0)).toBeLessThan(2 * AGREEMENT);
  });

  it('zero order: a straight line down to zero, then nothing', () => {
    const zero = fixture({ rateLaw: { orders: { N2O4: 0 }, description: 'rate = k' }, arrhenius: { A: 0.004, AUnits: 'mol L-1 s-1', EaKJPerMol: 0 } });
    const result = simulateKinetics({ model: zero, temperatureK: 300, initialConcentrations: { N2O4: 0.02 }, durationSeconds: 10, outputPoints: 101 });
    expect(result.status).toBe('ok');
    // The reactant is used up at t = 0.02 / 0.004 = 5 s; the kink there is resolved to the tolerance.
    expect(worst(result, 'N2O4', (t) => Math.max(0.02 - 0.004 * t, 0), 0.02)).toBeLessThan(1e-6);
    expect(worst(result, 'NO2', (t) => 2 * Math.min(0.004 * t, 0.02), 0.02)).toBeLessThan(2e-6);
    expect(result.concentrations.N2O4![100]).toBe(0);
    expect(result.concentrations.NO2![100]).toBe(0.04);
    expect(result.rates[0]).toBe(0.004);
    expect(result.rates[100]).toBe(0);
    expect(Math.min(...result.concentrations.N2O4!)).toBe(0);
  });

  it('a fractional order: √[A] falls linearly', () => {
    const half = fixture({ rateLaw: { orders: { N2O4: 0.5 }, description: 'rate = k [N2O4]^0.5' }, arrhenius: { A: 0.01, AUnits: 'mol0.5 L-0.5 s-1', EaKJPerMol: 0 } });
    const result = simulateKinetics({ model: half, temperatureK: 300, initialConcentrations: { N2O4: 0.04 }, durationSeconds: 30 });
    expect(result.status).toBe('ok');
    // d[A]/dt = −k√[A] gives √[A] = √[A]0 − kt/2, reaching zero at t = 2√[A]0/k = 40 s.
    expect(worst(result, 'N2O4', (t) => (0.2 - 0.005 * t) ** 2, 0.04)).toBeLessThan(AGREEMENT);
  });

  it('gets closer to the exact solution as the tolerance is tightened', () => {
    const errors = [1e-4, 1e-6, 1e-8, 1e-10].map((tolerance) => {
      const result = simulateKinetics({ model: fixture(), temperatureK: 300, initialConcentrations: { N2O4: 1 }, durationSeconds: 10, outputPoints: 51, tolerance });
      expect(result.solver.tolerance).toBe(tolerance);
      return { tolerance, error: worst(result, 'N2O4', (t) => Math.exp(-0.5 * t), 1), steps: result.solver.steps };
    });
    for (let i = 1; i < errors.length; i++) {
      expect(errors[i]!.error).toBeLessThan(errors[i - 1]!.error / 10);
      expect(errors[i]!.steps).toBeGreaterThan(errors[i - 1]!.steps);
    }
    for (const { tolerance, error } of errors) expect(error).toBeLessThan(10 * tolerance);
  });
});

describe('the analytic helpers themselves', () => {
  it('powerLawDecay reduces to the textbook integrated rate laws', () => {
    expect(powerLawDecay(2, 0.3, 1, 4)).toBeCloseTo(2 * Math.exp(-1.2), 14);
    expect(powerLawDecay(2, 0.3, 2, 4)).toBeCloseTo(1 / (1 / 2 + 0.3 * 4), 14);
    expect(powerLawDecay(2, 0.3, 0, 4)).toBeCloseTo(2 - 1.2, 14);
    expect(powerLawDecay(2, 0.3, 0, 10)).toBe(0);
    expect(powerLawDecay(2, 0.3, 3, 4)).toBeCloseTo((1 / 4 + 2 * 0.3 * 4) ** -0.5, 14);
    for (const order of [0, 0.5, 1, 1.5, 2, 3]) expect(powerLawDecay(2, 0.3, order, 0)).toBeCloseTo(2, 14);
  });

  it('powerLawHalfLife is the time at which powerLawDecay gives one half', () => {
    expect(powerLawHalfLife(2, 0.3, 1)).toBeCloseTo(Math.LN2 / 0.3, 14);
    expect(powerLawHalfLife(2, 0.3, 2)).toBeCloseTo(1 / (0.3 * 2), 14);
    expect(powerLawHalfLife(2, 0.3, 0)).toBeCloseTo(2 / (2 * 0.3), 14);
    for (const order of [0, 0.5, 1, 1.5, 2, 3]) expect(powerLawDecay(2, 0.3, order, powerLawHalfLife(2, 0.3, order))).toBeCloseTo(1, 12);
  });

  it('secondOrderTwoReactants satisfies its differential equation and its limits', () => {
    const k = 0.7;
    for (const [a0, b0] of [
      [1, 3],
      [3, 1],
      [2, 2],
      [1, 1 + 1e-9],
    ] as const) {
      expect(secondOrderTwoReactants(a0, b0, k, 0)).toEqual({ a: a0, b: b0, extent: 0 });
      for (const t of [0.1, 1, 5]) {
        const { a, b, extent } = secondOrderTwoReactants(a0, b0, k, t);
        expect(a).toBeCloseTo(a0 - extent, 14);
        expect(b).toBeCloseTo(b0 - extent, 14);
        // Central difference of the extent against the rate law dx/dt = k a b.
        const h = 1e-5;
        const slope = (secondOrderTwoReactants(a0, b0, k, t + h).extent - secondOrderTwoReactants(a0, b0, k, t - h).extent) / (2 * h);
        expect(slope).toBeCloseTo(k * a * b, 6);
      }
      // At long times the limiting reactant is used up.
      expect(secondOrderTwoReactants(a0, b0, k, 1e6).extent).toBeCloseTo(Math.min(a0, b0), 5);
    }
    // Nearly equal concentrations must not lose accuracy to cancellation.
    expect(secondOrderTwoReactants(1, 1 + 1e-9, k, 2).a).toBeCloseTo(secondOrderTwoReactants(1, 1, k, 2).a, 8);
  });
});

describe('simulateKinetics: conservation', () => {
  it('conserves every element along the trajectory of every model', () => {
    for (const m of KINETIC_MODELS) {
      const result = run(m.id);
      expect(result.status, m.id).toBe('ok');
      const compositions = result.species.map((name) => parseFormula(name).elements);
      const elements = [...new Set(compositions.flatMap((c) => Object.keys(c)))];
      for (const element of elements) {
        const total = (i: number): number => result.species.reduce((sum, name, s) => sum + (compositions[s]![element] ?? 0) * result.concentrations[name]![i]!, 0);
        const initial = total(0);
        expect(initial, `${m.id} ${element}`).toBeGreaterThan(0);
        result.times.forEach((_t, i) => {
          // Requested accuracy of the curves is 1e-8; the mass balance holds to rounding error regardless.
          expect(Math.abs(total(i) - initial) / initial, `${m.id} ${element} at point ${i}`).toBeLessThan(1e-12);
        });
      }
    }
  });

  it('keeps the changes of all species in their stoichiometric ratio', () => {
    const result = run('no-o2-termolecular');
    const { NO, O2, NO2 } = result.concentrations as Record<string, Float64Array>;
    result.times.forEach((_t, i) => {
      const consumedO2 = O2![0]! - O2![i]!;
      expect((NO![0]! - NO![i]!) / 1e17).toBeCloseTo((2 * consumedO2) / 1e17, 12);
      expect((NO2![i]! - NO2![0]!) / 1e17).toBeCloseTo((2 * consumedO2) / 1e17, 12);
    });
  });

  it('never lets a concentration go negative or a reactant rise', () => {
    for (const m of KINETIC_MODELS) {
      const result = run(m.id, { durationSeconds: SCENARIOS[m.id]!.duration * 1000 });
      expect(result.status, m.id).toBe('ok');
      const reactants = parseEquation(m.equation).reactants.map((t) => t.formula);
      for (const name of result.species) {
        const series = result.concentrations[name]!;
        expect(Math.min(...series), `${m.id} ${name}`).toBeGreaterThanOrEqual(0);
        if (reactants.includes(name)) for (let i = 1; i < series.length; i++) expect(series[i]!, `${m.id} ${name} ${i}`).toBeLessThanOrEqual(series[i - 1]!);
      }
    }
  });

  it('reports the rate of reaction that belongs to the concentrations', () => {
    const result = run('no-o2-termolecular');
    const k = result.rateConstant.value;
    result.times.forEach((_t, i) => {
      const expected = k * result.concentrations.NO![i]! ** 2 * result.concentrations.O2![i]!;
      expect(result.rates[i]! / expected).toBeCloseTo(1, 12);
    });
    expect(result.rateUnit).toBe('molecule cm-3 s-1');
    expect(result.concentrationUnit).toBe('molecule cm-3');
    // The rate only falls as the reactants are used up.
    for (let i = 1; i < result.rates.length; i++) expect(result.rates[i]!).toBeLessThan(result.rates[i - 1]!);
  });
});

describe('simulateKinetics: half-life', () => {
  it('is ln 2 / k for a first-order reaction and does not depend on the amount', () => {
    const result = run('mpan-decomposition');
    expect(result.halfLife).toEqual({ species: 'C4H5NO5', seconds: Math.LN2 / result.rateConstant.value, method: 'analytic' });
    expect(result.halfLifeSeconds).toBe(result.halfLife!.seconds);
    expect(run('mpan-decomposition', { initialConcentrations: { C4H5NO5: 7e3 } }).halfLifeSeconds).toBe(result.halfLifeSeconds);
  });

  it('is 1 / (2k[A]0) for the radical self-reaction', () => {
    const a0 = SCENARIOS['acetylperoxy-self']!.initial.C2H3O3!;
    const result = run('acetylperoxy-self');
    expect(result.halfLife!.method).toBe('analytic');
    expect(result.halfLifeSeconds! * 2 * result.rateConstant.value * a0).toBeCloseTo(1, 12);
  });

  it('is found by quadrature for a rate law with two species, and matches the closed form', () => {
    const { NO: a0, O3: b0 } = SCENARIOS['no-o3']!.initial as { NO: number; O3: number };
    const result = run('no-o3');
    expect(result.halfLife!.species).toBe('NO');
    expect(result.halfLife!.method).toBe('numerical-quadrature');
    const k = result.rateConstant.value;
    const exact = Math.log((a0 * (b0 - a0 / 2)) / (b0 * (a0 / 2))) / ((b0 - a0) * k);
    expect(result.halfLifeSeconds! / exact).toBeCloseTo(1, 8);
    // The curve itself passes through one half at that time.
    const check = run('no-o3', { durationSeconds: result.halfLifeSeconds!, outputPoints: 2 });
    expect(check.concentrations.NO![1]! / a0).toBeCloseTo(0.5, 7);
  });

  it('refers to the limiting reactant', () => {
    const result = run('no-o3', { initialConcentrations: { NO: 5e12, O3: 1e12 } });
    expect(result.halfLife!.species).toBe('O3');
    const terms = run('no-o2-termolecular', { initialConcentrations: { NO: 1e17, O2: 1e18 } });
    expect(terms.halfLife!.species).toBe('NO');
  });

  it('does not depend on how long the simulation runs', () => {
    const short = run('no-o3', { durationSeconds: 1 });
    const long = run('no-o3', { durationSeconds: 1e6 });
    expect(short.halfLifeSeconds).toBe(long.halfLifeSeconds);
    expect(short.halfLifeSeconds!).toBeGreaterThan(1);
  });

  it('is null when nothing reacts', () => {
    const result = run('no-o3', { initialConcentrations: { NO: 1e12, O3: 0 } });
    expect(result.status).toBe('ok');
    expect(result.halfLifeSeconds).toBeNull();
    expect(result.halfLife).toBeNull();
    expect(result.warnings.join(' ')).toMatch(/reaction rate is zero at the start and stays zero/);
    expect(Array.from(result.concentrations.NO!).every((c) => c === 1e12)).toBe(true);
    expect(Array.from(result.rates).every((r) => r === 0)).toBe(true);
    const empty = run('no-o3', { initialConcentrations: { NO: 0, O3: 0 } });
    expect(empty.status).toBe('ok');
    expect(empty.warnings.join(' ')).toMatch(/Every initial concentration is zero/);
    expect(empty.halfLifeSeconds).toBeNull();
  });
});

describe('simulateKinetics: output', () => {
  it('returns equally spaced times, one series per species, and the solver record', () => {
    const result = run('no-o3', { outputPoints: 11 });
    expect(Array.from(result.times)).toEqual([0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300]);
    expect(result.species).toEqual(['NO', 'O3', 'NO2', 'O2']);
    expect(Object.keys(result.concentrations)).toEqual(result.species);
    for (const name of result.species) expect(result.concentrations[name]).toHaveLength(11);
    expect(result.rates).toHaveLength(11);
    expect(result.concentrations.NO![0]).toBe(1e12);
    expect(result.concentrations.O3![0]).toBe(3e12);
    expect(result.concentrations.NO2![0]).toBe(0);
    expect(result.solver.method).toBe(KINETICS_SOLVER_METHOD);
    expect(result.solver.method).toMatch(/Dormand-Prince 5\(4\)/);
    expect(result.solver.steps).toBeGreaterThan(5);
    expect(result.solver.rejectedSteps).toBeGreaterThanOrEqual(0);
    expect(result.reasons).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.evidence).toBe('computed');
    expect(result.withinValidatedRange).toBe(true);
    expect(result.rateConstant).toMatchObject({ unit: 'cm3 molecule-1 s-1', evidence: 'computed' });
    expect(result.rateConstant.value).toBe(rateConstant(model('no-o3'), 298).k.value);
  });

  it('uses 201 output points by default', () => {
    expect(run('no-o3').times).toHaveLength(201);
  });

  it('starts products that are given a concentration from that concentration', () => {
    const result = run('no-o3', { initialConcentrations: { NO: 1e12, O3: 3e12, NO2: 4e11 } });
    expect(result.concentrations.NO2![0]).toBe(4e11);
    expect(result.concentrations.NO2![200]! - 4e11).toBeCloseTo(1e12 - result.concentrations.NO![200]!, -1);
  });

  it('accepts another spelling of a species, and ignores a species that is not part of the reaction with a warning', () => {
    const result = run('oh-h2', { initialConcentrations: { HO: 1e7, H2: 1.3e13, Ar: 2.4e19 } });
    expect(result.status).toBe('ok');
    expect(result.concentrations.OH![0]).toBe(1e7);
    expect(result.warnings).toEqual(['Ar is not a species of "OH + H2 -> H2O + H"; its initial concentration was ignored.']);
    expect(result.species).not.toContain('Ar');
  });

  it('holds the fully converted composition once the reaction is complete, instead of grinding on', () => {
    const a0 = 2.5e10;
    const result = run('mpan-decomposition', { durationSeconds: 1e7, outputPoints: 101 });
    expect(result.status).toBe('ok');
    expect(result.times).toHaveLength(101);
    expect(result.times[100]).toBe(1e7);
    const complete = result.solver.reactionCompleteAfterSeconds!;
    // Complete to within 1 % of the tolerance after roughly ln(1e10) = 23 time constants.
    const timeConstant = 1 / result.rateConstant.value;
    expect(complete).toBeGreaterThan(20 * timeConstant);
    expect(complete).toBeLessThan(40 * timeConstant);
    expect(result.solver.steps).toBeLessThan(200);
    expect(result.concentrations.C4H5NO5![100]).toBe(0);
    expect(result.concentrations.NO2![100]).toBe(a0);
    expect(result.concentrations.C4H5O3![100]).toBe(a0);
    expect(result.rates[100]).toBe(0);
    // Before completion the curve is the ordinary exponential.
    expect(result.concentrations.C4H5NO5![0]).toBe(a0);
    expect(run('mpan-decomposition').solver.reactionCompleteAfterSeconds).toBeUndefined();
  });
});

describe('simulateKinetics: outside the validated range', () => {
  it('still simulates, with a prominent warning, a flag and a weaker evidence label', () => {
    const m = model('no-o3');
    const result = run('no-o3', { temperatureK: 500 });
    expect(result.status).toBe('ok');
    expect(result.withinValidatedRange).toBe(false);
    expect(result.warnings[0]).toMatch(/^TEMPERATURE OUTSIDE THE VALIDATED RANGE/);
    expect(result.warnings[0]).toContain(`recommended for ${m.validTemperatureRangeK[0]} K to ${m.validTemperatureRangeK[1]} K, and 500 K is above that range`);
    expect(result.evidence).toBe('rule-based');
    expect(result.rateConstant.evidence).toBe('rule-based');
    expect(result.rateConstant.value).toBe(rateConstant(m, 500).k.value);
    // The numbers are those of the extrapolated rate constant, not a made-up curve.
    const { NO: a0, O3: b0 } = SCENARIOS['no-o3']!.initial as { NO: number; O3: number };
    const k = result.rateConstant.value;
    result.times.forEach((t, i) => {
      expect(Math.abs(result.concentrations.NO![i]! - secondOrderTwoReactants(a0, b0, k, t).a) / a0).toBeLessThan(1e-7);
    });
    const cold = run('no-o3', { temperatureK: 150 });
    expect(cold.withinValidatedRange).toBe(false);
    expect(cold.warnings[0]).toContain('150 K is below that range');
  });

  it('is inside the range at its ends', () => {
    const [low, high] = model('no-o3').validTemperatureRangeK;
    for (const temperature of [low, high]) {
      const result = run('no-o3', { temperatureK: temperature });
      expect(result.withinValidatedRange).toBe(true);
      expect(result.evidence).toBe('computed');
      expect(result.warnings).toEqual([]);
    }
  });

  it('labels a simulation of made-up parameters as user input, inside or outside the range', () => {
    const inside = simulateKinetics({ model: fixture(), temperatureK: 300, initialConcentrations: { N2O4: 1 }, durationSeconds: 1 });
    expect(inside.evidence).toBe('user-input');
    expect(inside.warnings).toEqual(['The rate parameters of "Solver test fixture" are labelled "user-input", not reference data.']);
    const outside = simulateKinetics({ model: fixture(), temperatureK: 900, initialConcentrations: { N2O4: 1 }, durationSeconds: 1 });
    expect(outside.evidence).toBe('user-input');
    expect(outside.withinValidatedRange).toBe(false);
    expect(outside.warnings[0]).toMatch(/^TEMPERATURE OUTSIDE THE VALIDATED RANGE/);
  });
});

describe('simulateKinetics: requests it will not simulate', () => {
  const base = { model: model('no-o3'), temperatureK: 298, initialConcentrations: { NO: 1e12, O3: 3e12 }, durationSeconds: 300 };

  function expectUnsupported(result: KineticsResult, reason: RegExp): void {
    expect(result.status).toBe('unsupported');
    expect(result.reasons.join(' | ')).toMatch(reason);
    expect(result.evidence).toBe('unsupported');
    expect(result.times).toHaveLength(0);
    expect(result.rates).toHaveLength(0);
    for (const series of Object.values(result.concentrations)) expect(series).toHaveLength(0);
    expect(result.halfLifeSeconds).toBeNull();
    expect(result.rateConstant.evidence).toBe('unsupported');
    expect(result.solver.steps).toBe(0);
  }

  it('returns a status and the reasons, never a curve and never an exception', () => {
    expectUnsupported(simulateKinetics({ ...base, temperatureK: 0 }), /temperature must be a positive number/);
    expectUnsupported(simulateKinetics({ ...base, temperatureK: Number.NaN }), /temperature must be a positive number/);
    expectUnsupported(simulateKinetics({ ...base, durationSeconds: 0 }), /duration must be a positive number/);
    expectUnsupported(simulateKinetics({ ...base, durationSeconds: -10 }), /duration must be a positive number/);
    expectUnsupported(simulateKinetics({ ...base, durationSeconds: Number.POSITIVE_INFINITY }), /duration must be a positive number/);
    expectUnsupported(simulateKinetics({ ...base, outputPoints: 1 }), /outputPoints must be a whole number/);
    expectUnsupported(simulateKinetics({ ...base, outputPoints: 10.5 }), /outputPoints must be a whole number/);
    expectUnsupported(simulateKinetics({ ...base, tolerance: 0 }), /tolerance must lie between/);
    expectUnsupported(simulateKinetics({ ...base, tolerance: 0.5 }), /tolerance must lie between/);
    expectUnsupported(simulateKinetics({ ...base, maxSteps: 0 }), /maxSteps must be a positive whole number/);
    expectUnsupported(simulateKinetics({ ...base, initialConcentrations: { NO: -1, O3: 3e12 } }), /initial concentration of NO must be a non-negative number/);
    expectUnsupported(simulateKinetics({ ...base, initialConcentrations: { NO: Number.NaN, O3: 3e12 } }), /initial concentration of NO must be a non-negative number/);
    expectUnsupported(simulateKinetics({ ...base, initialConcentrations: { NO: 1e12 } }), /No initial concentration was given for O3, which the rate law depends on/);
    expectUnsupported(simulateKinetics({ ...base, initialConcentrations: {} }), /No initial concentration was given for NO.*No initial concentration was given for O3/);
    expectUnsupported(simulateKinetics({ ...base, initialConcentrations: { NO: 1e12, O3: 3e12, 'N=O': 1 } as Record<string, number>, temperatureK: -3 }), /temperature/);
  });

  it('keeps the rate constant when only the request, not the model, is at fault', () => {
    const result = simulateKinetics({ ...base, durationSeconds: -1 });
    expect(result.status).toBe('unsupported');
    expect(result.rateConstant.value).toBe(rateConstant(base.model, 298).k.value);
    expect(Number.isNaN(simulateKinetics({ ...base, temperatureK: -1 }).rateConstant.value)).toBe(true);
  });

  it('refuses a model that is not internally consistent', () => {
    const inputs = { temperatureK: 300, initialConcentrations: { N2O4: 1 }, durationSeconds: 1 };
    expectUnsupported(simulateKinetics({ ...inputs, model: fixture({ equation: 'N2O4 -> NO2' }) }), /is not balanced/);
    expectUnsupported(simulateKinetics({ ...inputs, model: fixture({ equation: 'N2O4 to NO2' }) }), /cannot be read: No reaction arrow/);
    expectUnsupported(simulateKinetics({ ...inputs, model: fixture({ rateLaw: { orders: { N2O5: 1 }, description: '' } }) }), /rate law refers to N2O5, which is not a species/);
    expectUnsupported(simulateKinetics({ ...inputs, model: fixture({ rateLaw: { orders: { N2O4: -1 }, description: '' } }) }), /order of N2O4 must be a non-negative number/);
    expectUnsupported(simulateKinetics({ ...inputs, model: fixture({ arrhenius: { A: -1, AUnits: 's-1', EaKJPerMol: 0 } }) }), /Arrhenius parameters/);
    expectUnsupported(simulateKinetics({ ...inputs, model: fixture({ arrhenius: { A: 1, AUnits: 's-1', EaKJPerMol: Number.NaN } }) }), /Arrhenius parameters/);
    expectUnsupported(simulateKinetics({ ...inputs, model: fixture({ equation: 'N2O4 + NO2 -> N2O4 + NO2' }) }), /consumes no species/);
  });

  it('reports every problem at once', () => {
    const result = simulateKinetics({ ...base, temperatureK: -1, durationSeconds: 0, initialConcentrations: { NO: -5 } });
    expect(result.status).toBe('unsupported');
    expect(result.reasons).toHaveLength(4);
  });

  it('refuses two concentrations for one species', () => {
    const result = simulateKinetics({ model: model('oh-h2'), temperatureK: 298, initialConcentrations: { OH: 1e7, HO: 2e7, H2: 1e13 }, durationSeconds: 1 });
    expectUnsupported(result, /initial concentration of OH is given more than once/);
  });

  it('returns the part it computed, marked incomplete, when the step limit is reached', () => {
    const result = simulateKinetics({ ...base, tolerance: 1e-12, maxSteps: 20 });
    expect(result.status).toBe('incomplete');
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toMatch(/The integration stopped at t = [\d.e+-]+ s of 300 s because the limit of 20 step attempts was reached/);
    expect(result.times.length).toBeGreaterThan(0);
    expect(result.times.length).toBeLessThan(201);
    expect(result.times[result.times.length - 1]!).toBeLessThan(300);
    for (const name of result.species) expect(result.concentrations[name]).toHaveLength(result.times.length);
    expect(result.rates).toHaveLength(result.times.length);
    // What was computed is still right.
    const k = result.rateConstant.value;
    result.times.forEach((t, i) => {
      expect(Math.abs(result.concentrations.NO![i]! - secondOrderTwoReactants(1e12, 3e12, k, t).a) / 1e12).toBeLessThan(1e-9);
    });
    // Given enough steps the same request completes.
    expect(simulateKinetics({ ...base, tolerance: 1e-12 }).status).toBe('ok');
  });
});

describe('findKineticModels', () => {
  it('finds the model for an equation, however it is scaled or spelled', () => {
    expect(findKineticModels('NO + O3 -> NO2 + O2').map((m) => m.id)).toEqual(['no-o3']);
    expect(findKineticModels('O3 + NO -> O2 + NO2').map((m) => m.id)).toEqual(['no-o3']);
    expect(findKineticModels('NO(g) + O3(g) -> NO2(g) + O2(g)').map((m) => m.id)).toEqual(['no-o3']);
    expect(findKineticModels('2 NO + O2 -> 2 NO2').map((m) => m.id)).toEqual(['no-o2-termolecular']);
    expect(findKineticModels('NO + 1/2 O2 -> NO2').map((m) => m.id)).toEqual(['no-o2-termolecular']);
    expect(findKineticModels('HO + H2 -> H2O + H').map((m) => m.id)).toEqual(['oh-h2']);
    expect(findKineticModels(parseEquation('O + O3 -> 2 O2')).map((m) => m.id)).toEqual(['o-o3']);
    for (const m of KINETIC_MODELS) expect(findKineticModels(m.equation), m.id).toEqual([m]);
  });

  it('finds nothing for a reaction without a sourced rate law, and never substitutes a similar one', () => {
    expect(findKineticModels('NO2 + O2 -> NO + O3')).toEqual([]);
    expect(findKineticModels('2 H2 + O2 -> 2 H2O')).toEqual([]);
    expect(findKineticModels('NO + O3 -> NO2 + 2 O')).toEqual([]);
    expect(findKineticModels('2 NO + O3 -> 2 NO2 + O2')).toEqual([]);
    expect(findKineticModels('NO + O3 + N2 -> NO2 + O2 + N2')).toEqual([]);
    expect(findKineticModels('NO(aq) + O3(aq) -> NO2(aq) + O2(aq)')).toEqual([]);
    expect(findKineticModels('H+(aq) + OH-(aq) -> H2O(l)')).toEqual([]);
  });
});
