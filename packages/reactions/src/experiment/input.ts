import { hillFormula, normalizeFormulaText, parseFormula } from '../formula';
import type { ParsedFormula } from '../formula';
import { EXPERIMENT_CONCENTRATION_UNITS, EXPERIMENT_ENVIRONMENTS, EXPERIMENT_METHODS, SPECIES_ROLES } from './types';
import type { ExperimentConditions, ExperimentInput, ExperimentSolverSettings, ExperimentSpecies, SpeciesRole } from './types';

const PHASES: readonly string[] = ['g', 'l', 's', 'aq'];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const textOf = (value: unknown): string => (typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value));
/** Anything that is not a number becomes NaN, so that it is rejected by the validation instead of being coerced. */
const numberOf = (value: unknown): number => (typeof value === 'number' ? value : Number.NaN);

/**
 * The copy of an input that is run, hashed and returned with the result.
 *
 * It has exactly the documented properties (anything else is dropped), text is trimmed, formulas are
 * rewritten into the plain notation of `parseFormula` (Unicode subscripts and superscripts, typographic
 * dashes and dots), and optional properties that are absent or empty are left out. Nothing is corrected
 * or defaulted: a value of the wrong type is kept in a form that the validation rejects.
 */
export function normaliseInput(input: ExperimentInput): ExperimentInput {
  const source: Record<string, unknown> = isRecord(input) ? (input as unknown as Record<string, unknown>) : {};

  const species: ExperimentSpecies[] = (Array.isArray(source.species) ? source.species : []).map((entry: unknown) => {
    const item = isRecord(entry) ? entry : {};
    const name = textOf(item.name).trim();
    return {
      formula: normalizeFormulaText(textOf(item.formula).trim()),
      ...(item.phase !== undefined && item.phase !== null ? { phase: textOf(item.phase) as ExperimentSpecies['phase'] } : {}),
      role: textOf(item.role) as SpeciesRole,
      ...(name ? { name } : {}),
      ...(item.initialConcentration !== undefined && item.initialConcentration !== null ? { initialConcentration: numberOf(item.initialConcentration) } : {}),
      ...(item.coefficient !== undefined && item.coefficient !== null ? { coefficient: numberOf(item.coefficient) } : {}),
    };
  });

  const given = isRecord(source.conditions) ? source.conditions : {};
  const conditions: ExperimentConditions = {
    temperatureK: numberOf(given.temperatureK),
    pressureBar: numberOf(given.pressureBar),
    durationSeconds: numberOf(given.durationSeconds),
    environment: textOf(given.environment) as ExperimentConditions['environment'],
    concentrationUnit: textOf(given.concentrationUnit) as ExperimentConditions['concentrationUnit'],
  };

  let solver: ExperimentSolverSettings | undefined;
  if (isRecord(source.solver)) {
    const settings = source.solver;
    const picked = {
      ...(settings.tolerance !== undefined && settings.tolerance !== null ? { tolerance: numberOf(settings.tolerance) } : {}),
      ...(settings.maxSteps !== undefined && settings.maxSteps !== null ? { maxSteps: numberOf(settings.maxSteps) } : {}),
      ...(settings.outputPoints !== undefined && settings.outputPoints !== null ? { outputPoints: numberOf(settings.outputPoints) } : {}),
    };
    if (Object.keys(picked).length > 0) solver = picked;
  }

  const title = textOf(source.title).trim();
  return {
    ...(title ? { title } : {}),
    species,
    conditions,
    method: textOf(source.method) as ExperimentInput['method'],
    ...(solver ? { solver } : {}),
  };
}

/** A species of the input whose formula could be read. */
export interface ReadSpecies {
  /** Position in `input.species`. */
  readonly index: number;
  readonly species: ExperimentSpecies;
  readonly parsed: ParsedFormula;
  /** Composition and charge in Hill order; equal for two spellings of the same formula. */
  readonly composition: string;
  /** The formula with its phase label, e.g. "H2O(l)". */
  readonly label: string;
}

export interface InputValidation {
  /** Reasons why the input cannot be run; empty when it can. */
  readonly failures: readonly string[];
  readonly warnings: readonly string[];
  /** The species whose formula parses, in input order. */
  readonly species: readonly ReadSpecies[];
}

export const speciesLabel = (species: { readonly formula: string; readonly phase?: string }): string => `${species.formula}${species.phase ? `(${species.phase})` : ''}`;

const listOf = (items: readonly string[]): string => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/**
 * Checks that a normalised input can be run: every formula parses, the roles make an experiment, the
 * conditions are physical and nothing is entered twice. It does not look at the chemistry.
 */
