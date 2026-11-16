// Builds the library of 3D species models used by the reaction chamber.
//
//   node tools/data/build-species.mjs           rebuild from tools/data/sources/pubchem-3d-conformers.json
//   node tools/data/build-species.mjs --fetch   refresh that snapshot from PubChem first
//
// The species are the molecular (more than one atom) species named in the reaction data of
// @matterlab/reactions: its thermodynamic table and its kinetic models. For each name PubChem is asked
// for its compounds and for their PubChem3D conformers; a conformer is accepted only if its
// composition and charge are exactly those of the species' formula. Nothing is typed by hand.
//
// PubChem3D conformers are computed model geometries (MMFF94s), not measurements. PubChem is a
// public-domain database of the U.S. National Library of Medicine; its usage policy asks for at most
// five requests per second, and this script sends about four.

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const snapshotPath = join(here, 'sources', 'pubchem-3d-conformers.json');
const manifestPath = join(here, 'sources', 'manifest.json');
const elementsPath = join(here, 'generated', 'elements.json');
const outPath = join(root, 'apps', 'web', 'src', 'science', 'speciesModels.generated.ts');

const PUG = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug';
const SPACING_MS = 260;

const elements = JSON.parse(await readFile(elementsPath, 'utf8'));
const elementList = Array.isArray(elements) ? elements : elements.elements;
const zBySymbol = new Map(elementList.map((e) => [e.symbol, e.z]));

/** Composition and charge of a formula in the plain notation of @matterlab/reactions. */
function parseFormula(text) {
  let body = text.trim();
  let charge = 0;
  let m = /\^(\d*)([+-])$/.exec(body);
  if (m) {
    charge = (m[1] ? Number(m[1]) : 1) * (m[2] === '+' ? 1 : -1);
    body = body.slice(0, m.index);
  } else if ((m = /(\++|-+)$/.exec(body))) {
    charge = m[1].length * (m[1][0] === '+' ? 1 : -1);
    body = body.slice(0, m.index);
  }
  let i = 0;
  const group = () => {
    const counts = {};
    while (i < body.length && body[i] !== ')') {
      let part;
      if (body[i] === '(') {
        i++;
        part = group();
        if (body[i] !== ')') throw new Error(`Unbalanced brackets in ${text}`);
        i++;
      } else {
        const symbol = /^[A-Z][a-z]?/.exec(body.slice(i));
        if (!symbol || !zBySymbol.has(symbol[0])) throw new Error(`Cannot read formula ${text}`);
        i += symbol[0].length;
        part = { [symbol[0]]: 1 };
      }
      const digits = /^\d+/.exec(body.slice(i));
      const n = digits ? Number(digits[0]) : 1;
      if (digits) i += digits[0].length;
      for (const [symbol, count] of Object.entries(part)) counts[symbol] = (counts[symbol] ?? 0) + count * n;
    }
    return counts;
  };
  const counts = group();
  if (i !== body.length) throw new Error(`Cannot read formula ${text}`);
  return { counts, charge };
}

/** Reads the first record of a V2000 SD file. */
function parseSdf(sdf) {
  const lines = sdf.split(/\r?\n/);
  const counts = lines[3];
  const atomCount = Number(counts.slice(0, 3));
  const bondCount = Number(counts.slice(3, 6));
  const atoms = [];
  for (let i = 0; i < atomCount; i++) {
    const line = lines[4 + i];
    const symbol = line.slice(31, 34).trim();
    if (!zBySymbol.has(symbol)) throw new Error(`Unknown element ${symbol}`);
    atoms.push({ z: zBySymbol.get(symbol), symbol, charge: 0, x: Number(line.slice(0, 10)), y: Number(line.slice(10, 20)), zc: Number(line.slice(20, 30)) });
  }
  const bonds = [];
  for (let i = 0; i < bondCount; i++) {
    const line = lines[4 + atomCount + i];
    bonds.push([Number(line.slice(0, 3)) - 1, Number(line.slice(3, 6)) - 1, Number(line.slice(6, 9))]);
  }
  for (const line of lines.slice(4 + atomCount + bondCount)) {
    if (line.startsWith('M  END')) break;
    if (!line.startsWith('M  CHG')) continue;
    const n = Number(line.slice(6, 9));
    for (let k = 0; k < n; k++) atoms[Number(line.slice(10 + 8 * k, 13 + 8 * k)) - 1].charge = Number(line.slice(14 + 8 * k, 17 + 8 * k));
  }
  return { atoms, bonds };
}

