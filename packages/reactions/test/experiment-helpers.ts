/** Small builders shared by the experiment tests. Not a test file. */
import type { ExperimentConditions, ExperimentInput, ExperimentMethod, ExperimentResult, ExperimentSpecies, ExperimentStep, ExperimentStepId, Phase, SpeciesRole } from '../src';

export function species(formula: string, role: SpeciesRole, phase?: Phase, extra: Partial<ExperimentSpecies> = {}): ExperimentSpecies {
  return { formula, role, ...(phase ? { phase } : {}), ...extra };
}

export const reactant = (formula: string, phase?: Phase, extra: Partial<ExperimentSpecies> = {}): ExperimentSpecies => species(formula, 'reactant', phase, extra);
export const product = (formula: string, phase?: Phase, extra: Partial<ExperimentSpecies> = {}): ExperimentSpecies => species(formula, 'product', phase, extra);

export const STANDARD: ExperimentConditions = { temperatureK: 298.15, pressureBar: 1, durationSeconds: 100, environment: 'unspecified', concentrationUnit: 'molecule/cm3' };

export function experiment(list: readonly ExperimentSpecies[], method: ExperimentMethod = 'auto', conditions: Partial<ExperimentConditions> = {}, extra: Partial<ExperimentInput> = {}): ExperimentInput {
  return { species: list, conditions: { ...STANDARD, ...conditions }, method, ...extra };
}

export const stepOf = (result: ExperimentResult, id: ExperimentStepId): ExperimentStep => result.steps.find((step) => step.id === id)!;

/** Every sentence a result shows to a reader, for checks on wording. */
export function allText(result: ExperimentResult): string[] {
  return [
    ...result.steps.flatMap((step) => [step.summary, ...step.details]),
    ...result.warnings,
    ...result.limitations,
    ...result.energyDiagrams.flatMap((diagram) => [...diagram.notes, ...diagram.levels.flatMap((level) => [level.label, level.note ?? ''])]),
    ...[...result.explanation.beginner, ...result.explanation.advanced].flatMap((section) => [section.heading, ...section.paragraphs, section.equation ?? '']),
  ];
}

// --- experiments used in several files -----------------------------------------------------------------------

export const METHANE = [reactant('CH4', 'g'), reactant('O2', 'g'), product('CO2', 'g'), product('H2O', 'l')];
export const AMMONIA = [reactant('N2', 'g'), reactant('H2', 'g'), product('NH3', 'g')];
export const NEUTRALISATION = [reactant('H+', 'aq'), reactant('OH-', 'aq'), product('H2O', 'l')];
/** NO + O3 -> NO2 + O2: in the reference table and with a sourced rate law (195 K to 308 K). */
export const NO_O3 = [reactant('NO', 'g', { initialConcentration: 5e11 }), reactant('O3', 'g', { initialConcentration: 1e12 }), product('NO2', 'g'), product('O2', 'g')];
/** NO2 + O3 -> NO3 + O2: a sourced rate law, but NO3 is not in the reference table. */
export const NO2_O3 = [reactant('NO2', 'g', { initialConcentration: 1e12 }), reactant('O3', 'g', { initialConcentration: 2e12 }), product('NO3', 'g'), product('O2', 'g')];
/** 2 NO + O2 -> 2 NO2: third order, with a negative activation energy. */
export const NO_O2 = [reactant('NO', 'g', { initialConcentration: 1e15 }), reactant('O2', 'g', { initialConcentration: 5e18 }), product('NO2', 'g')];
/** OH + H2 -> H2O + H: a sourced rate law for 200 K to 450 K. */
export const OH_H2 = [reactant('OH', 'g', { initialConcentration: 1e7 }), reactant('H2', 'g', { initialConcentration: 1e13 }), product('H2O', 'g'), product('H', 'g')];
/** MPAN decomposition: first order, valid at 1 bar only, no thermodynamic data and no enthalpy on its data sheet. */
export const MPAN = [reactant('C4H5NO5', 'g', { initialConcentration: 1e10 }), product('C4H5O3', 'g'), product('NO2', 'g')];
/** H2 + Cl2 -> 2 HCl: in the reference table, no sourced rate law. */
export const HCL = [reactant('H2', 'g', { initialConcentration: 1e12 }), reactant('Cl2', 'g', { initialConcentration: 1e12 }), product('HCl', 'g')];
/** Iron and oxygen: balances, but the reference table has no iron species. */
export const IRON = [reactant('Fe', 's'), reactant('O2', 'g'), product('Fe2O3', 's')];
