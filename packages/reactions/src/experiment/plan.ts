import { balanceEquation } from '../balance';
import type { BalanceResult } from '../balance';
import { KINETIC_RECORDS, KINETIC_SOURCE_RECORDS } from '../data/kinetics.generated';
import { THERMO_PAGES, THERMO_RECORDS } from '../data/thermo.generated';
import type { ThermoRecord } from '../data/records';
import type { ReactionEquation, SpeciesTerm } from '../equation';
import { checkConservation, formatEquation, formatTerm, parseEquation } from '../equation';
import { hillFormula, parseFormula } from '../formula';
import { KINETIC_MODELS, findKineticModels, toMolarUnits } from '../kinetics/models';
import type { KineticModel } from '../kinetics/models';
import { THERMO_DATA_SOURCES, lookupThermoSpecies } from '../thermo/species';
import type { ThermoLookup, ThermoSpecies } from '../thermo/species';
import { MINUS } from './format';
import type { ReadSpecies } from './input';
import type { ExperimentDataSource, ExperimentInput } from './types';

/**
 * A kinetic model that is restricted to one total pressure is used when the pressure of the experiment is
 * within this fraction of it. The value is a choice of this package, not a property of the data: the one
 * such data sheet quotes "1 bar" for a measurement made in one atmosphere of air (1.01325 bar), a
 * difference of 1.3 %, so differences up to 2 % are treated as immaterial and larger ones are not.
 */
export const KINETIC_PRESSURE_MATCH_TOLERANCE = 0.02;

const RECORD_BY_ID = new Map<string, ThermoRecord>(THERMO_RECORDS.map((record) => [record.id, record]));
const SOURCE_NAME = new Map<string, string>(THERMO_DATA_SOURCES.map((source) => [source.id, source.name]));

const listOf = (items: readonly string[]): string => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

// --- the equation -------------------------------------------------------------------------------------------

export interface EquationPlan {
  /** The reactants and products as entered, with the coefficients that were entered or 1. */
  readonly skeleton: ReactionEquation;
  readonly balance: BalanceResult;
  /** The balanced equation, or `null` when there is none. */
  readonly balanced: ReactionEquation | null;
  /**
   * What fixed the coefficients: conservation of atoms and charge alone, the coefficients that were
   * entered, or the data sheet of a sourced elementary reaction between exactly these species.
   */
  readonly how: 'conservation' | 'entered' | 'data-sheet' | null;
  /** Things the reader must know about how the equation was obtained. */
  readonly notes: readonly string[];
}

/** The species with the roles reactant and product as an equation, in input order. */
export function skeletonOf(species: readonly ReadSpecies[]): ReactionEquation {
  const reacting = species.filter((entry) => entry.species.role === 'reactant' || entry.species.role === 'product');
  const entered = reacting.length > 0 && reacting.every((entry) => entry.species.coefficient !== undefined);
  const term = (entry: ReadSpecies): SpeciesTerm => ({
    formula: entry.species.formula,
    ...(entry.species.phase ? { phase: entry.species.phase } : {}),
    coefficient: entered ? entry.species.coefficient! : 1,
    parsed: entry.parsed,
  });
  return {
    reactants: reacting.filter((entry) => entry.species.role === 'reactant').map(term),
    products: reacting.filter((entry) => entry.species.role === 'product').map(term),
    reversible: false,
  };
}

/**
 * The shipped elementary reaction between exactly the species of the skeleton, with its coefficients as
 * the source prints them. Only gas-phase species (or species without a phase label) can match, because the
 * data sheets are for gas-phase reactions.
 */