function matches(model, formula) {
  const found = {};
  let charge = 0;
  for (const atom of model.atoms) {
    found[atom.symbol] = (found[atom.symbol] ?? 0) + 1;
    charge += atom.charge;
  }
  const want = Object.entries(formula.counts);
  return charge === formula.charge && want.length === Object.keys(found).length && want.every(([symbol, count]) => found[symbol] === count);
}

/** Removes every bracketed remark that follows a space, brackets inside it included: "mercury(I) ion (dimercury(2+))" becomes "mercury(I) ion". */
function stripRemarks(name) {
  let out = '';
  for (let i = 0; i < name.length; i++) {
    if (name[i] === ' ' && name[i + 1] === '(') {
      let depth = 0;
      let j = i + 1;
      for (; j < name.length; j++) {
        if (name[j] === '(') depth++;
        else if (name[j] === ')' && --depth === 0) break;
      }
      i = j;
    } else out += name[i];
  }
  return out;
}

/** The name to search by: remarks on the state and trailing structural formulas are dropped. */
function searchName(name) {
  return stripRemarks(name)
    .replace(/,\s.*$/, '')
    .replace(/\s+(vapor|vapour|ion)$/i, '')
    .trim();
}

async function collectSpecies() {
  const load = (file) => import(pathToFileURL(join(root, 'packages', 'reactions', 'src', 'data', file)).href);
  const { THERMO_RECORDS } = await load('thermo.generated.ts');
  const { KINETIC_RECORDS } = await load('kinetics.generated.ts');
  const species = new Map();
  const add = (name, formula) => {
    const parsed = parseFormula(formula);
    const atoms = Object.values(parsed.counts).reduce((a, b) => a + b, 0);
    // Single atoms and monatomic ions need no model.
    if (atoms < 2) return;
    const query = searchName(name);
    const key = query.toLowerCase();
    if (!species.has(key)) species.set(key, { query, formula, composition: parsed });
  };
  // A compound that is tabulated only as a solid is an extended lattice (a salt, an oxide, a metal),
  // not a molecule, so no molecular model is sought for it.
  const fluid = new Set(THERMO_RECORDS.filter((r) => r.phase !== 's').map((r) => r.formula));
  for (const record of THERMO_RECORDS) if (record.phase !== 's' || fluid.has(record.formula)) add(record.name, record.formula);
  for (const record of KINETIC_RECORDS) for (const [formula, name] of Object.entries(record.speciesNames)) add(name, formula);
  return [...species.values()].sort((a, b) => a.query.localeCompare(b.query));
}

let lastRequest = 0;
async function get(url) {
  const wait = lastRequest + SPACING_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequest = Date.now();
  const response = await fetch(url);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`PubChem answered HTTP ${response.status} for ${url}`);
  return response.text();
}

