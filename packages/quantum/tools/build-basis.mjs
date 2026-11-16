// Builds packages/quantum/src/basis/sto3g.generated.ts from the committed Basis Set Exchange
// snapshot in packages/quantum/data (see fetch-basis.mjs for how the snapshot is obtained).
//
//   node packages/quantum/tools/build-basis.mjs
//
// The script only re-encodes the snapshot. It checks the files against the hashes in
// data/manifest.json, validates the JSON schema, cross-checks every exponent and coefficient
// against the independently downloaded NWChem-format copy, and then writes the numbers out as
// JavaScript literals (`Number("0.3425250914E+01")` printed with the shortest representation that
// round-trips, so no digits are lost or invented).

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'data');
const outPath = join(here, '..', 'src', 'basis', 'sto3g.generated.ts');

const MAX_Z = 18;
const SHELL_LETTERS = { S: [0], P: [1], SP: [0, 1] };

function fail(message) {
  throw new Error(`build-basis: ${message}`);
}

async function readVerified(name, manifestFiles) {
  const body = await readFile(join(dataDir, name));
  const expected = manifestFiles[name]?.sha256;
  const actual = createHash('sha256').update(body).digest('hex');
  if (!expected) fail(`${name} is not listed in data/manifest.json`);
  if (expected !== actual) fail(`${name} does not match the sha256 recorded in data/manifest.json`);
  return body.toString('utf8');
}

function toNumber(text, what) {
  const value = Number(text);
  if (typeof text !== 'string' || text.trim() === '' || !Number.isFinite(value)) fail(`${what}: "${text}" is not a finite number`);
  return value;
}

/** Shells of every element in the JSON snapshot, validated. */
function parseJsonBasis(basis) {
  if (basis.molssi_bse_schema?.schema_type !== 'complete') fail('unexpected BSE schema type');
  const shellsByZ = [];
  for (let z = 1; z <= MAX_Z; z++) {
    const element = basis.elements[String(z)];
    if (!element) fail(`element ${z} is missing from the snapshot`);
    if (element.ecp_electrons !== undefined || element.ecp_potentials !== undefined) fail(`element ${z} unexpectedly has an ECP`);
    const shells = element.electron_shells.map((shell, index) => {
      const where = `Z=${z} shell ${index}`;
      if (shell.function_type !== 'gto') fail(`${where}: function type ${shell.function_type} is not supported`);
      const angularMomentum = shell.angular_momentum;
      if (!Array.isArray(angularMomentum) || angularMomentum.length === 0) fail(`${where}: no angular momentum`);
      for (const l of angularMomentum) if (l !== 0 && l !== 1) fail(`${where}: angular momentum ${l} is not s or p`);
      const exponents = shell.exponents.map((x) => toNumber(x, `${where} exponent`));
      if (exponents.some((x) => !(x > 0))) fail(`${where}: non-positive exponent`);
      if (shell.coefficients.length !== angularMomentum.length) fail(`${where}: contraction count does not match angular momenta`);
      const coefficients = shell.coefficients.map((row) => {
        if (row.length !== exponents.length) fail(`${where}: coefficient row length does not match exponents`);
        return row.map((x) => toNumber(x, `${where} coefficient`));
      });
      return { angularMomentum: [...angularMomentum], exponents, coefficients };
    });
    shellsByZ.push(shells);
  }
  return shellsByZ;
}

/** Shells and element symbols from the NWChem-format copy, in file order (ascending Z). */
function parseNwchem(text) {
  const elements = [];
  let current = null;
  let shell = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || /^BASIS\b/i.test(line) || /^END\b/i.test(line)) continue;
    const header = /^([A-Z][a-z]?)\s+(SP|S|P)$/.exec(line);
    if (header) {
      const [, symbol, letters] = header;
      if (!current || current.symbol !== symbol) {
        current = { symbol, shells: [] };
        elements.push(current);
      }
      shell = { angularMomentum: SHELL_LETTERS[letters], exponents: [], coefficients: SHELL_LETTERS[letters].map(() => []) };
      current.shells.push(shell);
      continue;
    }
    const fields = line.split(/\s+/);
    if (!shell || fields.length !== shell.angularMomentum.length + 1) fail(`unexpected line in NWChem file: "${raw}"`);
    shell.exponents.push(toNumber(fields[0], 'NWChem exponent'));
    shell.coefficients.forEach((row, i) => row.push(toNumber(fields[i + 1], 'NWChem coefficient')));
  }
  return elements;
}

