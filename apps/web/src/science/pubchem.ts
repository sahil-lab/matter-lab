import { fromSDF } from '@matterlab/core';
import type { Provenance, Scene } from '@matterlab/core';

/**
 * A small client for PubChem's PUG REST service (https://pubchem.ncbi.nlm.nih.gov/docs/pug-rest).
 *
 * PubChem is an open database of the U.S. National Library of Medicine. Its usage policy asks for
 * no more than five requests per second; this client sends one at a time and spaces them out.
 * Everything fetched is cached for the session, so repeating a search costs no request.
 */

const BASE = 'https://pubchem.ncbi.nlm.nih.gov/rest';
const MIN_SPACING_MS = 230;
const PROPERTIES = 'Title,MolecularFormula,MolecularWeight,InChIKey,SMILES,IUPACName,Charge';

export interface PubChemCompound {
  readonly cid: number;
  readonly title: string;
  readonly formula: string;
  readonly molecularWeight: number | null;
  readonly inchiKey: string;
  readonly smiles: string;
  readonly iupacName: string | null;
  readonly charge: number;
}

export type PubChemErrorKind = 'not-found' | 'network' | 'busy' | 'bad-response';

export class PubChemError extends Error {
  constructor(
    readonly kind: PubChemErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'PubChemError';
  }
}

export function pubchemUrl(cid: number): string {
  return `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}`;
}

export function pubchemProvenance(cid: number, retrieved: string, notes?: string): Provenance {
  return {
    source: 'PubChem',
    url: pubchemUrl(cid),
    retrieved,
    license: 'Public domain (U.S. National Library of Medicine); contributed data may carry its own terms',
    citations: [
      {
        authors: 'S. Kim et al.',
        title: 'PubChem 2025 update',
        source: 'Nucleic Acids Research 53, D1516-D1525',
        year: 2025,
        doi: '10.1093/nar/gkae1059',
      },
    ],
    ...(notes ? { notes } : {}),
  };
}

let chain: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;
const cache = new Map<string, Promise<string>>();

/**
 * Fetches a PUG REST path as text. Requests are serialised and spaced; successful answers are
 * cached. `fresh` sends a request even when an answer is cached, for callers that record when
 * they asked.
 */
function request(path: string, fresh = false): Promise<string> {
  if (fresh) cache.delete(path);
  const cached = cache.get(path);
  if (cached) return cached;
  const result = chain.then(async () => {
    const wait = lastRequestAt + MIN_SPACING_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => window.setTimeout(resolve, wait));
    lastRequestAt = Date.now();
    let response: Response;
    try {
      response = await fetch(`${BASE}${path}`, { headers: { Accept: 'application/json, chemical/x-mdl-sdfile, text/plain' } });
    } catch {
      throw new PubChemError('network', 'PubChem could not be reached. Check the network connection.');
    }
    if (response.status === 404) throw new PubChemError('not-found', 'PubChem has no record that matches.');
    if (response.status === 503 || response.status === 429) throw new PubChemError('busy', 'PubChem is busy right now. Try again in a moment.');
    if (!response.ok) throw new PubChemError('bad-response', `PubChem answered with an error (HTTP ${response.status}).`);
    return response.text();
  });
  // A failure must not poison the queue or stay cached.
  chain = result.catch(() => undefined);
  cache.set(path, result);
  result.catch(() => cache.delete(path));
  return result;
}

async function requestJson<T>(path: string, fresh = false): Promise<T> {
  const text = await request(path, fresh);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new PubChemError('bad-response', 'PubChem sent an answer that could not be read.');
  }
}

interface PropertyRow {
  CID: number;
  Title?: string;
  MolecularFormula?: string;
  MolecularWeight?: string | number;
  InChIKey?: string;
  SMILES?: string;
  IsomericSMILES?: string;
  CanonicalSMILES?: string;
  ConnectivitySMILES?: string;
  IUPACName?: string;
  Charge?: number;
}

