import { describe, expect, it } from 'vitest';
import { STATUS_LABELS, STATUS_LADDER, STATUS_REQUIREMENTS, canAdvance, canStepBack, establishedStatus, evidenceProblem, identicalStructure, nextRung, reconciledStatus, statusMeaning, supportedStatus } from './ladder';
import type { CandidateFacts, CandidateStatus, CatalogueKey, CatalogueSearch, Evidence } from './ladder';

let counter = 0;

function search(catalogue: CatalogueKey, outcome: CatalogueSearch['outcome'], at: string, method: CatalogueSearch['method'] = 'exact-inchikey'): CatalogueSearch {
  return {
    id: `s${++counter}`,
    catalogue,
    catalogueTitle: catalogue === 'pubchem' ? 'PubChem Compound' : 'MATTER LAB built-in library',
    method,
    searchedAt: at,
    recordsSearched: catalogue === 'pubchem' ? null : 70,
    outcome,
    matches: outcome === 'match' ? [{ id: 'CID 2244', name: 'Aspirin' }] : [],
    detail: '',
  };
}

function evidence(kind: Evidence['kind'], extra: Partial<Evidence> = {}): Evidence {
  return { id: `e${++counter}`, kind, summary: 'x', recordedBy: kind === 'calculation' ? 'matterlab' : 'user', createdAt: '2026-01-01T00:00:00Z', ...extra };
}

function facts(status: CandidateStatus, searches: CatalogueSearch[] = [], trail: Evidence[] = [], structureValid = true): CandidateFacts {
  return { status, structureValid, searches, evidence: trail };
}

const NO_MATCH = [search('matterlab-library', 'no-match', '2026-01-01T10:00:00Z')];

describe('what validation and the searches establish', () => {
  it('leaves a structure RDKit rejects at the first rung, whatever was searched', () => {
    expect(establishedStatus({ structureValid: false, searches: NO_MATCH })).toBe('user-created');
  });

  it('needs a completed search for the identical structure before saying that none was found', () => {
    expect(establishedStatus({ structureValid: true, searches: [] })).toBe('structurally-validated');
    // A similarity search asks a different question, and a failed search answers none.
    expect(establishedStatus({ structureValid: true, searches: [search('matterlab-library', 'no-match', '2026-01-01T10:00:00Z', 'similarity')] })).toBe('structurally-validated');
    expect(establishedStatus({ structureValid: true, searches: [search('pubchem', 'error', '2026-01-01T10:00:00Z')] })).toBe('structurally-validated');
    expect(establishedStatus({ structureValid: true, searches: NO_MATCH })).toBe('no-match-in-searched-catalogues');
  });

  it('does not let one catalogue without the structure outweigh another that has it', () => {
    const searches = [...NO_MATCH, search('pubchem', 'match', '2026-01-01T10:00:05Z')];
    expect(establishedStatus({ structureValid: true, searches })).toBe('structurally-validated');
    expect(identicalStructure(searches)?.match.name).toBe('Aspirin');
  });

  it('goes by the latest completed search of each catalogue', () => {
    const later = [search('pubchem', 'no-match', '2026-01-01T10:00:00Z'), search('pubchem', 'match', '2026-03-01T10:00:00Z')];
    expect(establishedStatus({ structureValid: true, searches: later })).toBe('structurally-validated');
    // A later failure does not erase what an earlier completed search found.
    const failedLater = [search('pubchem', 'match', '2026-01-01T10:00:00Z'), search('pubchem', 'error', '2026-03-01T10:00:00Z')];
    expect(establishedStatus({ structureValid: true, searches: failedLater })).toBe('structurally-validated');
  });
});

