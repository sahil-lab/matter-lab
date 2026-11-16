import { EMPTY_SCENE, editScene, serializeScene } from '@matterlab/core';
import { describe, expect, it } from 'vitest';
import type { CatalogueSearch, Evidence } from './ladder';
import { CANDIDATE_FORMAT, REPORT_NOTICE, candidateMarkdown, readCandidateReport } from './report';
import type { Candidate } from './store';

/** Words that would turn "it was not found where we looked" into "it is new". */
const CLAIMS = /\b(novel|new compound|new molecule|unknown compound|undiscovered|unprecedented|first (ever|time)|you (have )?discovered|is a discovery|congratulations)\b/i;

const scene = serializeScene(
  editScene(EMPTY_SCENE, 'fluoromethane', (e) => {
    const c = e.addAtom({ protons: 6, position: [0, 0, 0] });
    e.addBond(c, e.addAtom({ protons: 9, position: [1.38, 0, 0] }), 1);
    for (const position of [[-0.36, 1.03, 0], [-0.36, -0.51, 0.89], [-0.36, -0.51, -0.89]] as const) e.addBond(c, e.addAtom({ protons: 1, position }), 1);
  }).scene,
);

const SEARCHES: CatalogueSearch[] = [
  { id: 's1', catalogue: 'matterlab-library', catalogueTitle: 'MATTER LAB built-in library', method: 'exact-inchikey', searchedAt: '2026-03-02T09:15:00.000Z', recordsSearched: 63, outcome: 'no-match', matches: [], detail: 'Equality of the standard InChIKey.' },
  {
    id: 's2',
    catalogue: 'matterlab-library',
    catalogueTitle: 'MATTER LAB built-in library',
    method: 'similarity',
    searchedAt: '2026-03-02T09:15:01.000Z',
    recordsSearched: 63,
    outcome: 'match',
    matches: [{ id: 'pubchem:887', name: 'Methanol', similarity: 0.2 }],
    detail: 'Tanimoto similarity.',
  },
  { id: 's3', catalogue: 'pubchem', catalogueTitle: 'PubChem Compound', method: 'exact-inchikey', searchedAt: '2026-03-02T09:15:03.000Z', recordsSearched: null, outcome: 'error', matches: [], detail: 'PubChem could not be reached.' },
];

const EVIDENCE: Evidence[] = [
  { id: 'e1', kind: 'note', summary: 'Candidate recorded from the structure in the Architect.', recordedBy: 'user', createdAt: '2026-03-02T09:14:58.000Z', statusAfter: 'user-created' },
  { id: 'e2', kind: 'structure-validation', summary: 'RDKit 2026.09.2 accepts the structure: CF (CH3F).', recordedBy: 'matterlab', createdAt: '2026-03-02T09:14:59.000Z' },
  { id: 'e3', kind: 'calculation', summary: 'Hartree–Fock (RHF/STO-3G) converged in 9 iterations.', recordedBy: 'matterlab', createdAt: '2026-03-02T09:20:00.000Z', converged: true, details: { energyHartree: -137.169 } },
  { id: 'e4', kind: 'experimental-observation', summary: 'Seen by 19F NMR | one signal\nat −271 ppm', recordedBy: 'user', reference: 'doi:10.1000/example', createdAt: '2026-03-03T11:00:00.000Z' },
];

const candidate: Candidate = {
  id: '3f2b6c1e-9a4d-4f7b-8c21-5d6e7f809a1b',
  title: 'Trial | one',
  createdAt: '2026-03-02T09:14:58.000Z',
  updatedAt: '2026-03-03T11:00:00.000Z',
  status: 'computationally-plausible',
  structureValid: true,
  scene,
  formula: 'CH3F',
  atomCount: 5,
  smiles: 'CF',
  inchi: 'InChI=1S/CH3F/c1-2/h1H3',
  inchiKey: 'NBVXSUQYWXRMNV-UHFFFAOYSA-N',
  validation: { rdkitVersion: '2026.09.2', rdkitErrors: [], ruleMessages: [], ruleErrors: 0, ruleWarnings: 0 },
  searches: SEARCHES,
  evidence: EVIDENCE,
};

