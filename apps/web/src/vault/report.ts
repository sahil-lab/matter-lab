import { SceneFormatError, deserializeScene } from '@matterlab/core';
import type { SerializedScene } from '@matterlab/core';
import { STATUS_LABELS, STATUS_LADDER, STATUS_REQUIREMENTS, statusMeaning } from './ladder';
import type { CandidateStatus, CatalogueSearch, Evidence, EvidenceKind } from './ladder';
import type { Candidate } from './store';

/**
 * A candidate as a report: the readable form (Markdown) and the reading of the machine-readable
 * form (`.candidate.json`). Pure functions; storage and the interface are elsewhere.
 */

export const CANDIDATE_FORMAT = 'matterlab.candidate';
export const CANDIDATE_FORMAT_VERSION = 1;

/** The sentence every report carries, in whichever form. */
export const REPORT_NOTICE =
  'A candidate for investigation. Nothing in this report states or implies that the compound is new: a search that finds no match says only which catalogues were searched and when.';

const EVIDENCE_LABELS: Readonly<Record<EvidenceKind, string>> = {
  note: 'Note',
  'structure-validation': 'Structure validation',
  'catalogue-search': 'Catalogue search',
  calculation: 'Calculation',
  'experimental-observation': 'Experimental observation',
  'independent-validation': 'Independent validation',
  'status-change': 'Status',
};

/** "2026-11-15 10:42 UTC" from an ISO 8601 time. */
function utc(iso: string): string {
  const time = new Date(iso);
  return Number.isNaN(time.getTime()) ? iso : `${time.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** Text that is safe inside a table cell or a list item: one line, no cell separators. */
const cell = (text: string): string => text.replace(/\s*\r?\n\s*/g, ' ').replace(/\|/g, '\\|');
const code = (text: string | null): string => (text ? `\`${text.replace(/`/g, "'")}\`` : 'none');

function searchOutcome(search: CatalogueSearch): string {
  if (search.outcome === 'error') return 'did not complete; says nothing either way';
  if (search.method === 'exact-inchikey') return search.outcome === 'match' ? 'identical structure on record' : 'no record with this InChIKey';
  return search.outcome === 'match' ? `${search.matches.length} similar structure${search.matches.length === 1 ? '' : 's'} listed` : 'none above the threshold';
}

function searchFound(search: CatalogueSearch): string {
  if (search.matches.length === 0) return '';
  return search.matches.map((match) => `${match.name} (${match.id}${match.similarity !== undefined ? `, similarity ${match.similarity.toFixed(2)}` : ''})`).join('; ');
}

