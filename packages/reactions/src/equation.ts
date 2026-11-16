import { ChemicalSyntaxError, normalizeFormulaText, parseFormula } from './formula';
import type { ParsedFormula } from './formula';
import { approximateFraction, parseRational, toNumber } from './rational';

export type Phase = 'g' | 'l' | 's' | 'aq';

export const PHASE_LABELS: Readonly<Record<Phase, string>> = {
  g: 'gas',
  l: 'liquid',
  s: 'solid',
  aq: 'aqueous solution',
};

export interface SpeciesTerm {
  /** The formula as written, in plain notation and without coefficient or phase label. */
  readonly formula: string;
  readonly phase?: Phase;
  /** Stoichiometric coefficient; always positive. */
  readonly coefficient: number;
  readonly parsed: ParsedFormula;
}

export interface ReactionEquation {
  readonly reactants: readonly SpeciesTerm[];
  readonly products: readonly SpeciesTerm[];
  /** True when the equation was written with an equilibrium arrow. */
  readonly reversible: boolean;
}

const ARROWS = /<=>|<->|\u21cc|\u21c4|\u21cb|\u2194|\u27f7|->|=>|\u2192|\u27f6|\u21d2|=/g;
const REVERSIBLE_ARROWS = new Set(['<=>', '<->', '\u21cc', '\u21c4', '\u21cb', '\u2194', '\u27f7']);
const PHASE_SUFFIX = /\(\s*(g|l|s|aq|cr)\s*\)$/;

function fail(message: string, input: string): never {
  throw new ChemicalSyntaxError(`${message} (in "${input}")`, input);
}

/**
 * Splits one side of an equation into its terms. A "+" separates terms unless it is the charge of the
 * species it touches: "Na+ + Cl-" is two terms, and so are "Na++Cl-", "H+(aq) + OH-(aq)", "Ca++ + 2 Cl-"
 * and "Cu+2 + Zn" (the charge notation of the CODATA table).
 *
 * A plus sign is read as a charge only when it directly follows its species and is itself followed by
 * the end of the side, by another plus sign, by a phase label, or by a bare number (a charge magnitude).
 * In every other position it is a separator, so "A + + B" is an error rather than an ion.
 */
function splitTerms(side: string, input: string): string[] {
  const terms: string[] = [];
  let start = 0;
  for (let i = 0; i < side.length; i++) {
    if (side[i] !== '+') continue;
    const touchesSpecies = i > start && side[i - 1] !== ' ';
    const rest = side.slice(i + 1);
    const isCharge = touchesSpecies && (rest === '' || /^ ?\+/.test(rest) || /^\((?:g|l|s|aq|cr)\)/.test(rest) || /^\d+(?:$| |\+|\((?:g|l|s|aq|cr)\))/.test(rest));
    if (isCharge) continue;
    terms.push(side.slice(start, i));
    start = i + 1;
  }
  terms.push(side.slice(start));
  const trimmed = terms.map((t) => t.trim());
  if (trimmed.some((t) => t === '')) fail('A term is missing next to a "+"', input);
  return trimmed;
}

function parseTerm(text: string, input: string): SpeciesTerm {
  const m = /^(\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?)?\s*(.*)$/.exec(text)!;
  let coefficient = 1;
  if (m[1] !== undefined) {
    const exact = parseRational(m[1]);
    if (!exact || exact.n <= 0n) fail(`"${m[1]}" is not a usable coefficient; coefficients must be positive`, input);
    coefficient = toNumber(exact);
    if (!Number.isFinite(coefficient) || coefficient <= 0) fail(`"${m[1]}" is not a usable coefficient`, input);
  }
  let rest = m[2]!.trim();
  if (rest === '') fail(`The coefficient "${m[1]}" is not followed by a formula`, input);
  let phase: Phase | undefined;
  const suffix = PHASE_SUFFIX.exec(rest);
  if (suffix) {
    phase = suffix[1] === 'cr' ? 's' : (suffix[1] as Phase);
    rest = rest.slice(0, suffix.index).trim();
    if (rest === '') fail(`The phase label "${suffix[0]}" is not attached to a formula`, input);
  }
  const parsed = parseFormula(rest);
  return phase ? { formula: rest, phase, coefficient, parsed } : { formula: rest, coefficient, parsed };
}

/**
 * Reads a reaction equation such as "2 H2(g) + O2(g) -> 2 H2O(l)".
 *
 * - Arrows: "->", "=>", "=" and the Unicode arrows for a one-way reaction; "<=>", "<->" and the Unicode
 *   equilibrium arrows set `reversible`.
 * - Coefficients: whole numbers, decimals or fractions ("1/2 O2"); a missing coefficient is 1.
 * - Phase labels: (g), (l), (s), (aq); (cr) is read as (s).
 * - Formulas: everything `parseFormula` reads, including ions and "e-".
 *
 * Parsing checks syntax only. It does not check that the equation is balanced (see `checkConservation`)
 * and says nothing about whether the reaction actually takes place.
 *
 * @throws ChemicalSyntaxError
 */
