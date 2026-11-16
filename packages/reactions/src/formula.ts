import { ELECTRON_MASS_U, ELEMENTS } from '@matterlab/core';

export interface ParsedFormula {
  /** Number of atoms of each element, keyed by symbol, in order of first appearance. */
  readonly elements: Readonly<Record<string, number>>;
  /** Net charge in units of the elementary charge. */
  readonly charge: number;
}

/** Thrown for anything that cannot be read as a formula or an equation. */
export class ChemicalSyntaxError extends Error {
  /** The text that was being read. */
  readonly input: string;
  /** 0-based index into the normalized form of `input` at which the problem was noticed, when known. */
  readonly position: number | undefined;

  constructor(message: string, input: string, position?: number) {
    super(message);
    this.name = 'ChemicalSyntaxError';
    this.input = input;
    this.position = position;
  }
}

/** Symbols are matched exactly: "Co" is cobalt and "CO" is carbon monoxide. */
const ATOMIC_WEIGHT = new Map(ELEMENTS.map((e) => [e.symbol, e.atomicWeight]));

const SUBSCRIPT_DIGITS = '\u2080\u2081\u2082\u2083\u2084\u2085\u2086\u2087\u2088\u2089';
const SUPERSCRIPTS: Readonly<Record<string, string>> = {
  '\u2070': '0',
  '\u00b9': '1',
  '\u00b2': '2',
  '\u00b3': '3',
  '\u2074': '4',
  '\u2075': '5',
  '\u2076': '6',
  '\u2077': '7',
  '\u2078': '8',
  '\u2079': '9',
  '\u207a': '+',
  '\u207b': '-',
};
/** Characters accepted as the dot of a hydrate or adduct, besides ".". */
const HYDRATE_DOTS = '\u00b7\u2022\u2219\u22c5*';
/** Characters accepted as a minus sign, besides "-": hyphen, non-breaking hyphen, figure dash, en dash, minus. */
const MINUS_SIGNS = '\u2010\u2011\u2012\u2013\u2212';

/**
 * Rewrites the typographic variants of a formula into the plain notation the parser reads: Unicode
 * subscripts become digits, a run of Unicode superscripts becomes "^" followed by its digits and signs,
 * the various dots become "." and the various dashes become "-".
 */
export function normalizeFormulaText(text: string): string {
  let out = '';
  let inSuperscript = false;
  for (const ch of text) {
    const sup = SUPERSCRIPTS[ch];
    if (sup !== undefined) {
      out += inSuperscript ? sup : `^${sup}`;
      inSuperscript = true;
      continue;
    }
    inSuperscript = false;
    const sub = SUBSCRIPT_DIGITS.indexOf(ch);
    if (sub >= 0) out += String(sub);
    else if (HYDRATE_DOTS.includes(ch)) out += '.';
    else if (MINUS_SIGNS.includes(ch)) out += '-';
    else out += ch;
  }
  return out;
}

const OPENERS: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = new Set(Object.values(OPENERS));
const isDigit = (ch: string | undefined): boolean => ch !== undefined && ch >= '0' && ch <= '9';
const isLower = (ch: string | undefined): boolean => ch !== undefined && ch >= 'a' && ch <= 'z';
const isUpper = (ch: string | undefined): boolean => ch !== undefined && ch >= 'A' && ch <= 'Z';

class FormulaReader {
  private readonly text: string;
  private pos = 0;
  /** Number of digits of the count on the last top-level unit read, or 0 when it had none. */
  private lastCountDigits = 0;
  private topLevelUnits = 0;

  constructor(text: string) {
    this.text = text;
  }

  private fail(message: string, position = this.pos): never {
    throw new ChemicalSyntaxError(`${message} (in "${this.text}")`, this.text, position);
  }

  private skipSpaces(): void {
    while (this.text[this.pos] === ' ') this.pos++;
  }

  private readInteger(): number | undefined {
    const start = this.pos;
    while (isDigit(this.text[this.pos])) this.pos++;
    if (this.pos === start) return undefined;
    const digits = this.text.slice(start, this.pos);
    const value = Number(digits);
    if (!Number.isSafeInteger(value)) this.fail(`The number ${digits} is too large`, start);
    if (value === 0) this.fail('A count of zero is not allowed', start);
    return value;
  }

  private static merge(into: Map<string, number>, from: Map<string, number>, times: number): void {
    for (const [symbol, count] of from) into.set(symbol, (into.get(symbol) ?? 0) + count * times);
  }

