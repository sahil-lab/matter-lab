import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  EXPERIMENT_ENGINE_VERSION,
  EXPERIMENT_PRESETS,
  EXPERIMENT_STEP_IDS,
  LIMITATION_PHRASES,
  REACTION_CATALOGUE,
  SUPPORTED_REACTION_CLASSES,
  checkConservation,
  parseEquation,
  parseExperimentResult,
  runExperiment,
  serializeExperimentResult,
  suggestReactions,
} from '../src';
import type { ExperimentInput, ExperimentResult, ExperimentStepId } from '../src';
import { AMMONIA, HCL, IRON, METHANE, MPAN, NO2_O3, NO_O2, NO_O3, OH_H2, STANDARD, allText, experiment, product, reactant, species, stepOf } from './experiment-helpers';

/**
 * The experiment pipeline is what the Reaction Laboratory runs. These tests hold it to the rules of
 * the laboratory: it works on what was entered and predicts nothing, it refuses instead of guessing,
 * it says what it did not model, it can be stopped, and it gives the same answer every time.
 */

const GAS_CONSTANT = 8.314462618; // J/(mol K), exact
const NOT_RUN = /^Not run: /;

const ran = (result: ExperimentResult): ExperimentStepId[] => result.steps.filter((step) => !NOT_RUN.test(step.summary)).map((step) => step.id);
const kindsOf = (result: ExperimentResult, quantity: 'enthalpy' | 'gibbs'): string[] => (result.energyDiagrams.find((d) => d.quantity === quantity)?.levels ?? []).map((level) => level.kind);

describe('the shape of every result', () => {
  it.each(EXPERIMENT_PRESETS.map((preset) => [preset.id, preset] as const))('preset %s runs and ends as documented', (_id, preset) => {
    const result = runExperiment(preset.input);
    expect(result.status).toBe(preset.expectedStatus);
    expect(result.schema).toBe('matterlab.experiment-result');
    expect(result.schemaVersion).toBe(1);
    expect(result.steps.map((step) => step.id)).toEqual([...EXPERIMENT_STEP_IDS]);
    expect(result.inputHash).toMatch(/^[0-9a-f]{64}$/);
    for (const step of result.steps) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.summary.length).toBeGreaterThan(0);
    }
    expect(SUPPORTED_REACTION_CLASSES.some((entry) => entry.id === preset.reactionClass), preset.reactionClass).toBe(true);
    // Both explanations exist whatever the outcome, and no sentence is left with an unfilled value.
    expect(result.explanation.beginner.length).toBeGreaterThan(0);
    expect(result.explanation.advanced.length).toBeGreaterThan(0);
    for (const sentence of allText(result)) expect(sentence).not.toMatch(/undefined|NaN|\[object/);
  });

  it('has between eight and twelve presets with distinct ids, at least one of them a deliberate refusal', () => {
    expect(EXPERIMENT_PRESETS.length).toBeGreaterThanOrEqual(8);
    expect(EXPERIMENT_PRESETS.length).toBeLessThanOrEqual(12);
    expect(new Set(EXPERIMENT_PRESETS.map((preset) => preset.id)).size).toBe(EXPERIMENT_PRESETS.length);
    expect(EXPERIMENT_PRESETS.some((preset) => preset.expectedStatus === 'unsupported')).toBe(true);
    expect(EXPERIMENT_PRESETS.some((preset) => preset.expectedStatus === 'partial')).toBe(true);
  });

  it('reports the version of the package that produced it', () => {
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string };
    expect(EXPERIMENT_ENGINE_VERSION).toBe(manifest.version);
    const result = runExperiment(experiment(METHANE));
    expect(result.reproducibility).toMatchObject({ engine: '@matterlab/reactions', engineVersion: manifest.version, deterministic: true });
  });
});