/** True when every atom of the record can be reached from the first one: one molecule, not a salt or a mixture. */
function connected(model) {
  const seen = new Set([0]);
  const queue = [0];
  while (queue.length > 0) {
    const atom = queue.pop();
    for (const [a, b] of model.bonds) {
      const next = a === atom ? b : b === atom ? a : -1;
      if (next >= 0 && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen.size === model.atoms.length;
}

async function fetchSnapshot() {
  const species = await collectSpecies();
  const entries = [];
  for (const s of species) {
    const cidText = await get(`${PUG}/compound/name/${encodeURIComponent(s.query)}/cids/JSON`);
    const cids = cidText ? (JSON.parse(cidText).IdentifierList?.CID ?? []).slice(0, 3) : [];
    let entry = { query: s.query, formula: s.formula, status: cids.length === 0 ? 'name-not-found' : 'no-record-matches' };
    // First choice: a PubChem3D conformer. Second: the 2D record, which gives the bonding only; its
    // flat drawing coordinates are not a geometry and must be relaxed by a force field before use.
    for (const kind of ['3d', '2d']) {
      if (entry.status === 'ok') break;
      for (const cid of cids) {
        const sdf = await get(`${PUG}/compound/cid/${cid}/SDF?record_type=${kind}`);
        if (!sdf) continue;
        const model = parseSdf(sdf);
        if (!matches(model, s.composition) || !connected(model)) continue;
        const props = JSON.parse(await get(`${PUG}/compound/cid/${cid}/property/Title,InChIKey/JSON`)).PropertyTable.Properties[0];
        entry = { query: s.query, formula: s.formula, status: 'ok', coordinates: kind, cid, title: props.Title, inchiKey: props.InChIKey, sdf };
        break;
      }
    }
    console.log(`${(entry.status === 'ok' ? `ok (${entry.coordinates})` : entry.status).padEnd(20)} ${s.query}${entry.cid ? `  (CID ${entry.cid})` : ''}`);
    entries.push(entry);
  }
  const snapshot = { source: 'PubChem PUG REST, PubChem3D conformers', retrieved: new Date().toISOString().slice(0, 10), entries };
  const text = `${JSON.stringify(snapshot, null, 1)}\n`;
  await writeFile(snapshotPath, text);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.pubchem3d = {
    url: `${PUG}/compound/cid/<cid>/SDF?record_type=3d|2d`,
    retrieved: snapshot.retrieved,
    sha256: createHash('sha256').update(text).digest('hex'),
    species: entries.length,
    withConformer: entries.filter((e) => e.status === 'ok' && e.coordinates === '3d').length,
    withBondingOnly: entries.filter((e) => e.status === 'ok' && e.coordinates === '2d').length,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function build() {
  const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
  const round = (v) => Number(v.toFixed(4));
  const rows = [];
  for (const entry of snapshot.entries) {
    if (entry.status !== 'ok') continue;
    const model = parseSdf(entry.sdf);
    const composition = parseFormula(entry.formula);
    if (!matches(model, composition)) throw new Error(`Snapshot entry ${entry.query} no longer matches ${entry.formula}`);
    rows.push({
      name: entry.query.toLowerCase(),
      title: entry.title,
      cid: entry.cid,
      inchiKey: entry.inchiKey,
      formula: entry.formula,
      charge: composition.charge,
      coordinates: entry.coordinates,
      atoms: model.atoms.map((a) => [a.z, a.charge, round(a.x), round(a.y), round(a.zc)]),
      bonds: model.bonds,
    });
  }
  const unavailable = snapshot.entries.filter((e) => e.status !== 'ok').map((e) => ({ name: e.query.toLowerCase(), formula: e.formula, reason: e.status }));
  const lines = [
    '// GENERATED by tools/data/build-species.mjs from tools/data/sources/pubchem-3d-conformers.json. Do not edit.',
    '',
    '/** One PubChem record of a species: its bonding, and a model geometry when PubChem has one. */',
    'export interface SpeciesModelRecord {',
    '  /** Name the model is found by, in lower case. */',
    '  readonly name: string;',
    '  readonly title: string;',
    '  readonly cid: number;',
    '  readonly inchiKey: string;',
    '  /** Formula of the species in the reaction data that this model was matched to. */',
    '  readonly formula: string;',
    '  readonly charge: number;',
    '  /**',
    "   * `3d`: a PubChem3D conformer, a computed model geometry (MMFF94s), not a measured structure.",
    "   * `2d`: PubChem has no conformer; the coordinates are those of a flat drawing and say nothing about",
    '   * the shape. Only the bonding may be used, and a geometry has to be computed from it.',
    '   */',
    "  readonly coordinates: '3d' | '2d';",
    '  /** Atomic number, formal charge, then x, y, z in angstrom (3d) or drawing units (2d). */',
    '  readonly atoms: ReadonlyArray<readonly [number, number, number, number, number]>;',
    '  /** Indices into `atoms` and the bond order as PubChem writes it (Kekule form). */',
    '  readonly bonds: ReadonlyArray<readonly [number, number, number]>;',
    '}',
    '',
    'export const SPECIES_MODELS_SOURCE = {',
    "  name: 'PubChem',",
    "  url: 'https://pubchem.ncbi.nlm.nih.gov',",
    `  retrieved: '${snapshot.retrieved}',`,
    "  license: 'Public domain (U.S. National Library of Medicine)',",
    "  note: 'Records are accepted only when composition and charge equal those of the species formula and the record is a single molecule.',",
    '} as const;',
    '',
    '/** Species of the reaction data for which PubChem has no usable record, and why. */',
    `export const SPECIES_WITHOUT_MODEL: ReadonlyArray<{ readonly name: string; readonly formula: string; readonly reason: string }> = ${JSON.stringify(unavailable)};`,
    '',
    'export const SPECIES_MODELS: readonly SpeciesModelRecord[] = [',
    ...rows.map((row) => `  ${JSON.stringify(row)},`),
    '];',
    '',
  ];
  await writeFile(outPath, lines.join('\n'));
  const flat = rows.filter((r) => r.coordinates === '2d').length;
  console.log(`Wrote ${rows.length} species records (${rows.length - flat} with a 3D conformer, ${flat} with bonding only; ${unavailable.length} species have none) to ${outPath}`);
}

if (process.argv.includes('--fetch')) await fetchSnapshot();
await build();