export function validateInput(input: ExperimentInput): InputValidation {
  const failures: string[] = [];
  const warnings: string[] = [];
  const read: ReadSpecies[] = [];

  if (input.species.length === 0) failures.push('No species were given; an experiment needs at least one reactant.');
  input.species.forEach((species, index) => {
    const where = `Species ${index + 1}`;
    const shown = species.formula === '' ? where : `${where} ("${species.formula}")`;
    if (species.formula === '') {
      failures.push(`${where} has no formula.`);
    } else if (/\(\s*(?:g|l|s|aq|cr)\s*\)$/.test(species.formula)) {
      failures.push(`${shown}: the formula ends with a phase label. Give the phase in the phase field of the species and leave it out of the formula.`);
    } else {
      try {
        const parsed = parseFormula(species.formula);
        read.push({ index, species, parsed, composition: hillFormula(parsed), label: speciesLabel(species) });
      } catch (error) {
        failures.push(`${shown}: ${error instanceof Error ? error.message : String(error)}.`);
      }
    }
    if (!SPECIES_ROLES.includes(species.role)) failures.push(`${shown} has the unknown role "${species.role}"; the roles are ${listOf(SPECIES_ROLES)}.`);
    if (species.phase !== undefined && !PHASES.includes(species.phase)) failures.push(`${shown} has the unknown phase "${species.phase}"; the phases are ${listOf(PHASES)}.`);
    if (species.initialConcentration !== undefined && !(Number.isFinite(species.initialConcentration) && species.initialConcentration >= 0)) {
      failures.push(`${shown}: the initial concentration must be a non-negative, finite number; ${species.initialConcentration} is not.`);
    }
    if (species.coefficient !== undefined && !(Number.isFinite(species.coefficient) && species.coefficient > 0)) {
      failures.push(`${shown}: the coefficient must be a positive, finite number; ${species.coefficient} is not.`);
    }
  });

  if (input.species.length > 0 && !input.species.some((s) => s.role === 'reactant')) failures.push('No species has the role "reactant"; an experiment needs at least one.');

  // Coefficients fix the proportions of the equation, so they are needed for all of it or for none of it.
  const reacting = input.species.filter((s) => s.role === 'reactant' || s.role === 'product');
  const without = reacting.filter((s) => s.coefficient === undefined);
  if (without.length > 0 && without.length < reacting.length) {
    failures.push(`Coefficients were given for some reactants and products but not for ${listOf(without.map(speciesLabel))}. Give one for every reactant and product, or for none.`);
  }
  for (const s of input.species) {
    if (s.coefficient !== undefined && (s.role === 'catalyst' || s.role === 'solvent')) warnings.push(`The coefficient of ${speciesLabel(s)} is ignored: a ${s.role} is not part of the equation.`);
  }

  // The same substance in the same phase entered twice in one role.
  const seen = new Map<string, ReadSpecies>();
  const reported = new Set<string>();
  for (const entry of read) {
    const key = `${entry.species.role}|${entry.composition}|${entry.species.phase ?? ''}`;
    if (!seen.has(key)) {
      seen.set(key, entry);
    } else if (!reported.has(key)) {
      reported.add(key);
      const modelled = entry.species.role === 'reactant' || entry.species.role === 'product';
      if (modelled) failures.push(`${entry.label} is listed more than once as a ${entry.species.role}; remove the repeated entry.`);
      else warnings.push(`${entry.label} is listed more than once as a ${entry.species.role}.`);
    }
  }
  // The same substance in the same phase on both sides of the arrow.
  for (const entry of read) {
    if (entry.species.role !== 'reactant') continue;
    if (seen.has(`product|${entry.composition}|${entry.species.phase ?? ''}`) && seen.get(`reactant|${entry.composition}|${entry.species.phase ?? ''}`) === entry) {
      warnings.push(
        `${entry.label} is listed both as a reactant and as a product. A substance that is not used up belongs under the role catalyst or solvent; as entered, the equation cannot be balanced uniquely.`,
      );
    }
  }

  const { conditions } = input;
  if (!(Number.isFinite(conditions.temperatureK) && conditions.temperatureK > 0)) {
    failures.push(`The temperature must be a positive, finite number of kelvin; ${conditions.temperatureK} is not.`);
  }
  if (!(Number.isFinite(conditions.pressureBar) && conditions.pressureBar > 0)) failures.push(`The pressure must be a positive, finite number of bar; ${conditions.pressureBar} is not.`);
  if (!(Number.isFinite(conditions.durationSeconds) && conditions.durationSeconds > 0)) {
    failures.push(`The duration must be a positive, finite number of seconds; ${conditions.durationSeconds} is not.`);
  }
  if (!EXPERIMENT_ENVIRONMENTS.includes(conditions.environment)) {
    failures.push(`Unknown environment "${conditions.environment}"; the environments are ${listOf(EXPERIMENT_ENVIRONMENTS)}.`);
  }
  if (!EXPERIMENT_CONCENTRATION_UNITS.includes(conditions.concentrationUnit)) {
    failures.push(`Unknown concentration unit "${conditions.concentrationUnit}"; the units are ${listOf(EXPERIMENT_CONCENTRATION_UNITS)}.`);
  }
  if (!EXPERIMENT_METHODS.includes(input.method)) failures.push(`Unknown method "${input.method}"; the methods are ${listOf(EXPERIMENT_METHODS)}.`);

  const solver = input.solver;
  if (solver) {
    if (solver.tolerance !== undefined && !(solver.tolerance >= 1e-13 && solver.tolerance <= 1e-3)) failures.push(`The solver tolerance must lie between 1e-13 and 1e-3; ${solver.tolerance} does not.`);
    if (solver.maxSteps !== undefined && !(Number.isInteger(solver.maxSteps) && solver.maxSteps >= 1)) failures.push(`The solver step limit must be a positive whole number; ${solver.maxSteps} is not.`);
    if (solver.outputPoints !== undefined && !(Number.isInteger(solver.outputPoints) && solver.outputPoints >= 2 && solver.outputPoints <= 1_000_001)) {
      failures.push(`The number of output points must be a whole number between 2 and 1 000 001; ${solver.outputPoints} is not.`);
    }
  }

  return { failures, warnings, species: read };
}
