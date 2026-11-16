import type { Citation, Provenance, Quantity } from '@matterlab/core';
import type { SourceCitationRecord, ThermoRecord, ThermoSourceId, ThermoValueRecord } from '../data/records';
import { THERMO_CITATIONS, THERMO_PAGES, THERMO_RECORDS, THERMO_SKIPPED_ROWS, THERMO_SOURCE_RECORDS } from '../data/thermo.generated';
import type { Phase } from '../equation';
import { hillFormula, parseFormula } from '../formula';
import type { ParsedFormula } from '../formula';

export const ENTHALPY_UNIT = 'kJ/mol';
export const ENTROPY_UNIT = 'J/(mol K)';

export interface ThermoSpecies {
  /** Unique identifier: the formula followed by the phase, e.g. "H2O(l)" or "SO4^2-(aq)". */
  readonly id: string;
  readonly name: string;
  /** Formula in the notation `parseFormula` reads. */
  readonly formula: string;
  readonly phase: Phase;
  /** Qualifier the source attaches to the state: "graphite", "white", "undissociated", ... */
  readonly stateDetail?: string;
  /**
   * Standard enthalpy of formation at 298.15 K in kJ/mol, or `null` when the source lists none.
   * `uncertainty` is the uncertainty limit printed by the source (see `THERMO_DATA_SOURCES`), `0` for
   * values that are zero by definition, and absent when the source prints none.
   */
  readonly deltaHf298: Quantity | null;
  /** Standard molar entropy at 298.15 K in J/(mol K), or `null` when the source lists none for a 1 bar standard state. */
  readonly s298: Quantity | null;
  readonly provenance: Provenance;
  /** Which reference table the values come from. */
  readonly source: ThermoSourceId;
  /** Composition and charge, as `parseFormula(formula)` returns them. */
  readonly parsed: ParsedFormula;
  /** Set when the composition does not identify the compound (isomers); shown as a warning when the species is used. */
  readonly identityNote?: string;
}

export interface ThermoDataSource {
  readonly id: ThermoSourceId;
  readonly name: string;
  readonly url: string;
  /** ISO date on which the source was retrieved. */
  readonly retrieved: string;
  readonly version?: string;
  /** Rights statement quoted from the source, when it prints one. */
  readonly license?: string;
  /** The citation the source asks for. */
  readonly citation: Citation;
  /** Sentences quoted from the source that fix its conventions. */
  readonly statements: readonly string[];
  /** How this package reads the source: standard states, ion convention, meaning of the uncertainties. */
  readonly conventions: readonly string[];
  readonly speciesCount: number;
}

function toCitation(record: SourceCitationRecord): Citation {
  return {
    ...(record.authors ? { authors: record.authors } : {}),
    title: record.title,
    ...(record.source ? { source: record.source } : {}),
    ...(record.year !== undefined ? { year: record.year } : {}),
    ...(record.doi ? { doi: record.doi } : {}),
    ...(record.url ? { url: record.url } : {}),
  };
}

function citationsFor(keys: readonly string[]): Citation[] {
  return keys.map((key) => {
    const record = THERMO_CITATIONS[key];
    if (!record) throw new Error(`Generated thermodynamic data refer to an unknown citation "${key}".`);
    return toCitation(record);
  });
}

const SOURCE_BY_ID = new Map(THERMO_SOURCE_RECORDS.map((s) => [s.id, s]));

/** The CODATA page prints its title in capitals; the title of the work it cites is used as the display name. */
const SOURCE_NAME: Readonly<Record<ThermoSourceId, (printed: string) => string>> = {
  'codata-key-values': () => 'CODATA Key Values for Thermodynamics',
  'nist-webbook': (printed) => printed,
};

