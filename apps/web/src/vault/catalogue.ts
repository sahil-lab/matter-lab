import { searchStructures } from '../science/chem';
import { localLibrary } from '../science/library';
import { compoundsByInchiKey, pubchemUrl, similarCompounds } from '../science/pubchem';
import type { CatalogueMatch, CatalogueSearch } from './ladder';

export { localLibrary };

/**
 * The catalogues the Discovery Vault can search, and the searches themselves. Every search
 * returns a record of what was asked, of which catalogue, when, over how many records, and what
 * came back. A search that fails is returned as such; it is never reported as "nothing found".
 */

export const LOCAL_CATALOGUE_TITLE = 'MATTER LAB built-in library';
export const PUBCHEM_TITLE = 'PubChem Compound';

/**
 * The library structures most like the candidate are listed with their scores, down to this
 * Tanimoto similarity (Morgan fingerprints). The floor is low on purpose: fingerprints of very
 * small molecules share few bits, so even close relatives score modestly, and the score shown
 * beside each structure says how close it is.
 */
export const LOCAL_SIMILARITY_THRESHOLD = 0.15;
/** Per cent similarity (PubChem 2D fingerprint) asked of PubChem. */
export const PUBCHEM_SIMILARITY_THRESHOLD = 90;
const LISTED = 6;

const now = (): string => new Date().toISOString();
const newId = (): string => crypto.randomUUID();
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Is the identical structure in the built-in library? Identity is equality of the standard InChIKey. */
export async function searchLibraryIdentity(inchiKey: string): Promise<CatalogueSearch> {
  const base = { id: newId(), catalogue: 'matterlab-library', catalogueTitle: LOCAL_CATALOGUE_TITLE, method: 'exact-inchikey', searchedAt: now() } as const;
  try {
    const entries = (await localLibrary()).filter((entry) => entry.inchiKey !== null);
    const matches: CatalogueMatch[] = entries.filter((entry) => entry.inchiKey === inchiKey).map((entry) => ({ id: entry.id, name: entry.name, ...(entry.url ? { url: entry.url } : {}) }));
    return { ...base, recordsSearched: entries.length, outcome: matches.length > 0 ? 'match' : 'no-match', matches, detail: `Equality of the standard InChIKey ${inchiKey}.` };
  } catch (error) {
    return { ...base, recordsSearched: null, outcome: 'error', matches: [], detail: reason(error) };
  }
}

/** Which library structures resemble this one? Informative only: resemblance is not identity. */
export async function searchLibrarySimilarity(smiles: string): Promise<CatalogueSearch> {
  const base = { id: newId(), catalogue: 'matterlab-library', catalogueTitle: LOCAL_CATALOGUE_TITLE, method: 'similarity', searchedAt: now() } as const;
  const criterion = `The ${LISTED} most similar structures by Tanimoto similarity of Morgan fingerprints (radius 2, 2048 bits), down to ${LOCAL_SIMILARITY_THRESHOLD}. 1 means the same fingerprint.`;
  try {
    const entries = (await localLibrary()).filter((entry) => entry.smiles !== null);
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const result = await searchStructures('similarity', smiles, entries.map((entry) => ({ id: entry.id, smiles: entry.smiles! })), LOCAL_SIMILARITY_THRESHOLD);
    if (!result.ok) return { ...base, recordsSearched: null, outcome: 'error', matches: [], detail: result.errors.join(' ') };
    const matches: CatalogueMatch[] = result.hits.slice(0, LISTED).map((hit) => {
      const entry = byId.get(hit.id)!;
      return { id: entry.id, name: entry.name, similarity: hit.similarity ?? 0, ...(entry.url ? { url: entry.url } : {}) };
    });
    return { ...base, recordsSearched: entries.length - result.skipped.length, outcome: matches.length > 0 ? 'match' : 'no-match', matches, detail: criterion };
  } catch (error) {
    return { ...base, recordsSearched: null, outcome: 'error', matches: [], detail: reason(error) };
  }
}

/** Does PubChem hold a compound with this InChIKey? One lookup is sent now, whatever was asked before. */
export async function searchPubChemIdentity(inchiKey: string): Promise<CatalogueSearch> {
  const base = { id: newId(), catalogue: 'pubchem', catalogueTitle: PUBCHEM_TITLE, method: 'exact-inchikey', searchedAt: now(), recordsSearched: null } as const;
  try {
    const found = await compoundsByInchiKey(inchiKey, 3, true);
    const matches: CatalogueMatch[] = found.map((compound) => ({ id: `CID ${compound.cid}`, name: compound.title, formula: compound.formula, url: pubchemUrl(compound.cid) }));
    return { ...base, outcome: matches.length > 0 ? 'match' : 'no-match', matches, detail: `PUG REST lookup of the standard InChIKey ${inchiKey}. PubChem does not report how many records it searched.` };
  } catch (error) {
    return { ...base, outcome: 'error', matches: [], detail: reason(error) };
  }
}

/** Compounds PubChem considers similar. PubChem returns the compounds that pass the threshold, not their scores. */
export async function searchPubChemSimilarity(smiles: string): Promise<CatalogueSearch> {
  const base = { id: newId(), catalogue: 'pubchem', catalogueTitle: PUBCHEM_TITLE, method: 'similarity', searchedAt: now(), recordsSearched: null } as const;
  try {
    const found = await similarCompounds(smiles, PUBCHEM_SIMILARITY_THRESHOLD, LISTED, true);
    const matches: CatalogueMatch[] = found.map((compound) => ({ id: `CID ${compound.cid}`, name: compound.title, formula: compound.formula, url: pubchemUrl(compound.cid) }));
    return {
      ...base,
      outcome: matches.length > 0 ? 'match' : 'no-match',
      matches,
      detail: `PubChem 2D fingerprint similarity (Tanimoto) of at least ${PUBCHEM_SIMILARITY_THRESHOLD} %; the first ${LISTED} compounds PubChem returns. PubChem does not return the scores.`,
    };
  } catch (error) {
    return { ...base, outcome: 'error', matches: [], detail: reason(error) };
  }
}

/** One sentence on what a search found, for the evidence trail. */
export function describeSearch(search: CatalogueSearch): string {
  const records = search.recordsSearched !== null ? ` among ${search.recordsSearched} records` : '';
  if (search.outcome === 'error') return `${search.catalogueTitle}: the search did not complete (${search.detail}). It says nothing either way and does not count as a search.`;
  if (search.method === 'exact-inchikey') {
    return search.outcome === 'match'
      ? `${search.catalogueTitle}: an identical structure is on record (${search.matches.map((m) => `${m.name}, ${m.id}`).join('; ')}).`
      : `${search.catalogueTitle}: no record with this InChIKey${records}.`;
  }
  return search.outcome === 'match'
    ? `${search.catalogueTitle}: ${search.matches.length} similar structure${search.matches.length === 1 ? '' : 's'} listed${records} (${search.matches.map((m) => m.name).join(', ')}).`
    : `${search.catalogueTitle}: no structure reaches the similarity threshold${records}.`;
}