describe('what is computed', () => {
  it('balances and evaluates the combustion of methane against published values', () => {
    const result = runExperiment(experiment(METHANE));
    expect(result.status).toBe('completed');
    expect(result.equation!.text).toBe('CH4(g) + 2 O2(g) -> CO2(g) + 2 H2O(l)');
    expect(checkConservation(result.equation!.balanced).balanced).toBe(true);
    // Standard enthalpy of combustion of methane to liquid water: -890.3 kJ/mol; Gibbs energy about -818 kJ/mol.
    expect(Math.abs(result.thermo!.deltaH!.value - -890.3)).toBeLessThan(0.6);
    expect(Math.abs(result.thermo!.deltaG!.value - -818)).toBeLessThan(1.5);
    expect(result.thermo!.spontaneity).toBe('product-favoured');
    // No flame kinetics: nothing is simulated and no rate law of a similar reaction stands in.
    expect(result.kineticModel).toBeNull();
    expect(result.rateConstant).toBeNull();
    expect(result.kinetics).toBeNull();
    expect(result.reproducibility.solver).toBeNull();
    expect(stepOf(result, 'model-selection').summary).toMatch(/no sourced rate law/);
  });

  it('runs thermodynamics and kinetics together for NO + O3 and reports the solver', () => {
    const result = runExperiment(experiment(NO_O3, 'auto', { temperatureK: 298, durationSeconds: 300 }));
    expect(result.status).toBe('completed');
    expect(result.equation!.text).toBe('NO(g) + O3(g) -> NO2(g) + O2(g)');
    // Conservation alone leaves this equation open (2 O3 -> 3 O2 also conserves everything), which the step says.
    expect(stepOf(result, 'conservation').status).toBe('warning');
    expect(result.kineticModel!.id).toBe('no-o3');
    // IUPAC preferred value: k = 1.4e-12 exp(-1310/T) cm3 molecule-1 s-1.
    expect(result.rateConstant!.k.value).toBeCloseTo(1.4e-12 * Math.exp(-1310 / 298), 20);
    expect(result.rateConstant!.withinValidatedRange).toBe(true);
    expect(result.kinetics!.status).toBe('ok');
    expect(result.kinetics!.times).toHaveLength(201);
    // Half-life of NO from the closed-form solution with [O3]0 = 2 [NO]0: ln(1.5) / (k ([O3]0 - [NO]0)).
    expect(result.kinetics!.halfLife!.seconds).toBeCloseTo(Math.log(1.5) / (result.rateConstant!.k.value * 5e11), 4);
    const solver = result.reproducibility.solver!;
    expect(solver.tolerance).toBe(1e-8);
    expect(solver.steps).toBe(result.kinetics!.solver.steps);
    expect(solver.steps).toBeGreaterThan(0);
    expect(result.evidence).toBe('computed');
  });

  it('labels the weakest evidence among what it shows', () => {
    expect(runExperiment(experiment(AMMONIA, 'auto', { temperatureK: 700 })).evidence).toBe('rule-based');
    expect(runExperiment(experiment(OH_H2, 'kinetics', { temperatureK: 900 })).evidence).toBe('rule-based');
    expect(runExperiment(experiment(METHANE.slice(0, 2))).evidence).toBe('unsupported');
  });

  it('converts a rate law to mol/L when concentrations are entered in that unit, without changing the physics', () => {
    const perCm3 = runExperiment(experiment(NO_O3, 'kinetics', { temperatureK: 298 }));
    const avogadroPerLitre = 6.02214076e20; // molecules per cm3 in 1 mol/L, exact
    const molar = runExperiment(
      experiment(
        [reactant('NO', 'g', { initialConcentration: 5e11 / avogadroPerLitre }), reactant('O3', 'g', { initialConcentration: 1e12 / avogadroPerLitre }), product('NO2', 'g'), product('O2', 'g')],
        'kinetics',
        { temperatureK: 298, concentrationUnit: 'mol/L' },
      ),
    );
    expect(molar.status).toBe('completed');
    expect(molar.kineticModel!.concentrationUnit).toBe('mol/L');
    expect(molar.rateConstant!.k.value / perCm3.rateConstant!.k.value).toBeCloseTo(avogadroPerLitre, -12);
    // The same experiment in other units has the same half-life and the same fractional conversion.
    expect(molar.kinetics!.halfLife!.seconds).toBeCloseTo(perCm3.kinetics!.halfLife!.seconds, 6);
    const last = perCm3.kinetics!.times.length - 1;
    expect(molar.kinetics!.concentrations.NO![last]! * avogadroPerLitre).toBeCloseTo(perCm3.kinetics!.concentrations.NO![last]!, -4);
  });
});