  /** One or more elements or bracketed groups; stops at a closing bracket, a dot, a charge or the end. */
  private readUnits(closer: string | undefined): Map<string, number> {
    const atoms = new Map<string, number>();
    const topLevel = closer === undefined;
    let any = false;
    for (;;) {
      const ch = this.text[this.pos];
      if (ch === undefined) break;
      let digits = 0;
      if (isUpper(ch)) {
        const start = this.pos++;
        while (isLower(this.text[this.pos])) this.pos++;
        const symbol = this.text.slice(start, this.pos);
        if (!ATOMIC_WEIGHT.has(symbol)) {
          this.fail(`Unknown element symbol "${symbol}" (symbols are case-sensitive: "Co" is cobalt, "CO" is carbon monoxide)`, start);
        }
        const countAt = this.pos;
        const count = this.readInteger();
        digits = this.pos - countAt;
        atoms.set(symbol, (atoms.get(symbol) ?? 0) + (count ?? 1));
      } else if (ch in OPENERS) {
        const start = this.pos++;
        const close = OPENERS[ch]!;
        const inner = this.readUnits(close);
        if (this.text[this.pos] !== close) this.fail(`"${ch}" is never closed`, start);
        this.pos++;
        const countAt = this.pos;
        const count = this.readInteger();
        digits = this.pos - countAt;
        FormulaReader.merge(atoms, inner, count ?? 1);
      } else if (CLOSERS.has(ch)) {
        if (ch !== closer) this.fail(closer ? `Expected "${closer}" but found "${ch}"` : `Unmatched "${ch}"`);
        break;
      } else if (isLower(ch)) {
        this.fail(`Unexpected "${ch}"; element symbols start with a capital letter`);
      } else if (isDigit(ch)) {
        this.fail('A number must follow an element or a closing bracket');
      } else {
        break;
      }
      any = true;
      if (topLevel) {
        this.topLevelUnits++;
        this.lastCountDigits = digits;
      }
    }
    if (!any) this.fail(closer ? 'Empty brackets' : 'Expected an element symbol');
    return atoms;
  }

  private chargeOf(sign: string, digits: string, position: number): number {
    const magnitude = digits === '' ? 1 : Number(digits);
    if (!Number.isSafeInteger(magnitude) || magnitude === 0) this.fail('The charge must be a non-zero whole number', position);
    return sign === '+' ? magnitude : -magnitude;
  }

  private readCharge(): number {
    const start = this.pos;
    const rest = this.text.slice(start);
    this.pos = this.text.length;
    if (rest === '') return 0;
    let m: RegExpExecArray | null;
    // "^2-", "^-", "^3+"
    if ((m = /^\^(\d*)([+-])$/.exec(rest))) return this.chargeOf(m[2]!, m[1]!, start);
    // "^-2", "^+3"
    if ((m = /^\^([+-])(\d+)$/.exec(rest))) return this.chargeOf(m[1]!, m[2]!, start);
    // "+2", "-2": the form used in the CODATA table ("SO4-2")
    if ((m = /^([+-])(\d+)$/.exec(rest))) return this.chargeOf(m[1]!, m[2]!, start);
    // "+", "-", "++", "--"
    if (/^(\++|-+)$/.test(rest)) {
      if (rest.length === 1 && this.lastCountDigits > 0 && (this.topLevelUnits === 1 || this.lastCountDigits > 1)) {
        // A bare sign straight after a count is how people type both "NH4+" and "Fe3+". In "NH4+" the count
        // plainly belongs to the hydrogens. When the formula is a single element or bracket ("Fe3+",
        // "[Fe(CN)6]4-") or the count has several digits ("SO42-"), the digits may be the charge instead, and the
        // two readings are different substances. Guessing would be wrong half the time, so neither is assumed.
        const body = this.text.slice(0, start);
        const lastDigit = body.slice(-1);
        const readings = [`"${body}^${rest}" (charge 1${rest})`];
        if (lastDigit !== '0') readings.push(`"${body.slice(0, -1)}^${lastDigit}${rest}" (charge ${lastDigit}${rest})`);
        this.fail(`Ambiguous charge: write ${readings.join(' or ')}`, start);
      }
      return rest[0] === '+' ? rest.length : -rest.length;
    }
    return this.fail(`Unexpected "${rest[0]}"`, start);
  }