function fromDataSheet(skeleton: ReactionEquation): { readonly model: KineticModel; readonly equation: ReactionEquation } | undefined {
  if ([...skeleton.reactants, ...skeleton.products].some((term) => term.phase !== undefined && term.phase !== 'g')) return undefined;
  const matches: { model: KineticModel; equation: ReactionEquation }[] = [];
  for (const model of KINETIC_MODELS) {
    const reference = parseEquation(model.equation);
    const sideOf = (mine: readonly SpeciesTerm[], theirs: readonly SpeciesTerm[]): SpeciesTerm[] | undefined => {
      if (mine.length !== theirs.length || new Set(mine.map((term) => hillFormula(term.parsed))).size !== mine.length) return undefined;
      const out: SpeciesTerm[] = [];
      for (const term of mine) {
        const match = theirs.find((candidate) => hillFormula(candidate.parsed) === hillFormula(term.parsed));
        if (!match) return undefined;
        out.push({ ...term, coefficient: match.coefficient });
      }
      return out;
    };
    const reactants = sideOf(skeleton.reactants, reference.reactants);
    const products = sideOf(skeleton.products, reference.products);
    if (reactants && products) matches.push({ model, equation: { reactants, products, reversible: false } });
  }
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Turns the species of an experiment into a balanced equation.
 *
 * 1. Coefficients that were entered are used when they conserve every element and the charge.
 * 2. Otherwise the coefficients are found by conservation, when that fixes them uniquely.
 * 3. When conservation leaves the proportions open and the species are exactly those of an elementary
 *    reaction for which a sourced data sheet is shipped, the proportions of that data sheet are used, and
 *    the result says so.
 * 4. In every other case there is no balanced equation: the outcome is `impossible` or `underdetermined`.
 *
 * Unit coefficients are a placeholder, not a choice of the user, so an equation that happens to balance
 * with one unit of each species while conservation leaves several solutions is not accepted under rule 2.
 * Rule 3 is not applied to an experiment set in aqueous solution: the data sheets are for gas-phase reactions.
 */
export function planEquation(species: readonly ReadSpecies[], environment?: ExperimentInput['conditions']['environment']): EquationPlan {
  const skeleton = skeletonOf(species);
  const reacting = species.filter((entry) => entry.species.role === 'reactant' || entry.species.role === 'product');
  const entered = reacting.length > 0 && reacting.every((entry) => entry.species.coefficient !== undefined);
  const balance = balanceEquation(skeleton);
  const notes: string[] = [];

  if (balance.status === 'already-balanced' && (entered || balance.independentSolutions === 1)) {
    if (entered && balance.independentSolutions > 1) {
      notes.push(`Conservation alone would leave ${balance.independentSolutions} independent solutions for these species; the proportions are the ones that were entered.`);
    }
    return { skeleton, balance, balanced: skeleton, how: entered ? 'entered' : 'conservation', notes };
  }
  if (entered) {
    const report = checkConservation(skeleton);
    const off = Object.entries(report.elementImbalance)
      .filter(([, value]) => value !== 0)
      .map(([symbol, value]) => `${symbol} ${value > 0 ? '+' : MINUS}${Math.abs(value)}`);
    if (report.chargeImbalance !== 0) off.push(`charge ${report.chargeImbalance > 0 ? '+' : MINUS}${Math.abs(report.chargeImbalance)}`);
    notes.push(`The coefficients that were entered do not conserve every element and the charge (products minus reactants: ${off.join(', ')}), so they were not used.`);
  }
  if (balance.status === 'balanced' && balance.equation) return { skeleton, balance, balanced: balance.equation, how: 'conservation', notes };
  if (balance.status === 'impossible') return { skeleton, balance, balanced: null, how: null, notes };

  // The proportions are open: conservation has several independent solutions.
  const candidate = fromDataSheet(skeleton);
  const sheet = environment === 'aqueous-solution' ? undefined : candidate;
  if (candidate && !sheet) {
    notes.push(
      `Environment mismatch: a sourced elementary reaction between exactly these species exists for the gas phase ("${candidate.model.name}"), ` +
        'but the experiment is set in aqueous solution, so its proportions were not taken over.',
    );
  }
  if (sheet && checkConservation(sheet.equation).balanced) {
    const origin = sheet.model.asPublished ? `data sheet ${sheet.model.asPublished.dataSheet} of the IUPAC evaluation` : sheet.model.provenance.source;
    return {
      skeleton,
      balance: {
        status: 'balanced',
        equation: sheet.equation,
        message:
          `Conservation of the elements and the charge leaves ${balance.independentSolutions} independent solutions for these species, so it does not fix the proportions. ` +
          `The proportions used are those of the reaction "${sheet.model.name}" as it is printed on ${origin}, which lists it as an elementary reaction: ${formatEquation(sheet.equation)}.`,
        independentSolutions: balance.independentSolutions,
      },
      balanced: sheet.equation,
      how: 'data-sheet',
      notes,
    };
  }
  if (balance.status === 'underdetermined') return { skeleton, balance, balanced: null, how: null, notes };
  return {
    skeleton,
    balance: {
      status: 'underdetermined',
      message:
        `With one unit of each species the equation conserves every element and the charge, but conservation leaves ${balance.independentSolutions} independent solutions, ` +
        'so the proportions in which the species react are not fixed by the species alone and no single balanced equation exists. ' +
        'This usually means that two or more reactions were entered as one. Enter them as separate experiments, or give a coefficient for every reactant and product.',
      independentSolutions: balance.independentSolutions,
    },
    balanced: null,
    how: null,
    notes,
  };
}

// --- kinetics -----------------------------------------------------------------------------------------------

export type KineticsPlan =
  /** Kinetics was not asked for. */
  | { readonly kind: 'not-requested' }
  /** No sourced rate law exists for the reaction. */
  | { readonly kind: 'none' }
  /** A sourced rate law exists, but not for the environment or the pressure of the experiment. */
  | { readonly kind: 'refused'; readonly model: KineticModel; readonly why: 'environment' | 'pressure'; readonly message: string }
  /** A sourced rate law applies, but the initial concentrations it needs were not given. */
  | { readonly kind: 'needs-concentrations'; readonly model: KineticModel; readonly missing: readonly string[]; readonly message: string }
  /** A sourced rate law applies and can be run. */
  | {
      readonly kind: 'selected';
      /** The model in the concentration unit of the experiment. */
      readonly model: KineticModel;
      /** Initial concentrations keyed by the formulas used in the input. */
      readonly initialConcentrations: Readonly<Record<string, number>>;
      readonly notes: readonly string[];
    };

/**
 * Finds the sourced rate law for exactly the balanced reaction and decides whether it may be used for the
 * conditions of the experiment. It never substitutes the rate law of another reaction, phase or pressure.
 */
export function planKinetics(balanced: ReactionEquation, input: ExperimentInput, species: readonly ReadSpecies[]): KineticsPlan {
  const model = findKineticModels(balanced)[0];
  if (!model) return { kind: 'none' };
  const sheet = model.asPublished ? `data sheet ${model.asPublished.dataSheet} of the IUPAC evaluation` : model.provenance.source;
  const { conditions } = input;

  if (model.medium === 'gas' && conditions.environment === 'aqueous-solution') {
    return {
      kind: 'refused',
      model,
      why: 'environment',
      message:
        `Environment mismatch: a sourced rate law exists for this reaction in the gas phase only (${sheet}), and the experiment is set in aqueous solution. ` +
        'A gas-phase rate constant does not describe a reaction in solution, so the kinetics was not simulated.',
    };
  }
  const notes: string[] = [];
  if (model.requiredPressureBar !== undefined) {
    const required = model.requiredPressureBar;
    if (Math.abs(conditions.pressureBar - required) > KINETIC_PRESSURE_MATCH_TOLERANCE * required) {
      return {
        kind: 'refused',
        model,
        why: 'pressure',
        message:
          `The only sourced rate expression for this reaction holds at ${required} bar total pressure (${sheet}), and the experiment is at ${conditions.pressureBar} bar. ` +
          'MATTER LAB has no pressure-dependent (fall-off) expression for it and does not extrapolate in pressure, so the kinetics was not simulated.',
      };
    }
    if (conditions.pressureBar !== required) {
      notes.push(
        `The rate expression holds at ${required} bar total pressure; ${conditions.pressureBar} bar is within ${KINETIC_PRESSURE_MATCH_TOLERANCE * 100} % of it and is treated as the same pressure.`,
      );
    }
  }

  const reacting = species.filter((entry) => entry.species.role === 'reactant' || entry.species.role === 'product');
  const missing: string[] = [];
  for (const name of Object.keys(model.rateLaw.orders)) {
    const composition = hillFormula(parseFormula(name));
    const entry = reacting.find((candidate) => candidate.composition === composition);
    if (!entry || entry.species.initialConcentration === undefined) missing.push(entry ? entry.label : name);
  }
  if (missing.length > 0) {
    return {
      kind: 'needs-concentrations',
      model,
      missing,
      message: `A sourced rate law exists for this reaction (${model.name}, ${sheet}). It needs the initial concentration of ${listOf(missing)}, which ${missing.length === 1 ? 'was' : 'were'} not given.`,
    };
  }
  const initialConcentrations: Record<string, number> = {};
  for (const entry of reacting) if (entry.species.initialConcentration !== undefined) initialConcentrations[entry.species.formula] = entry.species.initialConcentration;
  return { kind: 'selected', model: conditions.concentrationUnit === 'mol/L' ? toMolarUnits(model) : model, initialConcentrations, notes };
}

// --- thermodynamic reference data ---------------------------------------------------------------------------

export interface ThermoReference {
  readonly term: SpeciesTerm;
  /** The term as written in the equation without its coefficient, e.g. "H2O(l)". */
  readonly label: string;
  readonly lookup: ThermoLookup;
  /** One sentence for the reference-data step. */
  readonly line: string;
}

/** A table value as the source prints it, with a true minus sign. */
function printed(text: string): string {
  const trimmed = text.trim();
  return trimmed.startsWith('-') ? `${MINUS}${trimmed.slice(1)}` : trimmed;
}

export const thermoRecordOf = (speciesId: string): ThermoRecord | undefined => RECORD_BY_ID.get(speciesId);

function entryLine(label: string, species: ThermoSpecies, phaseAssumed: boolean): string {
  const record = RECORD_BY_ID.get(species.id);
  const source = SOURCE_NAME.get(species.source) ?? species.source;
  const enthalpy = record?.deltaHf298
    ? `\u0394fH\u00b0 = ${printed(record.deltaHf298.asPrinted)} kJ/mol${record.deltaHf298.exact ? ' (zero by definition)' : ''}`
    : 'no enthalpy of formation listed';
  const entropy = record?.s298 ? `S\u00b0 = ${printed(record.s298.asPrinted)} J/(mol K)${record.s298.exact ? ' (zero by convention)' : ''}` : 'no standard entropy listed';
  const state = species.stateDetail ? `, ${species.stateDetail}` : '';
  const assumed = phaseAssumed ? ` No phase was given; the only tabulated phase, ${species.id}, is used.` : '';
  return `${label}: ${species.name}${state} (${source}); ${enthalpy}; ${entropy}, as printed by the source.${assumed}`;
}

/** Looks every term of the equation up in the reference table, exactly as `reactionThermodynamics` will. */
export function thermoReferences(equation: ReactionEquation): ThermoReference[] {
  return [...equation.reactants, ...equation.products].map((term) => {
    const label = formatTerm({ ...term, coefficient: 1 });
    const lookup = lookupThermoSpecies(term.parsed, term.phase);
    const phases = lookup.availablePhases.map((p) => `(${p})`).join(', ');
    let line: string;
    if (lookup.status === 'found' && lookup.species) line = entryLine(label, lookup.species, lookup.phaseAssumed);
    else if (lookup.status === 'phase-required') line = `${label}: tabulated in several phases, ${phases}; no phase was given, so no entry can be chosen.`;
    else if (lookup.status === 'phase-not-tabulated') line = `${label}: not in the reference table in this phase (tabulated only as ${phases}).`;
    else line = `${label}: not in the reference table.`;
    return { term, label, lookup, line };
  });
}

// --- provenance of what was used ----------------------------------------------------------------------------

/** The saved pages the thermodynamic values of the given table entries were read from. */
export function thermoDataSources(speciesIds: readonly string[], includeEntropy: boolean): ExperimentDataSource[] {
  const out = new Map<string, ExperimentDataSource>();
  const add = (pageKey: string, title: string): void => {
    const page = THERMO_PAGES[pageKey];
    if (page && !out.has(pageKey)) out.set(pageKey, { id: pageKey, title, retrieved: page.retrieved, sha256: page.sha256 });
  };
  for (const id of speciesIds) {
    const record = RECORD_BY_ID.get(id);
    if (!record) continue;
    const source = SOURCE_NAME.get(record.source) ?? record.source;
    add(record.page, record.source === 'codata-key-values' ? `${source} (table page)` : `${source}: ${record.printedAs}`);
    const points = [record.deltaHf298?.individualPointsPage, includeEntropy ? record.s298?.individualPointsPage : undefined];
    for (const key of points) if (key) add(key, `${source}: ${record.printedAs} (individual data points)`);
  }
  return [...out.values()];
}

/** The publication a shipped kinetic model was read from. */
export function kineticDataSource(model: KineticModel): ExperimentDataSource | undefined {
  const record = KINETIC_RECORDS.find((r) => r.id === model.id);
  const source = record ? KINETIC_SOURCE_RECORDS.find((s) => s.id === record.source) : undefined;
  if (!record || !source) return undefined;
  return { id: source.id, title: `${source.citation.title} (data sheet ${record.dataSheet})`, retrieved: source.retrieved, sha256: source.pdfSha256 };
}
