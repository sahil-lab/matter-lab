import { describe, expect, it } from 'vitest';
import {
  KINETIC_MODELS,
  SUPPORTED_REACTION_CLASSES,
  THERMO_SPECIES,
  UNSUPPORTED_FEATURES,
  balanceEquation,
  checkConservation,
  findKineticModels,
  parseEquation,
  reactionSupport,
  reactionThermodynamics,
} from '../src';

/** The example as a balanced equation: as written when it already is, otherwise with the coefficients the balancer finds. */
function balancedExample(text: string) {
  const result = balanceEquation(text);
  expect(['balanced', 'already-balanced'], `${text}: ${result.message}`).toContain(result.status);
  return result.equation!;
}

const hasThermodynamics = (text: string): boolean => ['ok', 'partial'].includes(reactionThermodynamics(balancedExample(text)).status);

describe('SUPPORTED_REACTION_CLASSES', () => {
  it('describes each class with a name, a description, examples and its limits', () => {
    expect(SUPPORTED_REACTION_CLASSES.length).toBeGreaterThanOrEqual(8);
    expect(new Set(SUPPORTED_REACTION_CLASSES.map((c) => c.id)).size).toBe(SUPPORTED_REACTION_CLASSES.length);
    for (const info of SUPPORTED_REACTION_CLASSES) {
      expect(info.id, info.id).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(info.name.length, info.id).toBeGreaterThan(5);
      expect(info.description.length, info.id).toBeGreaterThan(30);
      expect(info.exampleEquations.length, info.id).toBeGreaterThan(0);
      expect(info.limitations.length, info.id).toBeGreaterThan(0);
      expect(new Set(info.exampleEquations).size, info.id).toBe(info.exampleEquations.length);
    }
  });

  it('claims stoichiometry only where every example parses and balances uniquely', () => {
    for (const info of SUPPORTED_REACTION_CLASSES) {
      expect(info.supports.stoichiometry, info.id).toBe(true);
      for (const example of info.exampleEquations) {
        expect(() => parseEquation(example), example).not.toThrow();
        expect(checkConservation(balancedExample(example)).balanced, example).toBe(true);
      }
    }
  });

  it('claims thermodynamics exactly where every example can be evaluated from the table', () => {
    for (const info of SUPPORTED_REACTION_CLASSES) {
      const covered = info.exampleEquations.filter(hasThermodynamics);
      if (info.supports.thermodynamics) expect(covered, info.id).toEqual(info.exampleEquations);
      else expect(covered.length, info.id).toBeLessThan(info.exampleEquations.length);
    }
    expect(SUPPORTED_REACTION_CLASSES.filter((c) => c.supports.thermodynamics).length).toBeGreaterThanOrEqual(5);
  });

  it('claims kinetics exactly where every example has a sourced rate law', () => {
    for (const info of SUPPORTED_REACTION_CLASSES) {
      const modelled = info.exampleEquations.filter((example) => findKineticModels(balancedExample(example)).length > 0);
      if (info.supports.kinetics) expect(modelled, info.id).toEqual(info.exampleEquations);
      else expect(modelled, info.id).toEqual([]);
    }
  });

  it('lists every kinetic model under a class that supports kinetics, and nothing else there', () => {
    const kineticClasses = SUPPORTED_REACTION_CLASSES.filter((c) => c.supports.kinetics);
    for (const model of KINETIC_MODELS) {
      const info = kineticClasses.find((c) => c.id === model.reactionClass);
      expect(info, model.id).toBeDefined();
      expect(info!.exampleEquations, model.id).toContain(model.equation);
    }
    expect(kineticClasses.flatMap((c) => c.exampleEquations).sort()).toEqual(KINETIC_MODELS.map((m) => m.equation).sort());
  });

  it('is accurate in what its limitation texts say', () => {
    const bimolecular = SUPPORTED_REACTION_CLASSES.find((c) => c.id === 'gas-bimolecular')!;
    expect(bimolecular.limitations.join(' ')).toMatch(/\(NO \+ O3 and O \+ O3\)/);
    expect(bimolecular.exampleEquations.filter(hasThermodynamics)).toEqual(['NO + O3 -> NO2 + O2', 'O + O3 -> 2 O2']);
    const combustion = SUPPORTED_REACTION_CLASSES.find((c) => c.id === 'combustion')!;
    expect(combustion.limitations.join(' ')).toMatch(/for ethane, propane and gaseous benzene the table has no entropy/);
    expect(THERMO_SPECIES.filter((sp) => sp.s298 === null).map((sp) => sp.name)).toEqual(['ethane', 'propane', 'benzene']);
    // "Half-reactions can be balanced but not evaluated."
    const half = SUPPORTED_REACTION_CLASSES.find((c) => c.id === 'redox-balancing')!.exampleEquations.find((e) => e.includes('e-'))!;
    expect(balanceEquation(half).status).toBe('already-balanced');
    expect(reactionThermodynamics(half).status).toBe('missing-data');
  });

  it('never suggests that listing a class means its reactions occur', () => {
    for (const info of SUPPORTED_REACTION_CLASSES) {
      expect(`${info.description} ${info.limitations.join(' ')}`, info.id).not.toMatch(/\b(will react|always reacts|reacts spontaneously)\b/i);
    }
  });
});