  read(): ParsedFormula {
    if (this.text === '') this.fail('The formula is empty');
    // The electron of a half-reaction.
    if (/^e(-|\^-|\^1-|\^-1)$/.test(this.text)) return { elements: {}, charge: -1 };
    if (this.text[0] === 'e' && !isLower(this.text[1])) this.fail('An electron is written "e-"');

    const atoms = new Map<string, number>();
    for (let part = 0; ; part++) {
      this.skipSpaces();
      let multiplier = 1;
      const numberAt = this.pos;
      const leading = this.readInteger();
      if (leading !== undefined) {
        if (part === 0) this.fail('A formula cannot start with a number; a coefficient belongs to the equation', numberAt);
        multiplier = leading;
        this.skipSpaces();
      }
      FormulaReader.merge(atoms, this.readUnits(undefined), multiplier);
      const beforeSpaces = this.pos;
      this.skipSpaces();
      if (this.text[this.pos] === '.') {
        this.pos++;
        continue;
      }
      // Spaces are only allowed around the dot of a hydrate.
      if (this.pos !== beforeSpaces) this.fail('Unexpected space', beforeSpaces);
      break;
    }
    const charge = this.readCharge();
    return { elements: Object.fromEntries(atoms), charge };
  }
}

/**
 * Reads a chemical formula.
 *
 * Supported: element symbols with counts ("C6H12O6"); nested round, square and curly brackets
 * ("Ca3(PO4)2", "K4[Fe(CN)6]"); hydrates and adducts with ".", "*" or a middle dot and an optional
 * whole-number multiplier ("CuSO4.5H2O", "CuSO4·5H2O"); charges written "NH4+", "Cl-", "SO4^2-", "Fe^3+",
 * "SO4-2", "Ca++" or with Unicode superscripts; Unicode subscripts; and the electron "e-".
 *
 * Not supported: isotope labels (D, T, 13C), non-integer subscripts, structural notation ("CH2=CH2"),
 * names, and phase labels (those belong to `parseEquation`).
 *
 * A charge magnitude must follow "^" (or use the "+2" form). "Fe3+" is refused as ambiguous rather than
 * guessed at: write "Fe^3+" for the iron(III) ion.
 *
 * @throws ChemicalSyntaxError saying what is wrong.
 */
export function parseFormula(text: string): ParsedFormula {
  if (typeof text !== 'string') throw new TypeError('parseFormula expects a string.');
  const normalized = normalizeFormulaText(text.trim());
  const phase = /\(\s*(?:g|l|s|aq|cr)\s*\)$/.exec(normalized);
  if (phase) {
    throw new ChemicalSyntaxError(
      `"${phase[0]}" is a phase label, not part of the formula; phase labels are read by parseEquation (in "${normalized}")`,
      normalized,
      phase.index,
    );
  }
  const parsed = new FormulaReader(normalized).read();
  return Object.freeze({ elements: Object.freeze({ ...parsed.elements }), charge: parsed.charge });
}

function asParsed(formula: ParsedFormula | string): ParsedFormula {
  return typeof formula === 'string' ? parseFormula(formula) : formula;
}

/**
 * Molar mass in g/mol from the standard atomic weights in `@matterlab/core`.
 *
 * For an ion the mass of the electrons removed or added is taken into account (5.486e-4 g/mol each), so
 * that mass is conserved across a half-reaction that includes "e-"; the electron itself has that molar mass.
 */
export function molarMass(formula: ParsedFormula | string): number {
  const parsed = asParsed(formula);
  let mass = 0;
  for (const [symbol, count] of Object.entries(parsed.elements)) {
    const weight = ATOMIC_WEIGHT.get(symbol);
    if (weight === undefined) throw new RangeError(`Unknown element symbol "${symbol}".`);
    mass += count * weight;
  }
  return mass - parsed.charge * ELECTRON_MASS_U;
}

function chargeSuffix(charge: number): string {
  if (charge === 0) return '';
  const sign = charge > 0 ? '+' : '-';
  const magnitude = Math.abs(charge);
  return magnitude === 1 ? sign : `^${magnitude}${sign}`;
}

/**
 * The formula in Hill order (carbon, then hydrogen, then alphabetical; purely alphabetical when there is
 * no carbon) with the charge appended: ethanol -> "C2H6O", sulfate -> "O4S^2-", the electron -> "e-".
 * Two formulas have the same composition and charge exactly when their Hill formulas are equal; the Hill
 * formula says nothing about structure, so isomers share one.
 */
export function hillFormula(formula: ParsedFormula | string): string {
  const parsed = asParsed(formula);
  const symbols = Object.keys(parsed.elements).filter((s) => parsed.elements[s] !== 0);
  if (symbols.length === 0) return `e${chargeSuffix(parsed.charge)}`;
  const hasCarbon = symbols.includes('C');
  const rank = (s: string): number => (!hasCarbon ? 2 : s === 'C' ? 0 : s === 'H' ? 1 : 2);
  symbols.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  return symbols.map((s) => (parsed.elements[s] === 1 ? s : `${s}${parsed.elements[s]}`)).join('') + chargeSuffix(parsed.charge);
}