/** The candidate as a report a person can read, in Markdown. */
export function candidateMarkdown(candidate: Candidate, exportedAt: string): string {
  const rung = STATUS_LADDER.indexOf(candidate.status);
  const lines: string[] = [];
  lines.push(`# Candidate report: ${cell(candidate.title)}`, '', `> ${REPORT_NOTICE}`, '');
  lines.push('| | |', '| --- | --- |');
  lines.push(`| Identifier | ${code(candidate.id)} |`);
  lines.push(`| Recorded | ${utc(candidate.createdAt)} |`);
  lines.push(`| Last changed | ${utc(candidate.updatedAt)} |`);
  lines.push(`| Status | **${STATUS_LABELS[candidate.status]}** (rung ${rung + 1} of ${STATUS_LADDER.length}) |`, '');
  lines.push(statusMeaning(candidate), '');

  lines.push('## Structure', '', '| | |', '| --- | --- |');
  lines.push(`| Formula | ${cell(candidate.formula)} |`);
  lines.push(`| Atoms | ${candidate.atomCount} |`);
  lines.push(`| SMILES | ${code(candidate.smiles)} |`);
  lines.push(`| InChI | ${code(candidate.inchi)} |`);
  lines.push(`| InChIKey | ${code(candidate.inchiKey)} |`, '');
  const { validation } = candidate;
  const rdkit = validation.rdkitVersion ? `RDKit ${validation.rdkitVersion}` : 'RDKit';
  lines.push(
    candidate.structureValid
      ? `${rdkit} accepts the structure as chemically well-formed. That is a statement about valence and bookkeeping; it does not say that the compound exists, is stable or can be made.`
      : `${rdkit} does not accept the structure${validation.rdkitErrors.length > 0 ? `: ${validation.rdkitErrors.map(cell).join(' ')}` : '.'} It therefore has no identifiers, and no catalogue could be searched for it.`,
  );
  if (validation.ruleErrors + validation.ruleWarnings > 0) {
    lines.push('', `MATTER LAB’s own rule-based check reports ${validation.ruleErrors} error${validation.ruleErrors === 1 ? '' : 's'} and ${validation.ruleWarnings} warning${validation.ruleWarnings === 1 ? '' : 's'}:`, '');
    for (const message of validation.ruleMessages) lines.push(`- ${cell(message)}`);
  }
  lines.push('', 'The structure of a candidate is recorded once and never edited. Its coordinates are in the machine-readable form of this report.', '');

  lines.push('## Status ladder', '');
  STATUS_LADDER.forEach((status, i) => {
    const mark = i < rung ? 'reached' : i === rung ? '**current**' : 'not reached';
    lines.push(`${i + 1}. ${STATUS_LABELS[status]} (${mark}). ${STATUS_REQUIREMENTS[status]}`);
  });
  lines.push('', 'The first three rungs are set by the application from validation and from the catalogue searches. The upper three are requested by the user, one at a time, and each needs its own evidence in the trail below. Observations and validations are recorded as the user states them; MATTER LAB has not verified them.', '');

  lines.push('## Catalogue searches', '');
  if (candidate.searches.length === 0) {
    lines.push('No catalogue has been searched for this structure.', '');
  } else {
    lines.push('| When | Catalogue | Asked for | Records searched | Outcome | Found |', '| --- | --- | --- | --- | --- | --- |');
    for (const search of [...candidate.searches].sort((a, b) => (a.searchedAt < b.searchedAt ? -1 : a.searchedAt > b.searchedAt ? 1 : 0))) {
      lines.push(
        `| ${utc(search.searchedAt)} | ${cell(search.catalogueTitle)} | ${search.method === 'exact-inchikey' ? 'the identical structure' : 'similar structures'} | ${search.recordsSearched ?? 'not reported'} | ${searchOutcome(search)} | ${cell(searchFound(search))} |`,
      );
    }
    lines.push('', 'Only searches for the identical structure count towards the status, and of each catalogue only the most recent one that completed. Other databases and the literature were not searched.', '');
  }

  lines.push('## Evidence trail', '', 'Entries are only ever added, never changed or removed.', '');
  candidate.evidence.forEach((entry, i) => {
    const who = entry.recordedBy === 'user' ? 'stated by the user, not verified' : 'recorded by MATTER LAB';
    const converged = entry.kind === 'calculation' && entry.converged !== undefined ? (entry.converged ? ', converged' : ', not converged') : '';
    lines.push(`${i + 1}. **${utc(entry.createdAt)} · ${EVIDENCE_LABELS[entry.kind]}${converged}** (${who}). ${cell(entry.summary)}${entry.reference ? ` Reference: ${cell(entry.reference)}.` : ''}`);
  });
  lines.push('', '---', '', `Exported from MATTER LAB on ${utc(exportedAt)}. The machine-readable form of this report (\`.candidate.json\`) holds the coordinates and every detail, and can be imported into a Discovery Vault again.`, '');
  return lines.join('\n');
}

// ---------- reading a report file ----------

/** What a report file states about a candidate. Nothing in it has been checked against anything yet. */
export interface StatedCandidate {
  readonly id: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly exportedAt: string | null;
  readonly status: CandidateStatus;
  readonly scene: SerializedScene;
  /** The InChIKey the file gives for the structure, to be compared with the one the structure really has. */
  readonly inchiKey: string | null;
  readonly searches: readonly CatalogueSearch[];
  readonly evidence: readonly Evidence[];
}