function toCompound(row: PropertyRow): PubChemCompound {
  const weight = Number(row.MolecularWeight);
  return {
    cid: row.CID,
    title: row.Title ?? row.IUPACName ?? `CID ${row.CID}`,
    formula: row.MolecularFormula ?? '',
    molecularWeight: Number.isFinite(weight) ? weight : null,
    inchiKey: row.InChIKey ?? '',
    smiles: row.SMILES ?? row.IsomericSMILES ?? row.CanonicalSMILES ?? row.ConnectivitySMILES ?? '',
    iupacName: row.IUPACName ?? null,
    charge: row.Charge ?? 0,
  };
}

async function properties(cids: readonly number[]): Promise<PubChemCompound[]> {
  if (cids.length === 0) return [];
  const data = await requestJson<{ PropertyTable?: { Properties?: PropertyRow[] } }>(`/pug/compound/cid/${cids.join(',')}/property/${PROPERTIES}/JSON`);
  const rows = data.PropertyTable?.Properties ?? [];
  // Keep the order PubChem ranked the identifiers in.
  const byId = new Map(rows.map((row) => [row.CID, row]));
  return cids.flatMap((cid) => (byId.has(cid) ? [toCompound(byId.get(cid)!)] : []));
}

async function cidsFor(path: string, limit: number, fresh = false): Promise<number[]> {
  try {
    const data = await requestJson<{ IdentifierList?: { CID?: number[] } }>(path, fresh);
    return (data.IdentifierList?.CID ?? []).filter((cid) => cid > 0).slice(0, limit);
  } catch (error) {
    if (error instanceof PubChemError && error.kind === 'not-found') return [];
    throw error;
  }
}

/** Compound names that begin like the text typed so far. */
export async function suggestNames(prefix: string, limit = 8): Promise<string[]> {
  const text = prefix.trim();
  if (text.length < 2) return [];
  const data = await requestJson<{ dictionary_terms?: { compound?: string[] } }>(`/autocomplete/compound/${encodeURIComponent(text)}/JSON?limit=${limit}`);
  return data.dictionary_terms?.compound ?? [];
}

/** Compounds registered under a name (a common name, an IUPAC name, a registry number). */
export async function compoundsByName(name: string, limit = 6): Promise<PubChemCompound[]> {
  return properties(await cidsFor(`/pug/compound/name/${encodeURIComponent(name.trim())}/cids/JSON`, limit));
}

/**
 * The compound with exactly this InChIKey, if PubChem holds one. An empty result is not evidence
 * that the compound is new. With `fresh`, PubChem is asked again even if it was asked before in
 * this session.
 */
export async function compoundsByInchiKey(inchiKey: string, limit = 3, fresh = false): Promise<PubChemCompound[]> {
  return properties(await cidsFor(`/pug/compound/inchikey/${encodeURIComponent(inchiKey)}/cids/JSON`, limit, fresh));
}

/** Compounds whose 2D fingerprint is at least `threshold` percent similar (Tanimoto) to the given structure. */
export async function similarCompounds(smiles: string, threshold = 90, limit = 8, fresh = false): Promise<PubChemCompound[]> {
  const path = `/pug/compound/fastsimilarity_2d/smiles/${encodeURIComponent(smiles)}/cids/JSON?Threshold=${threshold}&MaxRecords=${limit}`;
  return properties(await cidsFor(path, limit, fresh));
}

export interface PubChemStructure {
  readonly scene: Scene;
  readonly provenance: Provenance;
}

/**
 * PubChem's 3D conformer of a compound, or `null` when it has none (salts, metals, very large or
 * very flexible molecules). The conformer is a computed model (PubChem3D: MMFF94s), not a measurement.
 */
export async function conformer3d(cid: number): Promise<PubChemStructure | null> {
  let text: string;
  try {
    text = await request(`/pug/compound/cid/${cid}/SDF?record_type=3d`);
  } catch (error) {
    if (error instanceof PubChemError && error.kind === 'not-found') return null;
    throw error;
  }
  let records;
  try {
    records = fromSDF(text);
  } catch {
    throw new PubChemError('bad-response', 'PubChem sent a structure that could not be read.');
  }
  const record = records[0];
  if (!record || record.scene.atoms.size === 0) return null;
  return {
    scene: record.scene,
    provenance: pubchemProvenance(cid, new Date().toISOString().slice(0, 10), 'PubChem3D conformer: a computed model geometry (MMFF94s force field), not an experimental structure.'),
  };
}
