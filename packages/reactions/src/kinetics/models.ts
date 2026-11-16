import { AVOGADRO, GAS_CONSTANT_J_PER_MOL_K } from '@matterlab/core';
import type { Citation, EvidenceLevel, Provenance, Quantity } from '@matterlab/core';
import { KINETIC_RECORDS, KINETIC_SOURCE_RECORDS } from '../data/kinetics.generated';
import type { KineticRecord, KineticSourceRecord } from '../data/records';
import { asEquation, formatCoefficient, parseEquation } from '../equation';
import type { ReactionEquation, SpeciesTerm } from '../equation';
import { hillFormula } from '../formula';

export interface KineticModel {
  readonly id: string;
  readonly name: string;
  /** Identifier of an entry of `SUPPORTED_REACTION_CLASSES`. */
  readonly reactionClass: string;
  /** The reaction, in a form `parseEquation` reads. Species are named by the formulas used here. */
  readonly equation: string;
  readonly medium: 'gas' | 'aqueous' | 'solution' | 'other';
  /**
   * Rate of reaction = k × product of [X]^order over the species listed. Each species then changes at its
   * net stoichiometric coefficient times that rate (for "2 A -> ..." the concentration of A falls at twice the rate).
   */
  readonly rateLaw: { readonly orders: Readonly<Record<string, number>>; readonly description: string };
  /** k = A exp(−Ea / RT). `Ea` is negative for a rate constant that falls with rising temperature. */
  readonly arrhenius: { readonly A: number; readonly AUnits: string; readonly EaKJPerMol: number };
  /** Temperatures over which the source recommends the expression. */
  readonly validTemperatureRangeK: readonly [number, number];
  readonly notes: string;
  readonly provenance: Provenance;
  /** Unit of every concentration that goes into, or comes out of, a simulation of this model. */
  readonly concentrationUnit: string;
  /**
   * How far the rate parameters can be trusted: `reference` for the models shipped with the package, which
   * come from a cited evaluation. Give anything else (for example `user-input`) to a model you build yourself;
   * results computed from it then carry that label instead of `computed`.
   */
  readonly parameterEvidence: EvidenceLevel;
  /** Readable name of each species of `equation`. */
  readonly speciesNames?: Readonly<Record<string, string>>;
  /** Conditions the expression is restricted to, beyond temperature (for example a total pressure). */
  readonly conditions?: string;
  /** The total pressure in bar that `conditions` restricts the expression to, when it states one. */
  readonly requiredPressureBar?: number;
  /** The reliability the source assigns to the preferred values. */
  readonly reliability?: {
    /** Uncertainty of log10 k at 298 K. */
    readonly deltaLog10K298: number;
    /** Uncertainty of E/R in kelvin. */
    readonly deltaEOverRK: number;
    readonly meaning: string;
  };
  /** The preferred values exactly as the source prints them. */
  readonly asPublished?: {
    readonly dataSheet: string;
    readonly location: string;
    readonly reaction: string;
    readonly expression: string;
    readonly A: number;
    readonly AUnits: string;
    /** E/R in kelvin, the form in which the source gives the temperature dependence. */
    readonly EOverRK: number;
    readonly k298: number;
    readonly k298Text: string;
    /** Standard reaction enthalpy at 298 K printed on the data sheet, in kJ/mol. */
    readonly reactionEnthalpyKJPerMol?: number;
  };
}

/** Number of molecules per cubic centimetre in one mole per litre: N_A / 1000 (exact). */
export const MOLECULES_PER_CM3_PER_MOL_PER_L = AVOGADRO / 1000;

const SOURCES = new Map<string, KineticSourceRecord>(KINETIC_SOURCE_RECORDS.map((s) => [s.id, s]));

const RELIABILITY_MEANING =
  'Expanded uncertainties corresponding approximately to a 95 % confidence limit, assigned by the evaluators as a subjective assessment (IUPAC evaluation, "Assignment of uncertainties").';