/** The machine-readable report as the application writes it, reduced to what a reader needs. */
const file = (change: Record<string, unknown> = {}): Record<string, unknown> => ({
  format: CANDIDATE_FORMAT,
  version: 1,
  exportedAt: '2026-03-04T08:00:00.000Z',
  id: candidate.id,
  title: candidate.title,
  createdAt: candidate.createdAt,
  updatedAt: candidate.updatedAt,
  status: candidate.status,
  structure: { formula: 'CH3F', atoms: 5, smiles: 'CF', inchiKey: candidate.inchiKey, scene },
  catalogueSearches: SEARCHES,
  evidence: EVIDENCE,
  ...change,
});

describe('the readable report', () => {
  const text = candidateMarkdown(candidate, '2026-03-04T08:00:00.000Z');

  it('opens with what a candidate is and never claims that the compound is new', () => {
    expect(text.split('\n').slice(0, 3)).toEqual(['# Candidate report: Trial \\| one', '', `> ${REPORT_NOTICE}`]);
    expect(text).not.toMatch(CLAIMS);
    expect(text).toContain('Other databases and the literature were not searched.');
    expect(text).toContain('A calculation is the result of a model, not an observation');
  });

  it('states the identity, the status and where it stands on the ladder', () => {
    expect(text).toContain('| Identifier | `3f2b6c1e-9a4d-4f7b-8c21-5d6e7f809a1b` |');
    expect(text).toContain('| Recorded | 2026-03-02 09:14 UTC |');
    expect(text).toContain('| Status | **Computationally plausible** (rung 4 of 6) |');
    expect(text).toContain('| InChIKey | `NBVXSUQYWXRMNV-UHFFFAOYSA-N` |');
    expect(text).toContain('RDKit 2026.09.2 accepts the structure as chemically well-formed.');
    expect(text).toContain('3. No match in searched catalogues (reached).');
    expect(text).toContain('4. Computationally plausible (**current**).');
    expect(text).toContain('5. Experimentally observed (not reached).');
  });

  it('lists every search as it happened, a failed one as failed', () => {
    expect(text).toContain('| 2026-03-02 09:15 UTC | MATTER LAB built-in library | the identical structure | 63 | no record with this InChIKey |  |');
    expect(text).toContain('| 2026-03-02 09:15 UTC | MATTER LAB built-in library | similar structures | 63 | 1 similar structure listed | Methanol (pubchem:887, similarity 0.20) |');
    expect(text).toContain('| 2026-03-02 09:15 UTC | PubChem Compound | the identical structure | not reported | did not complete; says nothing either way |  |');
  });

  it('gives the whole trail in order, saying who recorded each entry, and keeps table and list structure intact', () => {
    const trail = text.split('\n').filter((line) => /^\d+\. \*\*20/.test(line));
    expect(trail).toHaveLength(4);
    expect(trail[0]).toContain('Note** (stated by the user, not verified). Candidate recorded');
    expect(trail[2]).toContain('Calculation, converged** (recorded by MATTER LAB).');
    // A line break and a cell separator typed into a summary cannot break the report apart.
    expect(trail[3]).toBe('4. **2026-03-03 11:00 UTC · Experimental observation** (stated by the user, not verified). Seen by 19F NMR \\| one signal at −271 ppm Reference: doi:10.1000/example.');
    for (const line of text.split('\n').filter((l) => l.startsWith('| 2026'))) expect(line.split(/(?<!\\)\|/)).toHaveLength(8);
  });

  it('says so when the structure was not accepted', () => {
    const rejected = candidateMarkdown(
      { ...candidate, status: 'user-created', structureValid: false, smiles: null, inchi: null, inchiKey: null, searches: [], validation: { ...candidate.validation, rdkitErrors: ['Explicit valence for atom # 0 C, 5, is greater than permitted'] } },
      '2026-03-04T08:00:00.000Z',
    );
    expect(rejected).toContain('RDKit 2026.09.2 does not accept the structure: Explicit valence for atom # 0 C, 5, is greater than permitted');
    expect(rejected).toContain('| InChIKey | none |');
    expect(rejected).toContain('No catalogue has been searched for this structure.');
    expect(rejected).toContain('| Status | **User-created** (rung 1 of 6) |');
  });
});