describe('the method that was asked for', () => {
  it('stoichiometry stops at the balanced equation', () => {
    const result = runExperiment(experiment(METHANE, 'stoichiometry'));
    expect(result.status).toBe('completed');
    expect(result.equation!.text).toBe('CH4(g) + 2 O2(g) -> CO2(g) + 2 H2O(l)');
    expect(result.thermo).toBeNull();
    expect(result.kinetics).toBeNull();
    expect(result.energyDiagrams).toEqual([]);
    expect(stepOf(result, 'reference-data').status).toBe('skipped');
    expect(stepOf(result, 'calculation').status).toBe('skipped');
    expect(result.explanation.references).toEqual([]);
  });

  it('thermodynamics leaves the rate law alone even where one exists', () => {
    const result = runExperiment(experiment(NO_O3, 'thermodynamics'));
    expect(result.status).toBe('completed');
    expect(result.thermo!.status).toBe('ok');
    expect(result.kineticModel).toBeNull();
    expect(result.kinetics).toBeNull();
    expect(kindsOf(result, 'enthalpy')).toEqual(['reactants', 'products']);
  });

  it('kinetics leaves the reference table alone', () => {
    const result = runExperiment(experiment(NO_O3, 'kinetics', { temperatureK: 298 }));
    expect(result.status).toBe('completed');
    expect(result.thermo).toBeNull();
    expect(result.kinetics!.status).toBe('ok');
    expect(result.energyDiagrams.some((diagram) => diagram.quantity === 'gibbs')).toBe(false);
  });

  it('refuses kinetics when no sourced rate law exists, and says that none is substituted', () => {
    const result = runExperiment(experiment(HCL, 'kinetics'));
    expect(result.status).toBe('unsupported');
    expect(result.kineticModel).toBeNull();
    expect(result.rateConstant).toBeNull();
    expect(result.kinetics).toBeNull();
    expect(stepOf(result, 'model-selection').status).toBe('failed');
    expect(result.warnings.join(' ')).toMatch(/does not substitute the rate law of a similar reaction/);
    // The balanced equation is still reported; it was established before the refusal.
    expect(result.equation!.text).toBe('H2(g) + Cl2(g) -> 2 HCl(g)');
  });

  it('auto does what the data support: thermodynamics without kinetics for H2 + Cl2', () => {
    const result = runExperiment(experiment(HCL));
    expect(result.status).toBe('completed');
    expect(result.thermo!.status).toBe('ok');
    // Twice the CODATA enthalpy of formation of HCl(g), -92.31 +/- 0.10 kJ/mol.
    expect(result.thermo!.deltaH!.value).toBeCloseTo(-184.62, 2);
    expect(result.thermo!.deltaH!.uncertainty).toBeCloseTo(0.2, 6);
    expect(result.kinetics).toBeNull();
  });

  it('asks for the concentrations a rate law needs instead of assuming them', () => {
    const bare = [reactant('NO', 'g'), reactant('O3', 'g'), product('NO2', 'g'), product('O2', 'g')];
    const requested = runExperiment(experiment(bare, 'kinetics'));
    expect(requested.status).toBe('invalid');
    expect(stepOf(requested, 'validate-species').details.join(' ')).toMatch(/Kinetics was requested/);
    expect(requested.kinetics).toBeNull();

    const automatic = runExperiment(experiment(bare, 'auto'));
    expect(automatic.status).toBe('partial');
    expect(automatic.thermo!.status).toBe('ok');
    expect(automatic.kinetics).toBeNull();
    expect(stepOf(automatic, 'model-selection').status).toBe('warning');
  });
});