function rateLawDescription(equation: ReactionEquation, orders: Readonly<Record<string, number>>): string {
  const factors = Object.entries(orders)
    .map(([formula, order]) => (order === 1 ? `[${formula}]` : `[${formula}]^${order}`))
    .join(' ');
  const changes = (terms: readonly SpeciesTerm[], sign: string): string[] =>
    terms.map((t) => `d[${t.formula}]/dt = ${sign}${formatCoefficient(t.coefficient)}${t.coefficient === 1 ? '' : ' '}rate`);
  return `rate = k ${factors}; ${[...changes(equation.reactants, '-'), ...changes(equation.products, '+')].join(', ')}.`;
}

function toCitation(source: KineticSourceRecord): Citation {
  const c = source.citation;
  return {
    ...(c.authors ? { authors: c.authors } : {}),
    title: c.title,
    ...(c.source ? { source: c.source } : {}),
    ...(c.year !== undefined ? { year: c.year } : {}),
    ...(c.doi ? { doi: c.doi } : {}),
    ...(c.url ? { url: c.url } : {}),
  };
}

function buildModel(record: KineticRecord): KineticModel {
  const source = SOURCES.get(record.source);
  if (!source) throw new Error(`Generated kinetic data for ${record.id} refer to an unknown source.`);
  const equation = parseEquation(record.equation);
  const orders: Record<string, number> = {};
  for (const t of equation.reactants) orders[t.formula] = (orders[t.formula] ?? 0) + t.coefficient;
  const [low, high] = record.temperatureRangeK;
  const pressureBar = record.pressure ? /^(\d+(?:\.\d+)?) bar$/.exec(record.pressure) : null;
  if (record.pressure && !pressureBar) throw new Error(`Generated kinetic data for ${record.id} state a pressure that cannot be read: "${record.pressure}".`);
  const notes = [
    `Preferred values of data sheet ${record.dataSheet} of the IUPAC evaluation of kinetic data for atmospheric chemistry, as printed: "${record.expressionAsPrinted}"`,
    'The evaluation lists elementary reactions, so the rate law follows from the reaction as written.',
    'The model describes this one step in isolation. Its products may react further and its reactants may take part in other reactions; none of that is included, so a simulation is not a prediction of what a real mixture does.',
    ...(record.pressure ? [`The expression holds at ${record.pressure} total pressure only.`] : []),
    ...(record.extraNotes ? [record.extraNotes] : []),
    'The IUPAC Task Group publishes its current data sheets at https://iupac.aeris-data.fr; the values here are those of the cited publication and may have been revised since.',
  ];
  return {
    id: record.id,
    name: record.name,
    reactionClass: record.reactionClass,
    equation: record.equation,
    medium: 'gas',
    rateLaw: { orders, description: rateLawDescription(equation, orders) },
    arrhenius: { A: record.A, AUnits: record.AUnits, EaKJPerMol: (record.EOverRK * GAS_CONSTANT_J_PER_MOL_K) / 1000 },
    validTemperatureRangeK: [low, high],
    notes: notes.join(' '),
    provenance: {
      source: 'IUPAC Subcommittee on Gas Kinetic Data Evaluation for Atmospheric Chemistry',
      version: `data sheet ${record.dataSheet}`,
      citations: [toCitation(source)],
      url: source.url,
      retrieved: source.retrieved,
      license: source.license,
      notes:
        `Data sheet ${record.dataSheet}, ${record.location}. Read from the excerpt packages/reactions/data/sources/${source.excerpt} of ${source.pdfUrl} ` +
        `(SHA-256 of the PDF as retrieved: ${source.pdfSha256}). The licence is that of the article and covers the excerpt kept in the repository; ` +
        'the package itself reproduces only the rate parameters, with this citation.',
    },
    concentrationUnit: 'molecule cm-3',
    parameterEvidence: 'reference',
    speciesNames: record.speciesNames,
    ...(record.pressure ? { conditions: `${record.pressure} total pressure` } : {}),
    ...(pressureBar ? { requiredPressureBar: Number(pressureBar[1]) } : {}),
    reliability: { deltaLog10K298: record.deltaLog10K298, deltaEOverRK: record.deltaEOverRK, meaning: RELIABILITY_MEANING },
    asPublished: {
      dataSheet: record.dataSheet,
      location: record.location,
      reaction: record.reactionAsPrinted,
      expression: record.expressionAsPrinted,
      A: record.A,
      AUnits: record.AUnits,
      EOverRK: record.EOverRK,
      k298: record.k298,
      k298Text: record.k298AsPrinted,
      ...(record.reactionEnthalpyKJPerMol !== undefined ? { reactionEnthalpyKJPerMol: record.reactionEnthalpyKJPerMol } : {}),
    },
  };
}