const CONVENTIONS: Readonly<Record<ThermoSourceId, readonly string[]>> = {
  'codata-key-values': [
    'Standard enthalpies of formation and standard entropies at 298.15 K for a standard-state pressure of 1 bar, as the page states.',
    'A printed enthalpy of formation of 0 marks the reference state of an element; it is exact by definition and carries an uncertainty of 0 here.',
    'Aqueous ions follow the hydrogen-ion convention: the table lists H+(aq) with an enthalpy of formation of 0 and an entropy of 0, and every other ionic value is relative to that. ' +
      'Single-ion values are therefore conventional (ionic entropies can be negative) and only charge-balanced combinations are physically meaningful.',
    'The page does not restate the standard state of solutes; the usual convention for such tables (a hypothetical ideal solution of unit molality) is assumed. ' +
      'Entries marked "undissoc." refer to the undissociated solute.',
    'Uncertainties are the "stated uncertainty limits" of the page, which says there is "a high probability that the true values fall within" them and gives no coverage factor. ' +
      'They are stored unchanged in the uncertainty field; read as standard uncertainties they err on the wide side.',
  ],
  'nist-webbook': [
    'Standard enthalpies of formation and standard entropies at 298.15 K. Gas entropies are taken only from rows labelled "S°gas,1 bar", so that they refer to the same 1 bar standard state as the CODATA table.',
    'Where the WebBook lists several values for one quantity, the first-listed row is used (reviews first, then individual determinations, newest first); the method, reference and comment of that row are kept with the value.',
    'Only the phases selected for this package are included; other phases the WebBook tabulates for the same substance (for example the hypothetical liquid of a salt at 298 K) are not.',
    'An uncertainty is given only where the WebBook prints one; its meaning is that of the cited reference. Values without one have no uncertainty field.',
    'No aqueous species are taken from the WebBook.',
  ],
};

function valueNotes(label: string, record: ThermoValueRecord): string {
  const parts = [`${label} as printed: "${record.asPrinted}"`];
  if (record.exact) parts.push('zero by definition (reference state or hydrogen-ion convention)');
  if (record.label) parts.push(`row "${record.label}"`);
  if (record.method && record.method !== 'N/A') parts.push(`method ${record.method}`);
  if (record.reference && record.reference !== 'N/A') parts.push(`reference ${record.reference}`);
  if (record.comment) parts.push(`comment "${record.comment}"`);
  if (record.individualPoints) {
    parts.push(`averaged by the source from ${record.individualPoints.map((p) => `${p.asPrinted} (${p.reference})`).join(', ')}`);
  }
  return parts.join('; ');
}

function buildSpecies(record: ThermoRecord): ThermoSpecies {
  const source = SOURCE_BY_ID.get(record.source);
  const page = THERMO_PAGES[record.page];
  if (!source || !page) throw new Error(`Generated thermodynamic data for ${record.id} refer to an unknown source or page.`);
  const sourceName = SOURCE_NAME[source.id](source.name);
  const snapshotNote = `Source row "${record.printedAs}"; snapshot packages/reactions/data/sources/${page.snapshot} (SHA-256 of the page as retrieved: ${page.sha256})`;

  const provenance = (citationKeys: readonly string[], notes: string): Provenance => ({
    source: sourceName,
    ...(source.version ? { version: source.version } : {}),
    citations: citationsFor(citationKeys),
    url: page.url,
    retrieved: page.retrieved,
    ...(source.license ? { license: source.license } : {}),
    notes,
  });

  const quantity = (value: ThermoValueRecord | null, unit: string, label: string): Quantity | null => {
    if (!value) return null;
    const pointsPage = value.individualPointsPage ? THERMO_PAGES[value.individualPointsPage] : undefined;
    const pointsNote = pointsPage
      ? ` Individual determinations from ${pointsPage.url}; snapshot packages/reactions/data/sources/${pointsPage.snapshot}.`
      : '';
    return {
      value: value.value,
      unit,
      ...(value.exact ? { uncertainty: 0 } : value.uncertainty !== undefined ? { uncertainty: value.uncertainty } : {}),
      evidence: 'reference',
      provenance: provenance(value.citationKeys, `${valueNotes(label, value)}. ${snapshotNote}.${pointsNote}`),
    };
  };

  const keys = [...new Set([...(record.deltaHf298?.citationKeys ?? []), ...(record.s298?.citationKeys ?? [])])];
  const notes = [
    record.deltaHf298 ? valueNotes('Enthalpy of formation', record.deltaHf298) : 'No enthalpy of formation listed',
    record.s298 ? valueNotes('Entropy', record.s298) : 'No entropy listed for a 1 bar standard state',
    snapshotNote,
  ];
  return {
    id: record.id,
    name: record.name,
    formula: record.formula,
    phase: record.phase,
    ...(record.stateDetail ? { stateDetail: record.stateDetail } : {}),
    deltaHf298: quantity(record.deltaHf298, ENTHALPY_UNIT, 'Enthalpy of formation'),
    s298: quantity(record.s298, ENTROPY_UNIT, 'Entropy'),
    provenance: provenance(keys, `${notes.join('. ')}.`),
    source: record.source,
    parsed: parseFormula(record.formula),
    ...(record.identityNote ? { identityNote: record.identityNote } : {}),
  };
}