describe('refusing instead of guessing', () => {
  it('does not predict products', () => {
    const result = runExperiment(experiment([reactant('CH4', 'g'), reactant('O2', 'g')]));
    expect(result.status).toBe('unsupported');
    expect(result.equation).toBeNull();
    expect(result.balance).toBeNull();
    expect(result.thermo).toBeNull();
    expect(result.kinetics).toBeNull();
    expect(result.energyDiagrams).toEqual([]);
    expect(result.explanation.references).toEqual([]);
    expect(stepOf(result, 'conservation')).toMatchObject({ status: 'failed', summary: 'No products were given, and MATTER LAB does not predict the products of a reaction.' });
    expect(stepOf(result, 'conservation').details.join(' ')).toMatch(/suggestReactions/);
    expect(ran(result)).toEqual(['validate-species', 'conservation', 'limitations']);
    expect(result.limitations.join(' ')).toMatch(/does not predict products/);
  });

  it('says when no coefficients can balance the species entered', () => {
    const result = runExperiment(experiment([reactant('H2', 'g'), reactant('O2', 'g'), product('CO2', 'g')]));
    expect(result.status).toBe('unsupported');
    expect(result.equation).toBeNull();
    expect(result.balance!.status).toBe('impossible');
    expect(stepOf(result, 'conservation').status).toBe('failed');
    expect(result.thermo).toBeNull();
  });

  it('does not choose between several ways of balancing, but accepts coefficients that are entered', () => {
    const list = [reactant('CH4', 'g'), reactant('O2', 'g'), product('CO2', 'g'), product('CO', 'g'), product('H2O', 'g')];
    const open = runExperiment(experiment(list));
    expect(open.status).toBe('unsupported');
    expect(open.equation).toBeNull();
    expect(open.balance!.status).toBe('underdetermined');
    expect(open.balance!.independentSolutions).toBe(2);
    expect(open.thermo).toBeNull();

    // 4 CH4 + 7 O2 -> 2 CO2 + 2 CO + 8 H2O conserves C, H and O.
    const coefficients = [4, 7, 2, 2, 8];
    const fixed = runExperiment(experiment(list.map((entry, i) => ({ ...entry, coefficient: coefficients[i]! }))));
    expect(fixed.status).toBe('completed');
    expect(fixed.equation!.text).toBe('4 CH4(g) + 7 O2(g) -> 2 CO2(g) + 2 CO(g) + 8 H2O(g)');
    expect(checkConservation(fixed.equation!.balanced).balanced).toBe(true);

    // Coefficients that do not conserve the atoms are not accepted.
    const wrong = runExperiment(experiment(list.map((entry, i) => ({ ...entry, coefficient: [1, 1, 1, 1, 1][i]! }))));
    expect(wrong.equation).toBeNull();
    expect(wrong.status).toBe('unsupported');
  });

  it('names the species without reference data and estimates nothing for them', () => {
    const result = runExperiment(experiment(IRON));
    expect(result.status).toBe('partial');
    expect(result.equation!.text).toBe('4 Fe(s) + 3 O2(g) -> 2 Fe2O3(s)');
    expect(result.thermo!.status).toBe('missing-data');
    expect([...result.thermo!.missingSpecies].sort()).toEqual(['Fe(s)', 'Fe2O3(s)']);
    expect(result.thermo!.deltaH).toBeUndefined();
    expect(result.thermo!.deltaG).toBeUndefined();
    expect(stepOf(result, 'reference-data').status).toBe('failed');
    expect(result.energyDiagrams.every((diagram) => diagram.levels.length === 0)).toBe(true);
    expect(result.explanation.references).toEqual([]);
    expect(result.reproducibility.dataSources).toEqual([]);
  });

  it('keeps the kinetics when only the thermodynamic data are missing', () => {
    const result = runExperiment(experiment(NO2_O3, 'auto', { temperatureK: 298 }));
    expect(result.status).toBe('partial');
    expect(result.thermo!.status).toBe('missing-data');
    expect(result.thermo!.missingSpecies).toContain('NO3(g)');
    expect(result.kinetics!.status).toBe('ok');
    expect(stepOf(result, 'reference-data').status).toBe('warning');
  });

  it.each([
    ['a formula that cannot be read', experiment([reactant('CH4q', 'g'), product('CO2', 'g')])],
    ['no reactant', experiment([product('CO2', 'g')])],
    ['no species at all', experiment([])],
    ['a temperature of zero', experiment(METHANE, 'auto', { temperatureK: 0 })],
    ['a negative temperature', experiment(METHANE, 'auto', { temperatureK: -5 })],
    ['a temperature that is not a number', experiment(METHANE, 'auto', { temperatureK: Number.NaN })],
    ['a pressure of zero', experiment(METHANE, 'auto', { pressureBar: 0 })],
    ['a duration of zero', experiment(METHANE, 'auto', { durationSeconds: 0 })],
    ['an infinite duration', experiment(METHANE, 'auto', { durationSeconds: Number.POSITIVE_INFINITY })],
    ['a negative concentration', experiment([reactant('NO', 'g', { initialConcentration: -1 }), reactant('O3', 'g', { initialConcentration: 1 }), product('NO2', 'g'), product('O2', 'g')])],
    ['the same reactant twice', experiment([...METHANE, reactant('CH4', 'g')])],
    ['a phase written into the formula', experiment([reactant('CH4(g)'), reactant('O2', 'g'), product('CO2', 'g'), product('H2O', 'l')])],
    ['an unknown method', experiment(METHANE, 'everything' as ExperimentInput['method'])],
    ['a solver tolerance out of range', experiment(NO_O3, 'kinetics', {}, { solver: { tolerance: 1 } })],
  ])('rejects %s without calculating anything', (_what, input) => {
    const result = runExperiment(input);
    expect(result.status).toBe('invalid');
    expect(stepOf(result, 'validate-species').status).toBe('failed');
    expect(stepOf(result, 'validate-species').details.length).toBeGreaterThan(0);
    expect(ran(result)).toEqual(['validate-species']);
    expect(result.equation).toBeNull();
    expect(result.thermo).toBeNull();
    expect(result.rateConstant).toBeNull();
    expect(result.kinetics).toBeNull();
    expect(result.energyDiagrams).toEqual([]);
    expect(result.evidence).toBe('unsupported');
    // An invalid experiment is still a result that can be stored and reopened.
    expect(parseExperimentResult(serializeExperimentResult(result))).toEqual(result);
  });
});