describe('reading a report file', () => {
  it('reads back what the application writes', () => {
    const reading = readCandidateReport(JSON.parse(JSON.stringify(file())));
    expect(reading.ok).toBe(true);
    if (!reading.ok) return;
    expect(reading.candidate).toMatchObject({ id: candidate.id, title: 'Trial | one', status: 'computationally-plausible', inchiKey: candidate.inchiKey, exportedAt: '2026-03-04T08:00:00.000Z' });
    expect(reading.candidate.searches).toEqual(SEARCHES);
    expect(reading.candidate.evidence).toEqual(EVIDENCE);
    expect(reading.candidate.scene).toEqual(scene);
  });

  it('refuses what is not a candidate report, saying why', () => {
    const problem = (json: unknown): string => {
      const reading = readCandidateReport(json);
      return reading.ok ? '' : reading.problem;
    };
    expect(problem(null)).toBe('This is not a MATTER LAB candidate report.');
    expect(problem({ format: 'matterlab.project', version: 1 })).toBe('This is not a MATTER LAB candidate report.');
    expect(problem(file({ version: 2 }))).toBe('This report is written in version 2 of the format; this application reads version 1.');
    expect(problem(file({ id: 'not-an-identifier' }))).toBe('The report has no valid identifier.');
    expect(problem(file({ status: 'confirmed-discovery' }))).toBe('The report states a status this application does not know.');
    expect(problem(file({ structure: { inchiKey: null } }))).toBe('The report holds no structure.');
    expect(problem(file({ structure: { inchiKey: null, scene: { format: 'matterlab.scene', version: 1, atoms: 'none' } } }))).toMatch(/^The structure in the report cannot be read: /);
    expect(problem(file({ evidence: 'none' }))).toBe('The report holds no list of searches or no evidence trail.');
  });

  it('refuses a file with an entry that is not well-formed, and names the entry', () => {
    const problem = (json: unknown): string => {
      const reading = readCandidateReport(json);
      return reading.ok ? '' : reading.problem;
    };
    // A kind of evidence that does not exist, an entry without a time, a status change to nowhere.
    expect(problem(file({ evidence: [EVIDENCE[0], { ...EVIDENCE[1], kind: 'peer-review' }] }))).toBe('Entry 2 of the evidence trail in the report is not well-formed.');
    expect(problem(file({ evidence: [{ ...EVIDENCE[0], createdAt: 'yesterday' }] }))).toBe('Entry 1 of the evidence trail in the report is not well-formed.');
    expect(problem(file({ evidence: [{ ...EVIDENCE[0], statusAfter: 'proven' }] }))).toBe('Entry 1 of the evidence trail in the report is not well-formed.');
    expect(problem(file({ evidence: [{ ...EVIDENCE[2], converged: 'yes' }] }))).toBe('Entry 1 of the evidence trail in the report is not well-formed.');
    // A search from a catalogue the application does not know, and one whose outcome contradicts what it lists.
    expect(problem(file({ catalogueSearches: [SEARCHES[0], { ...SEARCHES[0], catalogue: 'my-notebook' }] }))).toBe('Catalogue search 2 in the report is not well-formed.');
    expect(problem(file({ catalogueSearches: [{ ...SEARCHES[0], outcome: 'match' }] }))).toBe('Catalogue search 1 in the report is not well-formed.');
    expect(problem(file({ catalogueSearches: [{ ...SEARCHES[1], outcome: 'no-match' }] }))).toBe('Catalogue search 1 in the report is not well-formed.');
    expect(problem(file({ catalogueSearches: [{ ...SEARCHES[0], recordsSearched: -1 }] }))).toBe('Catalogue search 1 in the report is not well-formed.');
  });

  it('keeps nothing from the file that it did not check the form of', () => {
    const reading = readCandidateReport(file({ evidence: [{ ...EVIDENCE[0], verified: true, recordedBy: 'user' }], catalogueSearches: [{ ...SEARCHES[0], trusted: 'yes' }], statusLabel: 'Confirmed' }));
    expect(reading.ok).toBe(true);
    if (!reading.ok) return;
    expect(Object.keys(reading.candidate.evidence[0]!).sort()).toEqual(['createdAt', 'id', 'kind', 'recordedBy', 'statusAfter', 'summary']);
    expect(Object.keys(reading.candidate.searches[0]!)).not.toContain('trusted');
    expect(Object.keys(reading.candidate)).not.toContain('statusLabel');
  });
});
