/**
 * The Discovery Vault's rules: what a candidate's status is, what it means, and what each further
 * rung of the ladder requires. Pure functions, no storage and no interface.
 *
 * The one rule everything here serves: a structure that no searched catalogue contains is a
 * candidate for investigation, never a discovery. No status and no text produced here says that a
 * compound is new or unknown, because a search that finds nothing only says where it looked.
 */

export type CandidateStatus =
  | 'user-created'
  | 'structurally-validated'
  | 'no-match-in-searched-catalogues'
  | 'computationally-plausible'
  | 'experimentally-observed'
  | 'independently-validated';

/** The ladder, lowest rung first. */
export const STATUS_LADDER: readonly CandidateStatus[] = [
  'user-created',
  'structurally-validated',
  'no-match-in-searched-catalogues',
  'computationally-plausible',
  'experimentally-observed',
  'independently-validated',
];

export const STATUS_LABELS: Readonly<Record<CandidateStatus, string>> = {
  'user-created': 'User-created',
  'structurally-validated': 'Structurally validated',
  'no-match-in-searched-catalogues': 'No match in searched catalogues',
  'computationally-plausible': 'Computationally plausible',
  'experimentally-observed': 'Experimentally observed',
  'independently-validated': 'Independently validated',
};

/** What each rung takes, in one line, for the ladder as it is drawn. */
export const STATUS_REQUIREMENTS: Readonly<Record<CandidateStatus, string>> = {
  'user-created': 'A structure was recorded as drawn.',
  'structurally-validated': 'RDKit accepts the structure as chemically well-formed.',
  'no-match-in-searched-catalogues': 'At least one catalogue was searched for the identical structure, and none that was searched holds it.',
  'computationally-plausible': 'A calculation for this structure converged and is attached.',
  'experimentally-observed': 'An experimental observation with a reference is attached.',
  'independently-validated': 'An independent validation with a reference is attached.',
};

export type CatalogueKey = 'matterlab-library' | 'pubchem';

export interface CatalogueMatch {
  readonly id: string;
  readonly name: string;
  readonly formula?: string;
  readonly url?: string;
  /** Tanimoto similarity of Morgan fingerprints (0..1), where the catalogue reports one. */
  readonly similarity?: number;
}

/** One search of one catalogue, exactly as it happened. */
export interface CatalogueSearch {
  readonly id: string;
  readonly catalogue: CatalogueKey;
  readonly catalogueTitle: string;
  /** `exact-inchikey` asks for the identical structure; `similarity` only for related ones. */
  readonly method: 'exact-inchikey' | 'similarity';
  /** ISO 8601, UTC. */
  readonly searchedAt: string;
  /** How many records were searched, when the catalogue says; `null` when it does not. */
  readonly recordsSearched: number | null;
  /** `error`: the search did not complete, so it says nothing either way. */
  readonly outcome: 'match' | 'no-match' | 'error';
  readonly matches: readonly CatalogueMatch[];
  /** The criterion used, or why the search failed. */
  readonly detail: string;
}

export type EvidenceKind = 'note' | 'structure-validation' | 'catalogue-search' | 'calculation' | 'experimental-observation' | 'independent-validation' | 'status-change';