describe('saying what was not modelled', () => {
  const limits = (input: ExperimentInput): string => runExperiment(input).limitations.join('\n');

  it('declares catalysts and solvents as recorded but not modelled, exactly when there are any', () => {
    expect(limits(experiment(AMMONIA))).not.toContain(LIMITATION_PHRASES.catalystsAndSolvents);
    const withBoth = experiment([...AMMONIA, species('Fe', 'catalyst', 's'), species('H2O', 'solvent', 'l')]);
    const text = limits(withBoth);
    expect(text).toContain(LIMITATION_PHRASES.catalystsAndSolvents);
    expect(text).toContain('Fe(s) (catalyst)');
    expect(text).toContain('H2O(l) (solvent)');
    // They change nothing: the numbers are those of the reaction as written.
    const plain = runExperiment(experiment(AMMONIA));
    const decorated = runExperiment(withBoth);
    expect(decorated.equation!.text).toBe(plain.equation!.text);
    expect(decorated.thermo!.deltaH).toEqual(plain.thermo!.deltaH);
    expect(decorated.thermo!.deltaG).toEqual(plain.thermo!.deltaG);
  });

  it('declares that pressure is not modelled, exactly when it differs from 1 bar', () => {
    expect(limits(experiment(AMMONIA, 'auto', { pressureBar: 1 }))).not.toContain(LIMITATION_PHRASES.pressure);
    const high = runExperiment(experiment(AMMONIA, 'auto', { pressureBar: 200 }));
    expect(high.limitations.join('\n')).toContain(LIMITATION_PHRASES.pressure);
    // And indeed the values do not depend on it.
    const standard = runExperiment(experiment(AMMONIA));
    expect(high.thermo!.deltaG).toEqual(standard.thermo!.deltaG);
    expect(high.thermo!.log10K).toBe(standard.thermo!.log10K);
  });

  it('applies the 1 bar restriction of the MPAN rate expression', () => {
    const atOneBar = runExperiment(experiment(MPAN, 'kinetics', { temperatureK: 298, pressureBar: 1, durationSeconds: 7200 }));
    expect(atOneBar.status).toBe('completed');
    expect(atOneBar.kinetics!.status).toBe('ok');
    const atFiveBar = runExperiment(experiment(MPAN, 'kinetics', { temperatureK: 298, pressureBar: 5, durationSeconds: 7200 }));
    expect(atFiveBar.status).toBe('unsupported');
    expect(atFiveBar.kinetics).toBeNull();
    expect(atFiveBar.rateConstant).toBeNull();
    expect(stepOf(atFiveBar, 'model-selection').status).toBe('failed');
    expect(atFiveBar.warnings.join(' ')).toMatch(/1 bar/);
  });

  it('warns when the species do not fit the environment that was chosen', () => {
    const mismatch = (input: ExperimentInput): boolean => runExperiment(input).warnings.some((warning) => warning.startsWith(LIMITATION_PHRASES.environment));
    expect(mismatch(experiment(METHANE, 'auto', { environment: 'gas-phase' }))).toBe(true); // liquid water among gases
    expect(mismatch(experiment(AMMONIA, 'auto', { environment: 'gas-phase' }))).toBe(false);
    expect(mismatch(experiment(AMMONIA, 'auto', { environment: 'aqueous-solution' }))).toBe(true);
    expect(mismatch(experiment(AMMONIA, 'auto', { environment: 'unspecified' }))).toBe(false);
    expect(mismatch(experiment([reactant('H+', 'aq'), reactant('OH-', 'aq'), product('H2O', 'l')], 'auto', { environment: 'aqueous-solution' }))).toBe(false);
  });

  it('flags temperatures outside the validated ranges and downgrades the evidence', () => {
    const far = runExperiment(experiment(AMMONIA, 'auto', { temperatureK: 700 }));
    expect(far.thermo!.withinValidatedRange).toBe(false);
    expect(far.thermo!.evidence).toBe('rule-based');
    expect(far.limitations.join('\n')).toContain(LIMITATION_PHRASES.temperature);
    expect(runExperiment(experiment(AMMONIA)).limitations.join('\n')).not.toContain(LIMITATION_PHRASES.temperature);

    const hot = runExperiment(experiment(OH_H2, 'kinetics', { temperatureK: 900 }));
    expect(hot.rateConstant!.withinValidatedRange).toBe(false);
    expect(hot.rateConstant!.k.evidence).toBe('rule-based');
    expect(hot.limitations.join('\n')).toContain(LIMITATION_PHRASES.temperature);
    const inside = runExperiment(experiment(OH_H2, 'kinetics', { temperatureK: 300 }));
    expect(inside.rateConstant!.withinValidatedRange).toBe(true);
    expect(inside.limitations.join('\n')).not.toContain(LIMITATION_PHRASES.temperature);
  });

  it('always says that it did not predict the reaction, that a favourable Gibbs energy is not a rate, and that one step is not a mixture', () => {
    const both = limits(experiment(NO_O3, 'auto', { temperatureK: 298 }));
    expect(both).toContain(LIMITATION_PHRASES.noPrediction);
    expect(both).toContain(LIMITATION_PHRASES.gibbsNotRate);
    expect(both).toContain(LIMITATION_PHRASES.singleStep);
    const thermoOnly = limits(experiment(METHANE));
    expect(thermoOnly).toContain(LIMITATION_PHRASES.noPrediction);
    expect(thermoOnly).toContain(LIMITATION_PHRASES.gibbsNotRate);
    expect(thermoOnly).not.toContain(LIMITATION_PHRASES.singleStep);
  });
});