/**
 * Kinetic models with sourced Arrhenius parameters. All are gas-phase elementary reactions from the IUPAC
 * evaluation of kinetic data for atmospheric chemistry, in the units of the source: concentrations in
 * molecule cm-3, time in seconds. Use `toMolarUnits` for mol/L.
 */
export const KINETIC_MODELS: readonly KineticModel[] = KINETIC_RECORDS.map(buildModel);

/** The publications the kinetic models are taken from, with the passages that define their conventions. */
export const KINETIC_DATA_SOURCES: readonly {
  readonly id: string;
  readonly citation: Citation;
  readonly url: string;
  readonly retrieved: string;
  readonly license: string;
  readonly statements: readonly { readonly label: string; readonly location: string; readonly text: string }[];
  readonly modelCount: number;
}[] = KINETIC_SOURCE_RECORDS.map((s) => ({
  id: s.id,
  citation: toCitation(s),
  url: s.url,
  retrieved: s.retrieved,
  license: s.license,
  statements: s.statements,
  modelCount: KINETIC_RECORDS.filter((r) => r.source === s.id).length,
}));

/** Label for a result computed from a model's parameters, inside or outside the validated temperature range. */
export function kineticEvidence(model: KineticModel, withinValidatedRange: boolean): EvidenceLevel {
  if (model.parameterEvidence !== 'reference' && model.parameterEvidence !== 'computed') return model.parameterEvidence;
  return withinValidatedRange ? 'computed' : 'rule-based';
}

export interface RateConstantResult {
  /** k at the requested temperature, in the units of `model.arrhenius.AUnits`. */
  readonly k: Quantity;
  /** False when the temperature lies outside `model.validTemperatureRangeK`; the value is then an extrapolation. */
  readonly withinValidatedRange: boolean;
  /**
   * Uncertainty of log10 k at this temperature, from the source's reliability figures:
   * Δlog k(T) = Δlog k(298 K) + 0.4343 · Δ(E/R) · |1/T − 1/298|. Only given inside the validated range.
   * It is an expanded uncertainty (about 95 % confidence), i.e. k is uncertain by a factor of 10^value.
   */
  readonly log10Uncertainty?: number;
  readonly warnings: readonly string[];
}

/**
 * Rate constant of a model at a temperature, k = A exp(−Ea / RT).
 *
 * Outside the validated range the value is still returned, but it is flagged three ways:
 * `withinValidatedRange` is false, the evidence label drops from `computed` to `rule-based`, and a warning
 * says that the number is an extrapolation.
 *
 * @throws RangeError when the temperature is not a positive, finite number.
 */
export function rateConstant(model: KineticModel, temperatureK: number): RateConstantResult {
  if (!Number.isFinite(temperatureK) || temperatureK <= 0) throw new RangeError('The temperature must be a positive number of kelvin.');
  const [low, high] = model.validTemperatureRangeK;
  const withinValidatedRange = temperatureK >= low && temperatureK <= high;
  const value = model.arrhenius.A * Math.exp((-model.arrhenius.EaKJPerMol * 1000) / (GAS_CONSTANT_J_PER_MOL_K * temperatureK));
  const warnings: string[] = [];
  if (!withinValidatedRange) {
    warnings.push(
      `TEMPERATURE OUTSIDE THE VALIDATED RANGE: the rate expression of "${model.name}" is recommended for ${low} K to ${high} K, and ${temperatureK} K is ${
        temperatureK < low ? 'below' : 'above'
      } that range. The rate constant is an extrapolation of the Arrhenius expression; its error is unknown.`,
    );
  }
  if (model.conditions) warnings.push(`The rate expression applies at ${model.conditions} only.`);
  if (model.parameterEvidence !== 'reference') {
    warnings.push(`The rate parameters of "${model.name}" are labelled "${model.parameterEvidence}", not reference data.`);
  }
  let log10Uncertainty: number | undefined;
  if (withinValidatedRange && model.reliability) {
    log10Uncertainty = model.reliability.deltaLog10K298 + 0.4343 * model.reliability.deltaEOverRK * Math.abs(1 / temperatureK - 1 / 298);
  }
  return {
    k: {
      value,
      unit: model.arrhenius.AUnits,
      evidence: kineticEvidence(model, withinValidatedRange),
      provenance: {
        ...model.provenance,
        notes: `k = A exp(-Ea/RT) at ${temperatureK} K with A = ${model.arrhenius.A} ${model.arrhenius.AUnits} and Ea = ${model.arrhenius.EaKJPerMol} kJ/mol. ${model.provenance.notes ?? ''}`.trim(),
      },
    },
    withinValidatedRange,
    ...(log10Uncertainty !== undefined ? { log10Uncertainty } : {}),
    warnings,
  };
}