export type ReportReading = { readonly ok: true; readonly candidate: StatedCandidate } | { readonly ok: false; readonly problem: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isTime = (value: unknown): value is string => typeof value === 'string' && !Number.isNaN(new Date(value).getTime());
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVIDENCE_KINDS = Object.keys(EVIDENCE_LABELS) as EvidenceKind[];

function readSearch(value: unknown): CatalogueSearch | null {
  if (!isRecord(value)) return null;
  const { id, catalogue, catalogueTitle, method, searchedAt, recordsSearched, outcome, matches, detail } = value;
  if (!isText(id) || (catalogue !== 'matterlab-library' && catalogue !== 'pubchem') || !isText(catalogueTitle)) return null;
  if ((method !== 'exact-inchikey' && method !== 'similarity') || !isTime(searchedAt)) return null;
  if (recordsSearched !== null && !(typeof recordsSearched === 'number' && Number.isInteger(recordsSearched) && recordsSearched >= 0)) return null;
  if ((outcome !== 'match' && outcome !== 'no-match' && outcome !== 'error') || typeof detail !== 'string' || !Array.isArray(matches)) return null;
  const found = [];
  for (const match of matches) {
    if (!isRecord(match) || !isText(match.id) || !isText(match.name)) return null;
    if (match.formula !== undefined && typeof match.formula !== 'string') return null;
    if (match.url !== undefined && typeof match.url !== 'string') return null;
    if (match.similarity !== undefined && !(typeof match.similarity === 'number' && match.similarity >= 0 && match.similarity <= 1)) return null;
    found.push({
      id: match.id,
      name: match.name,
      ...(match.formula !== undefined ? { formula: match.formula } : {}),
      ...(match.url !== undefined ? { url: match.url } : {}),
      ...(match.similarity !== undefined ? { similarity: match.similarity } : {}),
    });
  }
  // A search that found something says "match", and one that found nothing does not.
  if ((outcome === 'match') !== (found.length > 0)) return null;
  return { id, catalogue, catalogueTitle, method, searchedAt, recordsSearched, outcome, matches: found, detail };
}

function readEvidence(value: unknown): Evidence | null {
  if (!isRecord(value)) return null;
  const { id, kind, summary, recordedBy, reference, createdAt, statusBefore, statusAfter, converged, details } = value;
  if (!isText(id) || !EVIDENCE_KINDS.includes(kind as EvidenceKind) || !isText(summary) || (recordedBy !== 'user' && recordedBy !== 'matterlab') || !isTime(createdAt)) return null;
  const isStatus = (status: unknown): status is CandidateStatus => STATUS_LADDER.includes(status as CandidateStatus);
  if (reference !== undefined && typeof reference !== 'string') return null;
  if ((statusBefore !== undefined && !isStatus(statusBefore)) || (statusAfter !== undefined && !isStatus(statusAfter))) return null;
  if (converged !== undefined && typeof converged !== 'boolean') return null;
  if (details !== undefined && !isRecord(details)) return null;
  return {
    id,
    kind: kind as EvidenceKind,
    summary,
    recordedBy,
    createdAt,
    ...(reference !== undefined ? { reference } : {}),
    ...(statusBefore !== undefined ? { statusBefore } : {}),
    ...(statusAfter !== undefined ? { statusAfter } : {}),
    ...(converged !== undefined ? { converged } : {}),
    ...(details !== undefined ? { details } : {}),
  };
}

/**
 * Reads the machine-readable form of a report. It checks that the file is what it claims to be and
 * that every entry is well-formed; it does not check that what the file states is true.
 */
export function readCandidateReport(json: unknown): ReportReading {
  const no = (problem: string): ReportReading => ({ ok: false, problem });
  if (!isRecord(json) || json.format !== CANDIDATE_FORMAT) return no('This is not a MATTER LAB candidate report.');
  if (json.version !== CANDIDATE_FORMAT_VERSION) return no(`This report is written in version ${String(json.version)} of the format; this application reads version ${CANDIDATE_FORMAT_VERSION}.`);
  const { id, title, createdAt, updatedAt, exportedAt, status, structure, catalogueSearches, evidence } = json;
  if (!isText(id) || !UUID.test(id)) return no('The report has no valid identifier.');
  if (!isText(title)) return no('The report has no title.');
  if (!isTime(createdAt) || !isTime(updatedAt)) return no('The report does not say when the candidate was recorded.');
  if (!STATUS_LADDER.includes(status as CandidateStatus)) return no('The report states a status this application does not know.');
  if (!isRecord(structure) || !isRecord(structure.scene)) return no('The report holds no structure.');
  try {
    if (deserializeScene(structure.scene as unknown as SerializedScene).atoms.size === 0) return no('The structure in the report has no atoms.');
  } catch (error) {
    if (error instanceof SceneFormatError) return no(`The structure in the report cannot be read: ${error.message}`);
    throw error;
  }
  if (structure.inchiKey !== null && typeof structure.inchiKey !== 'string') return no('The identifiers in the report cannot be read.');
  if (!Array.isArray(catalogueSearches) || !Array.isArray(evidence)) return no('The report holds no list of searches or no evidence trail.');
  const searches: CatalogueSearch[] = [];
  for (const [i, entry] of catalogueSearches.entries()) {
    const search = readSearch(entry);
    if (!search) return no(`Catalogue search ${i + 1} in the report is not well-formed.`);
    searches.push(search);
  }
  const trail: Evidence[] = [];
  for (const [i, entry] of evidence.entries()) {
    const item = readEvidence(entry);
    if (!item) return no(`Entry ${i + 1} of the evidence trail in the report is not well-formed.`);
    trail.push(item);
  }
  return {
    ok: true,
    candidate: {
      id: id.toLowerCase(),
      title,
      createdAt,
      updatedAt,
      exportedAt: isTime(exportedAt) ? exportedAt : null,
      status: status as CandidateStatus,
      scene: structure.scene as unknown as SerializedScene,
      inchiKey: structure.inchiKey,
      searches,
      evidence: trail,
    },
  };
}