describe('energy diagrams', () => {
  it('draws the empirical activation energy as a barrier only where it is positive and sourced', () => {
    const result = runExperiment(experiment(NO_O3, 'auto', { temperatureK: 298 }));
    const enthalpy = result.energyDiagrams.find((diagram) => diagram.quantity === 'enthalpy')!;
    expect(enthalpy.unit).toBe('kJ/mol');
    expect(enthalpy.levels.map((level) => level.kind)).toEqual(['reactants', 'barrier', 'products']);
    expect(enthalpy.levels[0]!.value).toBe(0);
    // E/R = 1310 K on the data sheet, so Ea = 1310 K x R = 10.89 kJ/mol.
    expect(enthalpy.levels[1]!.value).toBeCloseTo((1310 * GAS_CONSTANT) / 1000, 6);
    expect(enthalpy.levels[1]!.note).toMatch(/Arrhenius/);
    expect(enthalpy.levels[1]!.note).toMatch(/not a (computed )?transition state/i);
    expect(enthalpy.levels[2]!.value).toBe(result.thermo!.deltaH!.value);
    // The Gibbs diagram never has a barrier: an activation energy is not a Gibbs energy.
    expect(kindsOf(result, 'gibbs')).toEqual(['reactants', 'products']);
  });

  it('draws no barrier when the rate constant falls with temperature, and says why', () => {
    const result = runExperiment(experiment(NO_O2, 'auto', { temperatureK: 298, durationSeconds: 20000 }));
    expect(result.kineticModel!.arrhenius.EaKJPerMol).toBeLessThan(0);
    for (const diagram of result.energyDiagrams) expect(diagram.levels.map((level) => level.kind)).not.toContain('barrier');
    expect(result.energyDiagrams.flatMap((diagram) => diagram.notes).join(' ')).toMatch(/barrier/i);
  });

  it('draws nothing rather than a barrier without a product level', () => {
    const result = runExperiment(experiment(MPAN, 'kinetics', { temperatureK: 298, durationSeconds: 7200 }));
    expect(result.kineticModel!.arrhenius.EaKJPerMol).toBeGreaterThan(0);
    const enthalpy = result.energyDiagrams.find((diagram) => diagram.quantity === 'enthalpy');
    expect(enthalpy?.levels ?? []).toEqual([]);
    expect((enthalpy?.notes ?? []).length).toBeGreaterThan(0);
    expect(result.energyDiagrams.some((diagram) => diagram.quantity === 'gibbs')).toBe(false);
  });

  it('uses the reaction enthalpy printed on the data sheet when thermodynamics was not requested', () => {
    const result = runExperiment(experiment(NO_O3, 'kinetics', { temperatureK: 298 }));
    const enthalpy = result.energyDiagrams.find((diagram) => diagram.quantity === 'enthalpy')!;
    expect(enthalpy.levels.map((level) => level.kind)).toEqual(['reactants', 'barrier', 'products']);
    // The evaluation prints about -200 kJ/mol for this reaction; the reference table gives -199.9.
    expect(enthalpy.levels[2]!.value).toBeGreaterThan(-203);
    expect(enthalpy.levels[2]!.value).toBeLessThan(-197);
  });
});