const MOLAR_UNITS: Readonly<Record<string, { readonly units: string; readonly order: number }>> = {
  's-1': { units: 's-1', order: 1 },
  'cm3 molecule-1 s-1': { units: 'L mol-1 s-1', order: 2 },
  'cm6 molecule-2 s-1': { units: 'L2 mol-2 s-1', order: 3 },
};

/**
 * The same model with concentrations in mol/L instead of molecule cm-3. Only the pre-exponential factor
 * changes, by (N_A / 1000)^(order − 1); N_A is exact, so no accuracy is lost. A model that is already in
 * mol/L is returned as it is.
 *
 * @throws RangeError for a model in any other unit system.
 */
export function toMolarUnits(model: KineticModel): KineticModel {
  if (model.concentrationUnit === 'mol/L') return model;
  const target = MOLAR_UNITS[model.arrhenius.AUnits];
  if (model.concentrationUnit !== 'molecule cm-3' || !target) {
    throw new RangeError(`Cannot convert a model with concentrations in ${model.concentrationUnit} and A in ${model.arrhenius.AUnits} to mol/L.`);
  }
  return {
    ...model,
    arrhenius: { ...model.arrhenius, A: model.arrhenius.A * MOLECULES_PER_CM3_PER_MOL_PER_L ** (target.order - 1), AUnits: target.units },
    concentrationUnit: 'mol/L',
    notes: `${model.notes} Converted from molecule cm-3 to mol/L with the exact Avogadro constant (1 mol/L = ${MOLECULES_PER_CM3_PER_MOL_PER_L} molecule cm-3).`,
  };
}

function sideSignature(terms: readonly SpeciesTerm[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of terms) out.set(hillFormula(t.parsed), (out.get(hillFormula(t.parsed)) ?? 0) + t.coefficient);
  return out;
}

/**
 * The shipped kinetic models whose reaction is the given one: the same species on each side, with
 * coefficients in the same proportion (so "NO + 1/2 O2 -> NO2" finds the model written "2 NO + O2 -> 2 NO2").
 * The reverse reaction does not match, and neither does an equation with a phase label other than (g).
 * An empty result means the package has no sourced rate law for the reaction; it never substitutes one.
 */
export function findKineticModels(eq: ReactionEquation | string): KineticModel[] {
  const equation = asEquation(eq);
  if ([...equation.reactants, ...equation.products].some((t) => t.phase !== undefined && t.phase !== 'g')) return [];
  const left = sideSignature(equation.reactants);
  const right = sideSignature(equation.products);
  return KINETIC_MODELS.filter((model) => {
    const reference = parseEquation(model.equation);
    const modelLeft = sideSignature(reference.reactants);
    const modelRight = sideSignature(reference.products);
    if (modelLeft.size !== left.size || modelRight.size !== right.size) return false;
    let ratio: number | undefined;
    const proportional = (mine: Map<string, number>, theirs: Map<string, number>): boolean => {
      for (const [key, coefficient] of mine) {
        const other = theirs.get(key);
        if (other === undefined) return false;
        const r = coefficient / other;
        if (ratio === undefined) ratio = r;
        else if (Math.abs(r - ratio) > 1e-9 * ratio) return false;
      }
      return true;
    };
    return proportional(left, modelLeft) && proportional(right, modelRight);
  });
}
