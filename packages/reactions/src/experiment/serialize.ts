import { EVIDENCE_LEVELS } from '@matterlab/core';
import { canonicalJson, fromSerializable, toSerializable } from './canonical';
import { sha256Hex } from './sha256';
import { EXPERIMENT_ENGINE, EXPERIMENT_RESULT_SCHEMA, EXPERIMENT_RESULT_SCHEMA_VERSION, EXPERIMENT_STATUSES, EXPERIMENT_STEP_IDS } from './types';
import type { ExperimentResult } from './types';

/**
 * An experiment result as JSON text.
 *
 * Typed arrays are written as plain arrays of numbers. The numbers JSON has no notation for (NaN, the
 * infinities, negative zero) are written as `{"$number":"NaN"}` and so on; they can only occur in a result
 * whose input was not valid. `parseExperimentResult` reverses both.
 *
 * @param space indentation, as for `JSON.stringify`; omit it for compact output.
 */
export function serializeExperimentResult(result: ExperimentResult, space?: number): string {
  return JSON.stringify(toSerializable(result), null, space);
}

// --- reading back ---------------------------------------------------------------------------------------------

function fail(message: string): never {
  throw new Error(`Not a readable MATTER LAB experiment result: ${message}`);
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

function objectAt(value: unknown, path: string): Json {
  return isObject(value) ? value : fail(`"${path}" must be an object.`);
}
function arrayAt(value: unknown, path: string): unknown[] {
  return Array.isArray(value) ? value : fail(`"${path}" must be an array.`);
}
function stringAt(value: unknown, path: string): string {
  return typeof value === 'string' ? value : fail(`"${path}" must be a string.`);
}
function numberAt(value: unknown, path: string): number {
  return typeof value === 'number' ? value : fail(`"${path}" must be a number.`);
}
function booleanAt(value: unknown, path: string): boolean {
  return typeof value === 'boolean' ? value : fail(`"${path}" must be true or false.`);
}
function oneOf(value: unknown, allowed: readonly string[], path: string): string {
  return typeof value === 'string' && allowed.includes(value) ? value : fail(`"${path}" must be one of ${allowed.join(', ')}; it is ${JSON.stringify(value)}.`);
}
function stringsAt(value: unknown, path: string): string[] {
  return arrayAt(value, path).map((item, index) => stringAt(item, `${path}[${index}]`));
}
function numbersAt(value: unknown, path: string): number[] {
  return arrayAt(value, path).map((item, index) => numberAt(item, `${path}[${index}]`));
}
function optional(record: Json, key: string, path: string, check: (value: unknown, path: string) => unknown): void {
  if (record[key] !== undefined) check(record[key], `${path}.${key}`);
}

const EVIDENCE = Object.keys(EVIDENCE_LEVELS);
const evidenceAt = (value: unknown, path: string): string => oneOf(value, EVIDENCE, path);

function checkEquation(value: unknown, path: string): void {
  const equation = objectAt(value, path);
  booleanAt(equation.reversible, `${path}.reversible`);
  for (const side of ['reactants', 'products'] as const) {
    arrayAt(equation[side], `${path}.${side}`).forEach((item, index) => {
      const where = `${path}.${side}[${index}]`;
      const term = objectAt(item, where);
      stringAt(term.formula, `${where}.formula`);
      numberAt(term.coefficient, `${where}.coefficient`);
      optional(term, 'phase', where, stringAt);
      const parsed = objectAt(term.parsed, `${where}.parsed`);
      numberAt(parsed.charge, `${where}.parsed.charge`);
      for (const [symbol, count] of Object.entries(objectAt(parsed.elements, `${where}.parsed.elements`))) numberAt(count, `${where}.parsed.elements.${symbol}`);
    });
  }
}

function checkBalance(value: unknown, path: string): void {
  const balance = objectAt(value, path);
  oneOf(balance.status, ['balanced', 'already-balanced', 'impossible', 'underdetermined'], `${path}.status`);
  stringAt(balance.message, `${path}.message`);
  numberAt(balance.independentSolutions, `${path}.independentSolutions`);
  optional(balance, 'equation', path, checkEquation);
}

function checkQuantity(value: unknown, path: string): void {
  const quantity = objectAt(value, path);
  numberAt(quantity.value, `${path}.value`);
  stringAt(quantity.unit, `${path}.unit`);
  evidenceAt(quantity.evidence, `${path}.evidence`);
  optional(quantity, 'uncertainty', path, numberAt);
}

function checkInput(value: unknown, path: string): void {
  const input = objectAt(value, path);
  optional(input, 'title', path, stringAt);
  stringAt(input.method, `${path}.method`);
  arrayAt(input.species, `${path}.species`).forEach((item, index) => {
    const where = `${path}.species[${index}]`;
    const species = objectAt(item, where);
    stringAt(species.formula, `${where}.formula`);
    stringAt(species.role, `${where}.role`);
    optional(species, 'phase', where, stringAt);
    optional(species, 'name', where, stringAt);
    optional(species, 'initialConcentration', where, numberAt);
    optional(species, 'coefficient', where, numberAt);
  });
  const conditions = objectAt(input.conditions, `${path}.conditions`);
  for (const key of ['temperatureK', 'pressureBar', 'durationSeconds']) numberAt(conditions[key], `${path}.conditions.${key}`);
  for (const key of ['environment', 'concentrationUnit']) stringAt(conditions[key], `${path}.conditions.${key}`);
  if (input.solver !== undefined) {
    const solver = objectAt(input.solver, `${path}.solver`);
    for (const key of ['tolerance', 'maxSteps', 'outputPoints']) optional(solver, key, `${path}.solver`, numberAt);
  }
}

function checkThermo(value: unknown, path: string): void {
  const thermo = objectAt(value, path);
  oneOf(thermo.status, ['ok', 'partial', 'unbalanced', 'missing-data', 'ambiguous-phase'], `${path}.status`);
  numberAt(thermo.temperatureK, `${path}.temperatureK`);
  booleanAt(thermo.withinValidatedRange, `${path}.withinValidatedRange`);
  evidenceAt(thermo.evidence, `${path}.evidence`);
  for (const key of ['missingSpecies', 'missingEntropy', 'assumptions', 'warnings']) stringsAt(thermo[key], `${path}.${key}`);
  for (const key of ['deltaH', 'deltaS', 'deltaG']) optional(thermo, key, path, checkQuantity);
  for (const key of ['lnK', 'log10K', 'equilibriumConstant']) optional(thermo, key, path, numberAt);
  optional(thermo, 'spontaneity', path, stringAt);
  arrayAt(thermo.terms, `${path}.terms`).forEach((item, index) => {
    const where = `${path}.terms[${index}]`;
    const term = objectAt(item, where);
    stringAt(term.term, `${where}.term`);
    stringAt(term.role, `${where}.role`);
    numberAt(term.coefficient, `${where}.coefficient`);
    stringAt(term.lookup, `${where}.lookup`);
  });
  objectAt(thermo.conservation, `${path}.conservation`);
}

function checkKineticModel(value: unknown, path: string): void {
  const model = objectAt(value, path);
  for (const key of ['id', 'name', 'reactionClass', 'equation', 'medium', 'notes', 'concentrationUnit']) stringAt(model[key], `${path}.${key}`);
  const rateLaw = objectAt(model.rateLaw, `${path}.rateLaw`);
  stringAt(rateLaw.description, `${path}.rateLaw.description`);
  for (const [name, order] of Object.entries(objectAt(rateLaw.orders, `${path}.rateLaw.orders`))) numberAt(order, `${path}.rateLaw.orders.${name}`);
  const arrhenius = objectAt(model.arrhenius, `${path}.arrhenius`);
  numberAt(arrhenius.A, `${path}.arrhenius.A`);
  stringAt(arrhenius.AUnits, `${path}.arrhenius.AUnits`);
  numberAt(arrhenius.EaKJPerMol, `${path}.arrhenius.EaKJPerMol`);
  if (numbersAt(model.validTemperatureRangeK, `${path}.validTemperatureRangeK`).length !== 2) fail(`"${path}.validTemperatureRangeK" must hold two temperatures.`);
  objectAt(model.provenance, `${path}.provenance`);
}

function checkRateConstant(value: unknown, path: string): void {
  const rate = objectAt(value, path);
  checkQuantity(rate.k, `${path}.k`);
  booleanAt(rate.withinValidatedRange, `${path}.withinValidatedRange`);
  stringsAt(rate.warnings, `${path}.warnings`);
  optional(rate, 'log10Uncertainty', path, numberAt);
}

/** Checks a kinetics result and puts its number arrays back into typed arrays. */
function reviveKinetics(value: unknown, path: string): void {
  const kinetics = objectAt(value, path);
  oneOf(kinetics.status, ['ok', 'incomplete', 'unsupported'], `${path}.status`);
  for (const key of ['reasons', 'warnings', 'species']) stringsAt(kinetics[key], `${path}.${key}`);
  for (const key of ['concentrationUnit', 'rateUnit']) stringAt(kinetics[key], `${path}.${key}`);
  evidenceAt(kinetics.evidence, `${path}.evidence`);
  booleanAt(kinetics.withinValidatedRange, `${path}.withinValidatedRange`);
  checkQuantity(kinetics.rateConstant, `${path}.rateConstant`);
  if (kinetics.halfLifeSeconds !== null) numberAt(kinetics.halfLifeSeconds, `${path}.halfLifeSeconds`);
  if (kinetics.halfLife !== null) {
    const halfLife = objectAt(kinetics.halfLife, `${path}.halfLife`);
    stringAt(halfLife.species, `${path}.halfLife.species`);
    numberAt(halfLife.seconds, `${path}.halfLife.seconds`);
    stringAt(halfLife.method, `${path}.halfLife.method`);
  }
  const solver = objectAt(kinetics.solver, `${path}.solver`);
  stringAt(solver.method, `${path}.solver.method`);
  for (const key of ['steps', 'rejectedSteps', 'tolerance', 'functionEvaluations']) numberAt(solver[key], `${path}.solver.${key}`);
  optional(solver, 'reactionCompleteAfterSeconds', `${path}.solver`, numberAt);
  optional(solver, 'stopReason', `${path}.solver`, stringAt);

  const times = numbersAt(kinetics.times, `${path}.times`);
  const rates = numbersAt(kinetics.rates, `${path}.rates`);
  if (rates.length !== times.length) fail(`"${path}.rates" has ${rates.length} values for ${times.length} times.`);
  kinetics.times = Float64Array.from(times);
  kinetics.rates = Float64Array.from(rates);
  const concentrations = objectAt(kinetics.concentrations, `${path}.concentrations`);
  for (const name of Object.keys(concentrations)) {
    const series = numbersAt(concentrations[name], `${path}.concentrations.${name}`);
    if (series.length !== times.length) fail(`"${path}.concentrations.${name}" has ${series.length} values for ${times.length} times.`);
    concentrations[name] = Float64Array.from(series);
  }
}

function checkSections(value: unknown, path: string): void {
  arrayAt(value, path).forEach((item, index) => {
    const where = `${path}[${index}]`;
    const section = objectAt(item, where);
    stringAt(section.heading, `${where}.heading`);
    stringsAt(section.paragraphs, `${where}.paragraphs`);
    optional(section, 'equation', where, stringAt);
    optional(section, 'evidence', where, evidenceAt);
  });
}

/**
 * Reads an experiment result written by `serializeExperimentResult` and returns it with its typed arrays
 * restored, equal to the result that was written.
 *
 * The text is checked before it is trusted: it must be JSON, carry the schema name and a schema version
 * this package reads, have every part of a result in its place and of the right type, and its `inputHash`
 * must be the hash of its `input`, so that a result whose input was edited afterwards is not accepted.
 *
 * @throws Error saying what is wrong.
 */
export function parseExperimentResult(json: string): ExperimentResult {
  if (typeof json !== 'string') fail('the argument must be JSON text.');
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    return fail(`the text is not valid JSON (${error instanceof Error ? error.message : String(error)}).`);
  }
  if (!isObject(raw)) return fail('the JSON text does not hold an object.');
  if (raw.schema !== EXPERIMENT_RESULT_SCHEMA) return fail(`the schema is ${JSON.stringify(raw.schema)}, not "${EXPERIMENT_RESULT_SCHEMA}".`);
  if (raw.schemaVersion !== EXPERIMENT_RESULT_SCHEMA_VERSION) {
    return fail(`the schema version is ${JSON.stringify(raw.schemaVersion)}; this version of ${EXPERIMENT_ENGINE} reads version ${EXPERIMENT_RESULT_SCHEMA_VERSION} only.`);
  }
  let decoded: unknown;
  try {
    decoded = fromSerializable(raw);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const result = objectAt(decoded, 'result');

  checkInput(result.input, 'input');
  const hash = stringAt(result.inputHash, 'inputHash');
  if (!/^[0-9a-f]{64}$/.test(hash)) fail('"inputHash" must be 64 hexadecimal digits.');
  if (sha256Hex(canonicalJson(result.input)) !== hash) fail('"inputHash" is not the hash of "input"; the result was changed after it was written.');

  oneOf(result.status, EXPERIMENT_STATUSES, 'status');
  evidenceAt(result.evidence, 'evidence');
  const steps = arrayAt(result.steps, 'steps');
  if (steps.length !== EXPERIMENT_STEP_IDS.length) fail(`"steps" must hold ${EXPERIMENT_STEP_IDS.length} steps; it holds ${steps.length}.`);
  steps.forEach((item, index) => {
    const where = `steps[${index}]`;
    const step = objectAt(item, where);
    if (step.id !== EXPERIMENT_STEP_IDS[index]) fail(`"${where}.id" must be "${EXPERIMENT_STEP_IDS[index]}"; it is ${JSON.stringify(step.id)}.`);
    stringAt(step.title, `${where}.title`);
    oneOf(step.status, ['passed', 'warning', 'failed', 'skipped'], `${where}.status`);
    stringAt(step.summary, `${where}.summary`);
    stringsAt(step.details, `${where}.details`);
  });

  if (result.equation !== null) {
    const equation = objectAt(result.equation, 'equation');
    stringAt(equation.text, 'equation.text');
    checkEquation(equation.balanced, 'equation.balanced');
    checkBalance(equation.balance, 'equation.balance');
  }
  if (result.balance !== null) checkBalance(result.balance, 'balance');
  if (result.thermo !== null) checkThermo(result.thermo, 'thermo');
  if (result.kineticModel !== null) checkKineticModel(result.kineticModel, 'kineticModel');
  if (result.rateConstant !== null) checkRateConstant(result.rateConstant, 'rateConstant');
  if (result.kinetics !== null) reviveKinetics(result.kinetics, 'kinetics');

  arrayAt(result.energyDiagrams, 'energyDiagrams').forEach((item, index) => {
    const where = `energyDiagrams[${index}]`;
    const diagram = objectAt(item, where);
    oneOf(diagram.quantity, ['enthalpy', 'gibbs'], `${where}.quantity`);
    if (diagram.unit !== 'kJ/mol') fail(`"${where}.unit" must be "kJ/mol".`);
    stringsAt(diagram.notes, `${where}.notes`);
    arrayAt(diagram.levels, `${where}.levels`).forEach((entry, position) => {
      const at = `${where}.levels[${position}]`;
      const level = objectAt(entry, at);
      oneOf(level.kind, ['reactants', 'barrier', 'products'], `${at}.kind`);
      stringAt(level.label, `${at}.label`);
      numberAt(level.value, `${at}.value`);
      evidenceAt(level.evidence, `${at}.evidence`);
      optional(level, 'note', at, stringAt);
    });
  });

  const explanation = objectAt(result.explanation, 'explanation');
  checkSections(explanation.beginner, 'explanation.beginner');
  checkSections(explanation.advanced, 'explanation.advanced');
  arrayAt(explanation.references, 'explanation.references').forEach((item, index) => {
    stringAt(objectAt(item, `explanation.references[${index}]`).title, `explanation.references[${index}].title`);
  });
  stringsAt(result.warnings, 'warnings');
  stringsAt(result.limitations, 'limitations');

  const reproducibility = objectAt(result.reproducibility, 'reproducibility');
  if (reproducibility.engine !== EXPERIMENT_ENGINE) fail(`"reproducibility.engine" must be "${EXPERIMENT_ENGINE}".`);
  stringAt(reproducibility.engineVersion, 'reproducibility.engineVersion');
  if (reproducibility.deterministic !== true) fail('"reproducibility.deterministic" must be true.');
  arrayAt(reproducibility.dataSources, 'reproducibility.dataSources').forEach((item, index) => {
    const where = `reproducibility.dataSources[${index}]`;
    const source = objectAt(item, where);
    stringAt(source.id, `${where}.id`);
    stringAt(source.title, `${where}.title`);
    optional(source, 'retrieved', where, stringAt);
    optional(source, 'sha256', where, stringAt);
  });
  if (reproducibility.solver !== null) {
    const solver = objectAt(reproducibility.solver, 'reproducibility.solver');
    stringAt(solver.method, 'reproducibility.solver.method');
    numberAt(solver.tolerance, 'reproducibility.solver.tolerance');
    numberAt(solver.steps, 'reproducibility.solver.steps');
    optional(solver, 'functionEvaluations', 'reproducibility.solver', numberAt);
  }
  return result as unknown as ExperimentResult;
}