describe('sources', () => {
  const kineticsCitation = (doi: string | undefined): boolean => /acp-/.test(doi ?? '');

  it('cites only what a result used', () => {
    const thermoOnly = runExperiment(experiment(METHANE));
    expect(thermoOnly.explanation.references.length).toBeGreaterThan(0);
    expect(thermoOnly.explanation.references.some((citation) => kineticsCitation(citation.doi))).toBe(false);
    expect(thermoOnly.explanation.references.some((citation) => /CODATA Key Values/.test(citation.title))).toBe(true);

    const kineticsOnly = runExperiment(experiment(NO_O3, 'kinetics', { temperatureK: 298 }));
    expect(kineticsOnly.explanation.references.length).toBeGreaterThan(0);
    expect(kineticsOnly.explanation.references.every((citation) => kineticsCitation(citation.doi))).toBe(true);

    const both = runExperiment(experiment(NO_O3, 'auto', { temperatureK: 298 }));
    expect(both.explanation.references.some((citation) => kineticsCitation(citation.doi))).toBe(true);
    expect(both.explanation.references.some((citation) => !kineticsCitation(citation.doi))).toBe(true);
  });

  it('records the retrieved copies behind the numbers, with their hashes', () => {
    const result = runExperiment(experiment(NO_O3, 'auto', { temperatureK: 298 }));
    const sources = result.reproducibility.dataSources;
    expect(sources.length).toBeGreaterThanOrEqual(2);
    expect(new Set(sources.map((source) => source.id)).size).toBe(sources.length);
    for (const source of sources) {
      expect(source.title.length).toBeGreaterThan(0);
      expect(source.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}/);
      expect(source.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('progress and cancellation', () => {
  const long = experiment(NO_O3, 'auto', { temperatureK: 298, durationSeconds: 3000 }, { solver: { tolerance: 1e-12 } });

  it('reports strictly increasing progress from 0 to 1', () => {
    const seen: Array<[number, ExperimentStepId]> = [];
    const result = runExperiment(long, { onProgress: (fraction, step) => seen.push([fraction, step]) });
    expect(result.status).toBe('completed');
    expect(seen[0]![0]).toBe(0);
    expect(seen[seen.length - 1]![0]).toBe(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i]![0]).toBeGreaterThan(seen[i - 1]![0]);
    for (const [, step] of seen) expect(EXPERIMENT_STEP_IDS).toContain(step);
    // The integration is reported in several increments, not as one jump.
    expect(seen.filter(([, step]) => step === 'calculation').length).toBeGreaterThan(5);
  });

  it.each([1, 2, 3, 4, 5, 6])('stops before step %i when asked to', (call) => {
    let calls = 0;
    const result = runExperiment(long, { shouldCancel: () => ++calls >= call });
    expect(result.status).toBe('cancelled');
    expect(ran(result)).toEqual(EXPERIMENT_STEP_IDS.slice(0, call - 1));
    for (const step of result.steps.slice(call - 1)) expect(step).toMatchObject({ status: 'skipped', summary: 'Not run: the experiment was cancelled.' });
    expect(result.thermo).toBeNull();
    expect(result.kinetics).toBeNull();
    expect(result.energyDiagrams).toEqual([]);
    // What had been established before the cancellation is kept.
    expect(result.equation !== null).toBe(call > 2);
  });

  it('stops in the middle of an integration and returns no half-finished curve', () => {
    // How often an uncancelled run asks whether to stop: once per step of the pipeline, then once per accepted integration step.
    let asked = 0;
    const complete = runExperiment(long, {
      shouldCancel: () => {
        asked++;
        return false;
      },
    });
    expect(complete.status).toBe('completed');
    expect(complete.kinetics!.solver.steps).toBeGreaterThan(60);
    expect(asked).toBeGreaterThan(complete.kinetics!.solver.steps);

    // Cancel half-way through those questions, which is well inside the integration.
    const stopAt = Math.floor(asked / 2);
    let calls = 0;
    const fractions: number[] = [];
    const result = runExperiment(long, { shouldCancel: () => ++calls >= stopAt, onProgress: (fraction) => fractions.push(fraction) });
    expect(calls).toBe(stopAt);
    expect(result.status).toBe('cancelled');
    expect(ran(result)).toEqual(['validate-species', 'conservation', 'model-selection', 'reference-data', 'engine']);
    expect(result.thermo).toBeNull();
    expect(result.rateConstant).toBeNull();
    expect(result.kinetics).toBeNull();
    // Progress had moved into the integration and never claimed completion.
    expect(Math.max(...fractions)).toBeGreaterThan(0.3);
    expect(Math.max(...fractions)).toBeLessThan(0.93);
  });

  it('reports an integration that ran out of steps as incomplete, with the part that was computed', () => {
    const result = runExperiment(experiment(NO_O3, 'kinetics', { temperatureK: 298, durationSeconds: 3000 }, { solver: { tolerance: 1e-12, maxSteps: 10 } }));
    expect(result.status).toBe('partial');
    expect(result.kinetics!.status).toBe('incomplete');
    expect(result.kinetics!.solver.stopReason).toBe('max-steps');
    const times = result.kinetics!.times;
    expect(times.length).toBeGreaterThan(0);
    expect(times[times.length - 1]!).toBeLessThan(3000);
    expect(stepOf(result, 'calculation').status).toBe('warning');
    expect(stepOf(result, 'calculation').details.join(' ')).toMatch(/budget of 10 step attempts ran out/);
  });
});

describe('determinism and records', () => {
  const inputs: Array<[string, ExperimentInput]> = [
    ['thermodynamics and kinetics', experiment(NO_O3, 'auto', { temperatureK: 298, durationSeconds: 300 })],
    ['thermodynamics only', experiment(METHANE)],
    ['a refusal', experiment([reactant('CH4', 'g'), reactant('O2', 'g')])],
    ['missing data', experiment(IRON)],
    ['an extrapolation', experiment(OH_H2, 'kinetics', { temperatureK: 900 })],
  ];

  it.each(inputs)('gives the same result every time: %s', (_name, input) => {
    const first = runExperiment(input);
    const second = runExperiment(input);
    expect(second).toEqual(first);
    expect(serializeExperimentResult(second)).toBe(serializeExperimentResult(first));
  });

  it.each(inputs)('survives being written and read back: %s', (_name, input) => {
    const result = runExperiment(input);
    const text = serializeExperimentResult(result);
    const back = parseExperimentResult(text);
    expect(back).toEqual(result);
    if (result.kinetics) {
      expect(back.kinetics!.times).toBeInstanceOf(Float64Array);
      expect(back.kinetics!.rates).toBeInstanceOf(Float64Array);
      for (const series of Object.values(back.kinetics!.concentrations)) expect(series).toBeInstanceOf(Float64Array);
    }
    // Writing what was read gives the same text: nothing is lost on the way.
    expect(serializeExperimentResult(back)).toBe(text);
  });

  it('hashes the input, not the way it was written down', () => {
    const base = experiment(METHANE);
    const reordered: ExperimentInput = {
      method: base.method,
      conditions: { concentrationUnit: base.conditions.concentrationUnit, environment: base.conditions.environment, durationSeconds: base.conditions.durationSeconds, pressureBar: base.conditions.pressureBar, temperatureK: base.conditions.temperatureK },
      species: base.species.map((entry) => ({ role: entry.role, phase: entry.phase!, formula: entry.formula })),
    };
    const hash = runExperiment(base).inputHash;
    expect(runExperiment(reordered).inputHash).toBe(hash);
    expect(runExperiment(experiment(METHANE, 'auto', { temperatureK: 300 })).inputHash).not.toBe(hash);
    expect(runExperiment(experiment(METHANE, 'thermodynamics')).inputHash).not.toBe(hash);
    // The order of the species is part of the experiment: it is the order of the equation.
    expect(runExperiment(experiment([METHANE[1]!, METHANE[0]!, METHANE[2]!, METHANE[3]!])).inputHash).not.toBe(hash);
  });

  it('refuses text that is not a result of this engine, or that was changed after it was written', () => {
    const text = serializeExperimentResult(runExperiment(experiment(METHANE)));
    expect(() => parseExperimentResult('not json at all')).toThrow(/not valid JSON/);
    expect(() => parseExperimentResult('[1, 2, 3]')).toThrow(/does not hold an object/);
    expect(() => parseExperimentResult('{}')).toThrow(/schema/);
    expect(() => parseExperimentResult(text.replace('"matterlab.experiment-result"', '"something.else"'))).toThrow(/schema/);
    expect(() => parseExperimentResult(text.replace('"schemaVersion":1', '"schemaVersion":2'))).toThrow(/schema version/);
    // Changing an input after the fact no longer matches the recorded hash.
    const tampered = text.replace('"temperatureK":298.15', '"temperatureK":350');
    expect(tampered).not.toBe(text);
    expect(() => parseExperimentResult(tampered)).toThrow(/inputHash/);
    expect(() => parseExperimentResult(text.slice(0, text.length - 20))).toThrow();
  });
});

describe('the catalogue lookup', () => {
  it('lists catalogued reactions of the species given, and calls itself a lookup', () => {
    const combustion = suggestReactions([
      { formula: 'CH4', phase: 'g' },
      { formula: 'O2', phase: 'g' },
    ]);
    expect(combustion.length).toBeGreaterThan(0);
    expect(combustion.some((reaction) => /CH4/.test(reaction.equation) && /CO2/.test(reaction.equation) && reaction.hasThermo)).toBe(true);
    for (const reaction of combustion) expect(reaction.note).toMatch(/not a prediction/);

    const ozone = suggestReactions([{ formula: 'NO' }, { formula: 'O3' }]);
    const sourced = ozone.find((reaction) => reaction.kineticModelId === 'no-o3');
    expect(sourced).toBeDefined();
    expect(sourced!.hasKinetics).toBe(true);
  });

  it('returns nothing for species it has no reaction for, or cannot read', () => {
    expect(suggestReactions([{ formula: 'Xe' }])).toEqual([]);
    expect(suggestReactions([{ formula: 'this is not a formula' }])).toEqual([]);
    expect(suggestReactions([])).toEqual([]);
    // A reaction is listed only when all of its reactants were given.
    expect(suggestReactions([{ formula: 'CH4', phase: 'g' }]).some((reaction) => /O2/.test(reaction.equation.split('->')[0]!))).toBe(false);
  });

  it('holds only balanced equations, each labelled with what can be computed for it', () => {
    expect(REACTION_CATALOGUE.length).toBeGreaterThan(10);
    expect(new Set(REACTION_CATALOGUE.map((reaction) => reaction.id)).size).toBe(REACTION_CATALOGUE.length);
    for (const reaction of REACTION_CATALOGUE) {
      expect(checkConservation(parseEquation(reaction.equation)).balanced, reaction.equation).toBe(true);
      expect(reaction.note).toMatch(/not a prediction/);
      expect(reaction.hasKinetics).toBe(reaction.kineticModelId !== undefined);
      expect(SUPPORTED_REACTION_CLASSES.some((entry) => entry.id === reaction.reactionClass), reaction.reactionClass).toBe(true);
    }
  });
});

describe('the standard conditions of the helpers', () => {
  it('are the conditions the tests above assume', () => {
    expect(STANDARD).toMatchObject({ temperatureK: 298.15, pressureBar: 1 });
  });
});