/**
 * Reference thermodynamic data at 298.15 K. Every value was read by script from a saved copy of its
 * source; nothing is typed in by hand. See `THERMO_DATA_SOURCES` and the README for sources and conventions.
 */
export const THERMO_SPECIES: readonly ThermoSpecies[] = THERMO_RECORDS.map(buildSpecies);

export const THERMO_DATA_SOURCES: readonly ThermoDataSource[] = THERMO_SOURCE_RECORDS.map((s) => ({
  id: s.id,
  name: SOURCE_NAME[s.id](s.name),
  url: s.url,
  retrieved: s.retrieved,
  ...(s.version ? { version: s.version } : {}),
  ...(s.license ? { license: s.license } : {}),
  citation: citationsFor([s.citationKey])[0]!,
  statements: s.statements,
  conventions: CONVENTIONS[s.id],
  speciesCount: THERMO_RECORDS.filter((r) => r.source === s.id).length,
}));

/** Rows of the source tables that are deliberately not in `THERMO_SPECIES`, with the reason. */
export const THERMO_OMITTED_ROWS: readonly { readonly printedAs: string; readonly reason: string }[] = THERMO_SKIPPED_ROWS;

const BY_COMPOSITION = new Map<string, ThermoSpecies[]>();
for (const species of THERMO_SPECIES) {
  const key = hillFormula(species.parsed);
  const list = BY_COMPOSITION.get(key);
  if (list) list.push(species);
  else BY_COMPOSITION.set(key, [species]);
}

export interface ThermoLookup {
  /**
   * - `found`: exactly one entry matches.
   * - `phase-required`: no phase was given and the substance is tabulated in several phases.
   * - `phase-not-tabulated`: the substance is tabulated, but not in the requested phase.
   * - `not-tabulated`: nothing with this composition and charge is in the table.
   */
  readonly status: 'found' | 'phase-required' | 'phase-not-tabulated' | 'not-tabulated';
  readonly species?: ThermoSpecies;
  /** True when no phase was given and the only tabulated phase was used. */
  readonly phaseAssumed: boolean;
  /** Phases in which the substance is tabulated. */
  readonly availablePhases: readonly Phase[];
}

/**
 * Looks a substance up by composition, charge and phase. Spelling does not matter ("HO-" and "OH-" are the
 * same entry), but neither does structure: an isomer of a tabulated compound would match it, which is why
 * entries with isomers carry an `identityNote`.
 */
export function lookupThermoSpecies(formula: string | ParsedFormula, phase?: Phase): ThermoLookup {
  const parsed = typeof formula === 'string' ? parseFormula(formula) : formula;
  const candidates = BY_COMPOSITION.get(hillFormula(parsed)) ?? [];
  const availablePhases = candidates.map((c) => c.phase);
  if (candidates.length === 0) return { status: 'not-tabulated', phaseAssumed: false, availablePhases };
  if (phase === undefined) {
    if (candidates.length > 1) return { status: 'phase-required', phaseAssumed: false, availablePhases };
    return { status: 'found', species: candidates[0]!, phaseAssumed: true, availablePhases };
  }
  const match = candidates.find((c) => c.phase === phase);
  return match
    ? { status: 'found', species: match, phaseAssumed: false, availablePhases }
    : { status: 'phase-not-tabulated', phaseAssumed: false, availablePhases };
}

/**
 * The table entry for a substance, or `undefined` when there is none or when no phase is given and several
 * phases are tabulated (ask for one explicitly; `lookupThermoSpecies` reports which exist).
 *
 * @throws ChemicalSyntaxError when the formula cannot be parsed.
 */
export function findThermoSpecies(formula: string, phase?: Phase): ThermoSpecies | undefined {
  return lookupThermoSpecies(formula, phase).species;
}