/** One entry of the evidence trail. Entries are only ever added. */
export interface Evidence {
  readonly id: string;
  readonly kind: EvidenceKind;
  readonly summary: string;
  /** `user`: asserted by the user and not verified. `matterlab`: produced by the application itself. */
  readonly recordedBy: 'user' | 'matterlab';
  /** Citation, DOI, URL or lab-notebook reference. */
  readonly reference?: string;
  /** ISO 8601, UTC. */
  readonly createdAt: string;
  readonly statusBefore?: CandidateStatus;
  readonly statusAfter?: CandidateStatus;
  /** For calculations: whether the method converged. */
  readonly converged?: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface CandidateFacts {
  readonly status: CandidateStatus;
  /** Whether RDKit accepted the structure. */
  readonly structureValid: boolean;
  readonly searches: readonly CatalogueSearch[];
  readonly evidence: readonly Evidence[];
}

/** The most recent completed identity search of each catalogue; a later search supersedes an earlier one. */
export function latestIdentitySearches(searches: readonly CatalogueSearch[]): CatalogueSearch[] {
  const latest = new Map<CatalogueKey, CatalogueSearch>();
  for (const search of searches) {
    if (search.method !== 'exact-inchikey' || search.outcome === 'error') continue;
    const known = latest.get(search.catalogue);
    if (!known || search.searchedAt >= known.searchedAt) latest.set(search.catalogue, search);
  }
  return [...latest.values()];
}

/** The identical structure, if any searched catalogue holds it. */
export function identicalStructure(searches: readonly CatalogueSearch[]): { readonly search: CatalogueSearch; readonly match: CatalogueMatch } | null {
  for (const search of latestIdentitySearches(searches)) {
    if (search.outcome === 'match' && search.matches[0]) return { search, match: search.matches[0] };
  }
  return null;
}

/**
 * The status that validation and the catalogue searches establish on their own. The application
 * sets these three rungs itself; a user can neither claim nor skip them.
 */
export function establishedStatus(facts: Pick<CandidateFacts, 'structureValid' | 'searches'>): CandidateStatus {
  if (!facts.structureValid) return 'user-created';
  const latest = latestIdentitySearches(facts.searches);
  if (latest.some((search) => search.outcome === 'match')) return 'structurally-validated';
  return latest.some((search) => search.outcome === 'no-match') ? 'no-match-in-searched-catalogues' : 'structurally-validated';
}

const rank = (status: CandidateStatus): number => STATUS_LADDER.indexOf(status);

/**
 * The status after new facts have come in. Rungs the user climbed are kept as long as the ground
 * under them holds: if a catalogue now holds the identical structure, or the structure is no
 * longer valid, the candidate returns to what the facts establish.
 */
export function reconciledStatus(facts: CandidateFacts): CandidateStatus {
  const established = establishedStatus(facts);
  if (established !== 'no-match-in-searched-catalogues') return established;
  return rank(facts.status) > rank(established) ? facts.status : established;
}

export function nextRung(status: CandidateStatus): CandidateStatus | null {
  return STATUS_LADDER[rank(status) + 1] ?? null;
}

export type AdvanceCheck = { readonly allowed: true; readonly next: CandidateStatus } | { readonly allowed: false; readonly next: CandidateStatus | null; readonly missing: string };

const hasReference = (evidence: Evidence): boolean => (evidence.reference ?? '').trim().length > 0;

/**
 * Whether the candidate may climb to the next rung, and if not, what is missing. The ladder is
 * climbed one rung at a time and every rung needs its own evidence.
 */
export function canAdvance(facts: CandidateFacts): AdvanceCheck {
  const next = nextRung(facts.status);
  if (!next) return { allowed: false, next: null, missing: 'This is the highest rung.' };
  const established = establishedStatus(facts);
  switch (next) {
    case 'structurally-validated':
      return { allowed: false, next, missing: 'RDKit has to accept the structure. Correct it in the Architect and add it again as a new candidate.' };
    case 'no-match-in-searched-catalogues': {
      const found = identicalStructure(facts.searches);
      return {
        allowed: false,
        next,
        missing: found
          ? `An identical structure is on record (${found.match.name}, ${found.search.catalogueTitle}), so this rung does not apply.`
          : 'This rung is set by a completed search for the identical structure. Search the catalogues.',
      };
    }
    case 'computationally-plausible':
      if (established !== 'no-match-in-searched-catalogues') return { allowed: false, next, missing: 'The searched catalogues have to hold no identical structure.' };
      return facts.evidence.some((e) => e.kind === 'calculation' && e.converged === true)
        ? { allowed: true, next }
        : { allowed: false, next, missing: 'A calculation for this structure that converged has to be attached. Run one below.' };
    case 'experimentally-observed':
      return facts.evidence.some((e) => e.kind === 'experimental-observation' && hasReference(e))
        ? { allowed: true, next }
        : { allowed: false, next, missing: 'An experimental observation with a reference has to be attached.' };
    case 'independently-validated':
      return facts.evidence.some((e) => e.kind === 'independent-validation' && hasReference(e))
        ? { allowed: true, next }
        : { allowed: false, next, missing: 'An independent validation with a reference has to be attached.' };
    default:
      return { allowed: false, next, missing: 'This rung cannot be requested.' };
  }
}

/** Whether the candidate may be taken one rung down: only rungs the user climbed can be given up. */
export function canStepBack(facts: CandidateFacts): boolean {
  return rank(facts.status) > rank(establishedStatus(facts));
}

/**
 * The highest rung, no higher than the one stated, that the facts on record carry: what validation
 * and the searches establish, and above that one rung for each piece of evidence the ladder asks
 * for. Used where a status is stated by something other than this application, such as a file.
 */
export function supportedStatus(facts: CandidateFacts): CandidateStatus {
  let status = establishedStatus(facts);
  while (rank(status) < rank(facts.status)) {
    const check = canAdvance({ ...facts, status });
    if (!check.allowed) break;
    status = check.next;
  }
  return status;
}

/** What the current status does and does not say, in full sentences. */
export function statusMeaning(facts: Pick<CandidateFacts, 'status' | 'structureValid' | 'searches'>): string {
  switch (facts.status) {
    case 'user-created':
      return facts.structureValid
        ? 'The structure is recorded as drawn.'
        : 'The structure is recorded as drawn. RDKit does not accept it as chemically well-formed, so it has no identifiers and no catalogue could be searched for it.';
    case 'structurally-validated': {
      const found = identicalStructure(facts.searches);
      if (found) return `An identical structure is on record: ${found.match.name} in ${found.search.catalogueTitle}. This is a compound that is already catalogued.`;
      return 'RDKit accepts the structure as chemically well-formed. That is a statement about valence and bookkeeping; it does not say that the compound exists, is stable or can be made. No search for the identical structure has been completed yet.';
    }
    case 'no-match-in-searched-catalogues':
      return 'No identical structure was found in the catalogues that were searched; they are listed below with the time of each search. Other databases and the literature were not searched, so this does not show that the compound has never been described.';
    case 'computationally-plausible':
      return 'At least one converged calculation for this structure is attached, and the searched catalogues hold no identical structure. A calculation is the result of a model, not an observation: it does not show that the compound can be made.';
    case 'experimentally-observed':
      return 'An experimental observation with a reference was recorded by the user. MATTER LAB records it as stated and has not verified it.';
    case 'independently-validated':
      return 'An independent validation with a reference was recorded by the user. MATTER LAB records it as stated and has not verified it.';
  }
}

/** Which evidence a user may add, and whether it needs a reference. */
export const USER_EVIDENCE: ReadonlyArray<{ readonly kind: 'experimental-observation' | 'independent-validation' | 'note'; readonly label: string; readonly needsReference: boolean }> = [
  { kind: 'experimental-observation', label: 'Experimental observation', needsReference: true },
  { kind: 'independent-validation', label: 'Independent validation', needsReference: true },
  { kind: 'note', label: 'Note', needsReference: false },
];

/** Why a piece of user evidence cannot be recorded as given, or `null` when it can. */
export function evidenceProblem(kind: EvidenceKind, summary: string, reference: string): string | null {
  if (summary.trim().length === 0) return 'Say what the evidence shows.';
  const rule = USER_EVIDENCE.find((entry) => entry.kind === kind);
  if (!rule) return 'This kind of evidence is recorded by the application, not entered by hand.';
  if (rule.needsReference && reference.trim().length === 0) return 'A reference is required: a citation, DOI, URL or lab-notebook entry that someone else could look up.';
  return null;
}