describe('climbing the ladder', () => {
  it('has six rungs in the stated order, each with a label and a requirement', () => {
    expect(STATUS_LADDER).toEqual(['user-created', 'structurally-validated', 'no-match-in-searched-catalogues', 'computationally-plausible', 'experimentally-observed', 'independently-validated']);
    for (const status of STATUS_LADDER) {
      expect(STATUS_LABELS[status].length).toBeGreaterThan(0);
      expect(STATUS_REQUIREMENTS[status].length).toBeGreaterThan(0);
    }
    expect(nextRung('independently-validated')).toBeNull();
  });

  it('never lets the user claim the rungs that validation and searching set', () => {
    expect(canAdvance(facts('user-created', [], [], false)).allowed).toBe(false);
    const validated = canAdvance(facts('structurally-validated'));
    expect(validated.allowed).toBe(false);
    expect(validated.allowed === false && validated.missing).toMatch(/search/i);
  });

  it('asks for a converged calculation before "computationally plausible"', () => {
    const without = canAdvance(facts('no-match-in-searched-catalogues', NO_MATCH));
    expect(without.allowed).toBe(false);
    expect(without.allowed === false && without.missing).toMatch(/converged/);
    const notConverged = [evidence('calculation', { converged: false })];
    expect(canAdvance(facts('no-match-in-searched-catalogues', NO_MATCH, notConverged)).allowed).toBe(false);
    const converged = [evidence('calculation', { converged: true })];
    expect(canAdvance(facts('no-match-in-searched-catalogues', NO_MATCH, converged))).toEqual({ allowed: true, next: 'computationally-plausible' });
  });

  it('asks for an observation with a reference, then for a validation with a reference', () => {
    const calculation = evidence('calculation', { converged: true });
    const unreferenced = [calculation, evidence('experimental-observation', { reference: '  ' })];
    expect(canAdvance(facts('computationally-plausible', NO_MATCH, unreferenced)).allowed).toBe(false);
    const observed = [calculation, evidence('experimental-observation', { reference: 'doi:10.1000/example' })];
    expect(canAdvance(facts('computationally-plausible', NO_MATCH, observed))).toEqual({ allowed: true, next: 'experimentally-observed' });
    // The observation does not also count as an independent validation.
    expect(canAdvance(facts('experimentally-observed', NO_MATCH, observed)).allowed).toBe(false);
    const validated = [...observed, evidence('independent-validation', { reference: 'Lab book 7, p. 12' })];
    expect(canAdvance(facts('experimentally-observed', NO_MATCH, validated))).toEqual({ allowed: true, next: 'independently-validated' });
    expect(canAdvance(facts('independently-validated', NO_MATCH, validated)).allowed).toBe(false);
  });

  it('offers only the next rung, so none can be skipped', () => {
    const everything = [evidence('calculation', { converged: true }), evidence('experimental-observation', { reference: 'r' }), evidence('independent-validation', { reference: 'r' })];
    const check = canAdvance(facts('no-match-in-searched-catalogues', NO_MATCH, everything));
    expect(check).toEqual({ allowed: true, next: 'computationally-plausible' });
  });

  it('returns a candidate to "structurally validated" when a catalogue turns out to hold the structure', () => {
    const trail = [evidence('calculation', { converged: true })];
    expect(reconciledStatus(facts('computationally-plausible', NO_MATCH, trail))).toBe('computationally-plausible');
    const found = [...NO_MATCH, search('pubchem', 'match', '2026-02-01T10:00:00Z')];
    expect(reconciledStatus(facts('computationally-plausible', found, trail))).toBe('structurally-validated');
    expect(canAdvance(facts('structurally-validated', found, trail)).allowed).toBe(false);
  });

  it('lets only rungs the user climbed be given up', () => {
    expect(canStepBack(facts('computationally-plausible', NO_MATCH))).toBe(true);
    expect(canStepBack(facts('no-match-in-searched-catalogues', NO_MATCH))).toBe(false);
    expect(canStepBack(facts('structurally-validated'))).toBe(false);
  });
});

describe('what the statuses say', () => {
  // Words that would turn "we did not find it" into "it is new".
  const CLAIMS = /\b(novel|new compound|new molecule|unknown compound|undiscovered|unprecedented|first (ever|time)|discover(y|ed|ies))\b/i;

  it('never describes a candidate as new, in any status', () => {
    const texts: string[] = [...Object.values(STATUS_LABELS), ...Object.values(STATUS_REQUIREMENTS)];
    for (const status of STATUS_LADDER) {
      texts.push(statusMeaning({ status, structureValid: true, searches: NO_MATCH }));
      texts.push(statusMeaning({ status, structureValid: false, searches: [] }));
      const check = canAdvance(facts(status, NO_MATCH));
      if (!check.allowed) texts.push(check.missing);
    }
    for (const text of texts) expect(text, text).not.toMatch(CLAIMS);
  });

  it('says where it looked and that it looked nowhere else when nothing was found', () => {
    const text = statusMeaning({ status: 'no-match-in-searched-catalogues', structureValid: true, searches: NO_MATCH });
    expect(text).toContain('catalogues that were searched');
    expect(text).toContain('Other databases and the literature were not searched');
    expect(text).toContain('does not show that the compound has never been described');
  });

  it('names the record when the identical structure is catalogued', () => {
    const searches = [search('pubchem', 'match', '2026-01-01T10:00:00Z')];
    expect(statusMeaning({ status: 'structurally-validated', structureValid: true, searches })).toContain('Aspirin in PubChem Compound');
  });

  it('marks what the user asserted as unverified', () => {
    for (const status of ['experimentally-observed', 'independently-validated'] as const) {
      expect(statusMeaning({ status, structureValid: true, searches: NO_MATCH })).toContain('has not verified it');
    }
  });
});

