/**
 * Shapes of the generated reference-data files in this folder. The data files themselves are written by
 * the scripts in `packages/reactions/tools` from the source snapshots in `packages/reactions/data/sources`
 * and must not be edited by hand.
 */

/** A literature reference exactly as the source lists it. */
export interface SourceCitationRecord {
  readonly authors?: string;
  readonly title: string;
  readonly source?: string;
  readonly year?: number;
  readonly doi?: string;
  readonly url?: string;
  /** The complete reference as the source prints it, when it prints one. */
  readonly text?: string;
}

/** One retrieved page: where it is, when it was fetched, and where its snapshot or excerpt is kept. */
export interface SourcePageRecord {
  readonly url: string;
  /** ISO date of retrieval. */
  readonly retrieved: string;
  /** Snapshot or excerpt of the page, relative to `packages/reactions/data/sources`. */
  readonly snapshot: string;
  /** SHA-256 of the page as retrieved (of the complete page, also when only an excerpt is kept). */
  readonly sha256: string;
}

export type ThermoSourceId = 'codata-key-values' | 'nist-webbook';

export interface ThermoSourceRecord {
  readonly id: ThermoSourceId;
  /** Name of the dataset as the source gives it. */
  readonly name: string;
  readonly url: string;
  /** ISO date of the earliest retrieval among the pages used. */
  readonly retrieved: string;
  readonly version?: string;
  /** Rights statement quoted from the source, when it prints one. */
  readonly license?: string;
  /** How the source asks to be cited. */
  readonly citationKey: string;
  /** Sentences quoted from the source that fix conventions (standard state, reference states, uncertainties). */
  readonly statements: readonly string[];
}

export interface ThermoValueRecord {
  /** The number the source prints, in kJ/mol (enthalpy of formation) or J/(mol K) (entropy). */
  readonly value: number;
  /** The uncertainty the source prints next to the value; absent when it prints none. */
  readonly uncertainty?: number;
  /**
   * True when the source prints a bare 0: the enthalpy of formation of an element in its reference state,
   * or the conventional zero of H+(aq). Such values are exact by definition, not measurements.
   */
  readonly exact?: true;
  /** The value cell exactly as printed, e.g. "-74.6 ± 0.3". */
  readonly asPrinted: string;
  /** Quantity label as printed by the source, e.g. "ΔfH°gas". */
  readonly label?: string;
  readonly method?: string;
  /** Short reference label as printed, e.g. "Chase, 1998". */
  readonly reference?: string;
  readonly comment?: string;
  /** For values the source computed as an average: the individual determinations it lists. */
  readonly individualPoints?: readonly { readonly asPrinted: string; readonly method: string; readonly reference: string }[];
  /** Key into the page table of the page that lists those determinations. */
  readonly individualPointsPage?: string;
  /** Keys into the citation table: the original reference(s) first, then the database itself. */
  readonly citationKeys: readonly string[];
}

export interface ThermoRecord {
  readonly id: string;
  readonly name: string;
  /** Formula in the notation `parseFormula` reads. */
  readonly formula: string;
  readonly phase: 'g' | 'l' | 's' | 'aq';
  /** Qualifier the source attaches to the state, e.g. "graphite" or "undissociated". */
  readonly stateDetail?: string;
  readonly source: ThermoSourceId;
  /** Key into the page table: the page the values were read from. */
  readonly page: string;
  /** How the source identifies the substance. */
  readonly printedAs: string;
  readonly deltaHf298: ThermoValueRecord | null;
  readonly s298: ThermoValueRecord | null;
  /** Set when the composition alone does not identify the compound. */
  readonly identityNote?: string;
}

export type KineticSourceId = 'iupac-acp-2004-vol1' | 'iupac-acp-2006-vol2';

export interface KineticSourceRecord {
  readonly id: KineticSourceId;
  readonly citation: SourceCitationRecord;
  /** Article page. */
  readonly url: string;
  readonly pdfUrl: string;
  /** ISO date on which the PDF was retrieved. */
  readonly retrieved: string;
  readonly pdfSha256: string;
  /** Licence statement quoted from the article page. */
  readonly license: string;
  /** Excerpt file, relative to `packages/reactions/data/sources`. */
  readonly excerpt: string;
  readonly excerptSha256: string;
  /** Passages quoted from the article that define the rate-law and uncertainty conventions. */
  readonly statements: readonly { readonly label: string; readonly location: string; readonly text: string }[];
}

export interface KineticRecord {
  readonly id: string;
  readonly name: string;
  readonly reactionClass: string;
  /** The data-sheet reaction restated with formulas `parseEquation` reads. */
  readonly equation: string;
  readonly speciesNames: Readonly<Record<string, string>>;
  readonly source: KineticSourceId;
  /** Data-sheet identifier, e.g. "I.A3.54". */
  readonly dataSheet: string;
  /** Where the data sheet is in the article, e.g. "journal pages 1574-1575". */
  readonly location: string;
  readonly reactionAsPrinted: string;
  /** The preferred temperature-dependent expression exactly as extracted from the PDF. */
  readonly expressionAsPrinted: string;
  /** Pre-exponential factor of k = A exp(-(E/R)/T), in `AUnits`. */
  readonly A: number;
  readonly AUnits: 's-1' | 'cm3 molecule-1 s-1' | 'cm6 molecule-2 s-1';
  /** E/R in kelvin; negative when the rate coefficient falls with rising temperature. */
  readonly EOverRK: number;
  /** Temperature range over which the data sheet recommends the expression, in kelvin. */
  readonly temperatureRangeK: readonly [number, number];
  /** Overall reaction order implied by the units of k. */
  readonly overallOrder: 1 | 2 | 3;
  /** Preferred rate coefficient at 298 K as printed on the data sheet, in `AUnits`. */
  readonly k298: number;
  readonly k298AsPrinted: string;
  /** Reliability of log10 k at 298 K (expanded uncertainty, about 95 % confidence). */
  readonly deltaLog10K298: number;
  /** Reliability of E/R in kelvin (expanded uncertainty, about 95 % confidence). */
  readonly deltaEOverRK: number;
  /** Total pressure the expression is restricted to, when the data sheet states one. */
  readonly pressure?: string;
  /** Standard reaction enthalpy at 298 K printed on the data sheet, in kJ/mol. */
  readonly reactionEnthalpyKJPerMol?: number;
  readonly extraNotes?: string;
}