function sameShells(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function collectReferences(basis, references) {
  const byKey = new Map();
  for (const group of references) {
    for (const info of group.reference_info) {
      for (const [key, data] of info.reference_data) {
        if (!byKey.has(key)) {
          byKey.set(key, {
            key,
            authors: data.authors,
            title: data.title,
            journal: data.journal,
            volume: data.volume,
            pages: data.pages,
            year: toNumber(data.year, `${key} year`),
            doi: data.doi,
            elements: [],
          });
        }
      }
    }
  }
  // Which element cites which key comes from the basis file itself; the references file must agree.
  for (let z = 1; z <= MAX_Z; z++) {
    const keys = basis.elements[String(z)].references.flatMap((r) => r.reference_keys);
    const group = references.find((g) => g.elements.includes(String(z)));
    const groupKeys = group ? group.reference_info.flatMap((info) => info.reference_data.map(([key]) => key)) : [];
    if (JSON.stringify([...keys].sort()) !== JSON.stringify([...groupKeys].sort())) {
      fail(`reference keys for Z=${z} differ between the basis file and the references file`);
    }
    for (const key of keys) {
      const entry = byKey.get(key);
      if (!entry) fail(`reference ${key} cited by Z=${z} is missing from the references file`);
      entry.elements.push(z);
    }
  }
  return [...byKey.values()];
}

const manifest = JSON.parse(await readFile(join(dataDir, 'manifest.json'), 'utf8'))['sto-3g'];
if (!manifest) fail('data/manifest.json has no "sto-3g" entry; run fetch-basis.mjs first');

const basis = JSON.parse(await readVerified('sto-3g.bse.json', manifest.files));
const references = JSON.parse(await readVerified('sto-3g.references.bse.json', manifest.files));
const nwchem = parseNwchem(await readVerified('sto-3g.bse.nw', manifest.files));

const shellsByZ = parseJsonBasis(basis);
if (nwchem.length !== MAX_Z) fail(`the NWChem copy lists ${nwchem.length} elements, expected ${MAX_Z}`);
shellsByZ.forEach((shells, index) => {
  if (!sameShells(shells, nwchem[index].shells)) fail(`JSON and NWChem snapshots disagree for Z=${index + 1}`);
});
const symbols = nwchem.map((element) => element.symbol);
const citations = collectReferences(basis, references);

const source = {
  name: basis.name,
  description: basis.description,
  family: basis.family,
  publisher: manifest.source,
  homepage: manifest.homepage,
  bseVersion: manifest.bseVersion,
  basisVersion: basis.version,
  revisionDescription: basis.revision_description,
  revisionDate: basis.revision_date,
  url: manifest.files['sto-3g.bse.json'].url,
  retrieved: manifest.files['sto-3g.bse.json'].retrieved,
  sha256: manifest.files['sto-3g.bse.json'].sha256,
};

const shellLines = shellsByZ.map((shells, index) => {
  const body = shells
    .map(
      (s) =>
        `    { angularMomentum: ${JSON.stringify(s.angularMomentum)}, exponents: ${JSON.stringify(s.exponents)}, coefficients: ${JSON.stringify(s.coefficients)} },`,
    )
    .join('\n');
  return `  // Z = ${index + 1} (${symbols[index]})\n  [\n${body}\n  ],`;
});

const out = `// AUTO-GENERATED by packages/quantum/tools/build-basis.mjs. Do not edit by hand; re-run the script instead.
//
// Source: ${source.publisher} ${source.bseVersion}, basis set "${source.name}" version ${source.basisVersion}
// (${source.revisionDescription}, revised ${source.revisionDate}), retrieved ${source.retrieved} from
// ${source.url}
// Raw snapshot: packages/quantum/data/sto-3g.bse.json (sha256 ${source.sha256}).

/**
 * One shell as the Basis Set Exchange lists it. A shell with two angular momenta is an "SP" shell:
 * its s and p functions share the same primitive exponents.
 */
export interface Sto3gShellData {
  /** Angular momentum of each contraction: 0 = s, 1 = p. */
  readonly angularMomentum: readonly number[];
  /** Primitive Gaussian exponents in bohr^-2. */
  readonly exponents: readonly number[];
  /** One row of contraction coefficients per angular momentum, for normalised primitives. */
  readonly coefficients: readonly (readonly number[])[];
}

/** A literature reference the Basis Set Exchange lists for STO-3G. */
export interface Sto3gReference {
  readonly key: string;
  readonly authors: readonly string[];
  readonly title: string;
  readonly journal: string;
  readonly volume: string;
  readonly pages: string;
  readonly year: number;
  readonly doi: string;
  /** Atomic numbers whose basis functions the Basis Set Exchange attributes to this reference. */
  readonly elements: readonly number[];
}

/** Where the numbers in this file come from. */
export const STO3G_SOURCE = ${JSON.stringify(source, null, 2)} as const;

export const STO3G_REFERENCES: readonly Sto3gReference[] = ${JSON.stringify(citations, null, 2)};

/** Element symbols for Z = 1..${MAX_Z}, as written in the Basis Set Exchange snapshot. */
export const STO3G_SYMBOLS: readonly string[] = ${JSON.stringify(symbols)};

/** STO-3G shells for Z = 1..${MAX_Z}; \`STO3G_SHELLS[z - 1]\` belongs to element \`z\`. */
export const STO3G_SHELLS: readonly (readonly Sto3gShellData[])[] = [
${shellLines.join('\n')}
];
`;

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, out);
console.log(`Wrote ${outPath}: ${shellsByZ.length} elements, ${shellsByZ.reduce((n, s) => n + s.length, 0)} shells, ${citations.length} references`);