describe('evidence entered by hand', () => {
  it('requires a reference for observations and validations, but not for a note', () => {
    expect(evidenceProblem('experimental-observation', 'Seen by NMR', '')).toMatch(/reference is required/);
    expect(evidenceProblem('independent-validation', 'Repeated elsewhere', ' ')).toMatch(/reference is required/);
    expect(evidenceProblem('experimental-observation', 'Seen by NMR', 'doi:10.1000/example')).toBeNull();
    expect(evidenceProblem('note', 'Colourless oil', '')).toBeNull();
  });

  it('requires a statement of what the evidence shows', () => {
    expect(evidenceProblem('note', '   ', '')).toMatch(/what the evidence shows/);
  });

  it('does not let a calculation or a search be typed in', () => {
    expect(evidenceProblem('calculation', 'It converged, honestly', 'me')).toMatch(/recorded by the application/);
    expect(evidenceProblem('catalogue-search', 'Nothing found', 'me')).toMatch(/recorded by the application/);
  });
});

describe('a status stated from outside, as in a report file', () => {
  const calculation = evidence('calculation', { converged: true });
  const observation = evidence('experimental-observation', { reference: 'doi:10.1000/example' });
  const validation = evidence('independent-validation', { reference: 'Lab B, notebook 7, p. 12' });

  it('is honoured exactly as far as the searches and the evidence carry it', () => {
    // Every rung has its evidence: the stated status stands.
    expect(supportedStatus(facts('independently-validated', NO_MATCH, [calculation, observation, validation]))).toBe('independently-validated');
    // The top rung is stated but nothing validates it; the observation carries the one below.
    expect(supportedStatus(facts('independently-validated', NO_MATCH, [calculation, observation]))).toBe('experimentally-observed');
    // An observation cannot stand in for the calculation the rung below it asks for: the ladder is climbed in order.
    expect(supportedStatus(facts('independently-validated', NO_MATCH, [observation, validation]))).toBe('no-match-in-searched-catalogues');
    // A calculation that did not converge and an observation without a reference carry nothing.
    expect(supportedStatus(facts('experimentally-observed', NO_MATCH, [evidence('calculation', { converged: false }), observation]))).toBe('no-match-in-searched-catalogues');
    expect(supportedStatus(facts('experimentally-observed', NO_MATCH, [calculation, evidence('experimental-observation')]))).toBe('computationally-plausible');
  });

  it('never rises above what was stated, whatever evidence is present', () => {
    expect(supportedStatus(facts('no-match-in-searched-catalogues', NO_MATCH, [calculation, observation, validation]))).toBe('no-match-in-searched-catalogues');
    expect(supportedStatus(facts('computationally-plausible', NO_MATCH, [calculation, observation, validation]))).toBe('computationally-plausible');
  });

  it('is set by the searches and the validation where they decide, however much is claimed', () => {
    const everything = [calculation, observation, validation];
    // A catalogue holds the identical structure.
    expect(supportedStatus(facts('independently-validated', [...NO_MATCH, search('pubchem', 'match', '2026-01-01T10:00:05Z')], everything))).toBe('structurally-validated');
    // No completed search for the identical structure.
    expect(supportedStatus(facts('independently-validated', [], everything))).toBe('structurally-validated');
    expect(supportedStatus(facts('independently-validated', [search('pubchem', 'error', '2026-01-01T10:00:00Z')], everything))).toBe('structurally-validated');
    // A structure RDKit rejects.
    expect(supportedStatus(facts('independently-validated', NO_MATCH, everything, false))).toBe('user-created');
    // And the rungs the application sets itself cannot be understated either.
    expect(supportedStatus(facts('user-created', NO_MATCH, []))).toBe('no-match-in-searched-catalogues');
  });
});