export function parseEquation(text: string): ReactionEquation {
  if (typeof text !== 'string') throw new TypeError('parseEquation expects a string.');
  const input = normalizeFormulaText(text).replace(/\s+/g, ' ').trim();
  if (input === '') fail('The equation is empty', text);
  const arrows = [...input.matchAll(ARROWS)];
  if (arrows.length === 0) fail('No reaction arrow found; use "->" (or "<=>" for an equilibrium)', input);
  if (arrows.length > 1) fail('More than one reaction arrow found', input);
  const arrow = arrows[0]!;
  const left = input.slice(0, arrow.index).trim();
  const right = input.slice(arrow.index + arrow[0].length).trim();
  if (left === '') fail('Nothing is written before the arrow', input);
  if (right === '') fail('Nothing is written after the arrow', input);
  return {
    reactants: splitTerms(left, input).map((t) => parseTerm(t, input)),
    products: splitTerms(right, input).map((t) => parseTerm(t, input)),
    reversible: REVERSIBLE_ARROWS.has(arrow[0]),
  };
}

/** A coefficient as text: "" for 1, "2", "1/2", or a decimal when it is not a simple fraction. */
export function formatCoefficient(coefficient: number): string {
  if (coefficient === 1) return '';
  if (Number.isInteger(coefficient)) return String(coefficient);
  const simple = approximateFraction(coefficient, 1000);
  if (simple && simple.d !== 1n) return `${simple.n}/${simple.d}`;
  return String(Number(coefficient.toPrecision(12)));
}

export function formatTerm(term: SpeciesTerm): string {
  const coefficient = formatCoefficient(term.coefficient);
  return `${coefficient}${coefficient ? ' ' : ''}${term.formula}${term.phase ? `(${term.phase})` : ''}`;
}

/** Plain-text form that `parseEquation` reads back: "2 H2(g) + O2(g) -> 2 H2O(l)". */
export function formatEquation(eq: ReactionEquation): string {
  const side = (terms: readonly SpeciesTerm[]): string => terms.map(formatTerm).join(' + ');
  return `${side(eq.reactants)} ${eq.reversible ? '<=>' : '->'} ${side(eq.products)}`;
}

export interface ConservationReport {
  readonly balanced: boolean;
  /** Atoms of each element on the product side minus the reactant side; every element present is listed. */
  readonly elementImbalance: Readonly<Record<string, number>>;
  /** Charge on the product side minus the reactant side, in elementary charges. */
  readonly chargeImbalance: number;
}

/** Checks conservation of every element and of charge for the equation exactly as written. */
export function checkConservation(eq: ReactionEquation): ConservationReport {
  const elements = new Map<string, number>();
  const magnitude = new Map<string, number>();
  let charge = 0;
  let chargeMagnitude = 0;
  const tally = (terms: readonly SpeciesTerm[], sign: 1 | -1): void => {
    for (const term of terms) {
      for (const [symbol, count] of Object.entries(term.parsed.elements)) {
        elements.set(symbol, (elements.get(symbol) ?? 0) + sign * term.coefficient * count);
        magnitude.set(symbol, (magnitude.get(symbol) ?? 0) + term.coefficient * count);
      }
      charge += sign * term.coefficient * term.parsed.charge;
      chargeMagnitude += Math.abs(term.coefficient * term.parsed.charge);
    }
  };
  tally(eq.products, 1);
  tally(eq.reactants, -1);
  // Coefficients may be decimals, so sums are compared against the rounding error of their own size.
  const settle = (value: number, scale: number): number => (Math.abs(value) <= 1e-9 * Math.max(1, scale) ? 0 : value);
  const elementImbalance: Record<string, number> = {};
  for (const [symbol, value] of elements) elementImbalance[symbol] = settle(value, magnitude.get(symbol) ?? 0);
  const chargeImbalance = settle(charge, chargeMagnitude);
  const balanced = chargeImbalance === 0 && Object.values(elementImbalance).every((v) => v === 0);
  return { balanced, elementImbalance, chargeImbalance };
}

/** The same reaction written in the opposite direction. */
export function reverseEquation(eq: ReactionEquation): ReactionEquation {
  return { reactants: eq.products, products: eq.reactants, reversible: eq.reversible };
}

/** The same reaction with every coefficient multiplied by a positive factor. */
export function scaleEquation(eq: ReactionEquation, factor: number): ReactionEquation {
  if (!Number.isFinite(factor) || factor <= 0) throw new RangeError('The scale factor must be a positive number.');
  const scale = (terms: readonly SpeciesTerm[]): SpeciesTerm[] => terms.map((t) => ({ ...t, coefficient: t.coefficient * factor }));
  return { reactants: scale(eq.reactants), products: scale(eq.products), reversible: eq.reversible };
}

export function asEquation(input: ReactionEquation | string): ReactionEquation {
  return typeof input === 'string' ? parseEquation(input) : input;
}