describe('UNSUPPORTED_FEATURES', () => {
  it('states plainly what the package does not do', () => {
    expect(new Set(UNSUPPORTED_FEATURES.map((f) => f.id)).size).toBe(UNSUPPORTED_FEATURES.length);
    for (const feature of UNSUPPORTED_FEATURES) {
      expect(feature.name.length, feature.id).toBeGreaterThan(5);
      expect(feature.description.length, feature.id).toBeGreaterThan(40);
    }
    const ids = UNSUPPORTED_FEATURES.map((f) => f.id);
    for (const required of ['reaction-prediction', 'mechanisms', 'solution-kinetics', 'non-standard-conditions', 'temperature-dependent-thermodynamics', 'missing-species']) {
      expect(ids).toContain(required);
    }
    expect(UNSUPPORTED_FEATURES.find((f) => f.id === 'reaction-prediction')!.description).toMatch(/never decides whether substances react/);
  });
});

describe('reactionSupport', () => {
  it('reports full support where there is some', () => {
    const support = reactionSupport('2 NO + O2 -> 2 NO2');
    expect(support.balanced).toBe(true);
    expect(support.balancing).toBe('already-balanced');
    expect(support.thermodynamics).toEqual({ available: true, status: 'ok', missingSpecies: [], missingEntropy: [] });
    expect(support.kinetics).toEqual({ available: true, modelIds: ['no-o2-termolecular'] });
    expect(support.notes).toEqual(['Support describes what can be calculated for the equation as written. It is not a statement that the reaction takes place.']);
  });

  it('reports thermodynamics without kinetics for an ordinary textbook reaction', () => {
    const support = reactionSupport('CH4(g) + 2 O2(g) -> CO2(g) + 2 H2O(l)');
    expect(support.thermodynamics.available).toBe(true);
    expect(support.kinetics).toEqual({ available: false, modelIds: [] });
    expect(support.notes.join(' ')).toMatch(/No sourced rate law is available for this reaction/);
  });

  it('reports kinetics without thermodynamics, and what is missing', () => {
    const support = reactionSupport('OH + H2 -> H2O + H');
    expect(support.kinetics.modelIds).toEqual(['oh-h2']);
    expect(support.thermodynamics.available).toBe(false);
    expect(support.thermodynamics.status).toBe('missing-data');
    expect(support.thermodynamics.missingSpecies).toEqual(['OH']);
  });

  it('reports partial thermodynamics', () => {
    const support = reactionSupport('C3H8(g) + 5 O2(g) -> 3 CO2(g) + 4 H2O(l)');
    expect(support.thermodynamics).toEqual({ available: true, status: 'partial', missingSpecies: [], missingEntropy: ['C3H8(g)'] });
  });

  it('reports an unbalanced or unbalanceable equation', () => {
    const unbalanced = reactionSupport('H2(g) + O2(g) -> H2O(l)');
    expect(unbalanced.balanced).toBe(false);
    expect(unbalanced.balancing).toBe('balanced');
    expect(unbalanced.thermodynamics).toMatchObject({ available: false, status: 'unbalanced' });
    expect(unbalanced.notes.join(' ')).toMatch(/not balanced as written/);
    expect(reactionSupport('C + O2 -> CO + CO2').balancing).toBe('underdetermined');
    expect(reactionSupport('NaCl -> KCl').balancing).toBe('impossible');
  });

  it('supports nothing but bookkeeping for most reactions, and says so rather than guessing', () => {
    const support = reactionSupport('Fe2O3 + 2 Al -> Al2O3 + 2 Fe');
    expect(support.balanced).toBe(true);
    expect(support.thermodynamics.available).toBe(false);
    expect(support.thermodynamics.missingSpecies).toEqual(['Fe2O3', 'Fe']);
    expect(support.kinetics.available).toBe(false);
  });
});
