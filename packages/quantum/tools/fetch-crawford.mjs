// Downloads the reference data used by the Crawford-group validation tests into
// packages/quantum/test/fixtures/crawford and records provenance in manifest.json there.
//
//   node packages/quantum/tools/fetch-crawford.mjs
//   node --use-system-ca packages/quantum/tools/fetch-crawford.mjs     (behind a TLS-inspecting proxy)
//
// Two sources, both pinned to a commit so the fixtures are reproducible:
//
//  1. CrawfordGroup/ProgrammingProjects, Project #3 (Hartree-Fock SCF): geometry, nuclear repulsion,
//     overlap/kinetic/nuclear-attraction/dipole/two-electron integrals and the reference output for
//     H2O and CH4 in the STO-3G basis. Files are stored unmodified.
//
//  2. The STO-3G entries for H, C and O of the PSI3 basis-set library (psi4/psi3, lib/pbasis.dat).
//     The Crawford H2O integrals were produced by PSI3 with `basis = "STO-3G"`, i.e. with these
//     8-digit parameters rather than the 10-digit Basis Set Exchange values this package ships, so
//     an element-wise comparison at 1e-8 needs them. Only the numbers are kept (as the decimal
//     strings printed in the file), not the file itself. The CH4 reference instead used the basis
//     written out in its own input.dat, which is one of the files from source 1.

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'test', 'fixtures', 'crawford');

const CRAWFORD_REPO = 'CrawfordGroup/ProgrammingProjects';
const CRAWFORD_COMMIT = '297fda143186f08a3a9481b0fb762f87bbbba524';
const PSI3_REPO = 'psi4/psi3';
const PSI3_COMMIT = 'd6289507905a293b61fcc6257f73812abc5ad0c5';

const MOLECULES = ['h2o', 'ch4'];
const INPUT_FILES = ['geom.dat', 'enuc.dat', 'input.dat', 's.dat', 't.dat', 'v.dat', 'mux.dat', 'muy.dat', 'muz.dat', 'eri.dat'];
const PSI3_ELEMENTS = ['HYDROGEN', 'CARBON', 'OXYGEN'];

const sha256 = (body) => createHash('sha256').update(body).digest('hex');

async function download(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
}

/** Extracts `ELEMENT:"STO-3G" = ( (S (exp coef) ...) (P ...) )` entries, keeping numbers as printed. */
function parsePsi3Sto3g(text, element) {
  const start = text.search(new RegExp(`^\\s*${element}:"STO-3G"\\s*=\\s*\\(`, 'm'));
  if (start < 0) throw new Error(`PSI3 pbasis.dat has no STO-3G entry for ${element}`);
  // The entry ends at the first line that holds nothing but the closing parenthesis.
  const rest = text.slice(start);
  const end = rest.search(/^\s*\)\s*$/m);
  if (end < 0) throw new Error(`Unterminated STO-3G entry for ${element}`);
  const body = rest.slice(rest.indexOf('(') + 1, end);
  const shells = [];
  const tokens = body.match(/\(|\)|[^\s()]+/g) ?? [];
  let depth = 0;
  let shell = null;
  let pair = null;
  for (const token of tokens) {
    if (token === '(') {
      depth++;
      if (depth === 2) pair = [];
    } else if (token === ')') {
      if (depth === 2) {
        if (pair.length !== 2) throw new Error(`Malformed primitive in ${element} STO-3G entry`);
        shell.primitives.push({ exponent: pair[0], coefficient: pair[1] });
        pair = null;
      }
      depth--;
    } else if (depth === 1) {
      if (token !== 'S' && token !== 'P') throw new Error(`Unexpected shell type ${token} for ${element}`);
      shell = { type: token, primitives: [] };
      shells.push(shell);
    } else if (depth === 2) {
      if (!Number.isFinite(Number(token))) throw new Error(`Non-numeric token ${token} for ${element}`);
      pair.push(token);
    }
  }
  if (depth !== 0 || shells.length === 0) throw new Error(`Could not parse the STO-3G entry for ${element}`);
  return shells;
}

const retrieved = new Date().toISOString().slice(0, 10);
const crawfordBase = `https://raw.githubusercontent.com/${CRAWFORD_REPO}/${CRAWFORD_COMMIT}/Project%2303`;
const files = {};

for (const molecule of MOLECULES) {
  await mkdir(join(outDir, molecule), { recursive: true });
  const wanted = [
    ...INPUT_FILES.map((name) => ({ name, url: `${crawfordBase}/input/${molecule}/STO-3G/${name}` })),
    { name: 'output.txt', url: `${crawfordBase}/output/${molecule}/STO-3G/output.txt` },
  ];
  for (const { name, url } of wanted) {
    const body = await download(url);
    await writeFile(join(outDir, molecule, name), body);
    files[`${molecule}/${name}`] = { url, bytes: body.length, sha256: sha256(body) };
  }
  console.log(`${molecule}: ${wanted.length} files`);
}

const psi3Url = `https://raw.githubusercontent.com/${PSI3_REPO}/${PSI3_COMMIT}/lib/pbasis.dat`;
const pbasis = await download(psi3Url);
const psi3Basis = {};
for (const element of PSI3_ELEMENTS) psi3Basis[element] = parsePsi3Sto3g(pbasis.toString('utf8'), element);
const psi3File = {
  description:
    'STO-3G parameters for H, C and O exactly as printed in the PSI3 basis-set library (lib/pbasis.dat). Exponents in bohr^-2; contraction coefficients for normalised primitives. Extracted by tools/fetch-crawford.mjs.',
  source: { repository: `https://github.com/${PSI3_REPO}`, commit: PSI3_COMMIT, path: 'lib/pbasis.dat', url: psi3Url, sha256: sha256(pbasis), retrieved },
  basis: psi3Basis,
};
const psi3Body = Buffer.from(`${JSON.stringify(psi3File, null, 2)}\n`);
await writeFile(join(outDir, 'psi3-sto-3g.json'), psi3Body);
console.log(`psi3-sto-3g.json: ${PSI3_ELEMENTS.join(', ')}`);

const manifest = {
  crawford: {
    title: 'Programming Projects, Project #3: The Hartree-Fock Self-Consistent Field Method (reference inputs and outputs)',
    authors: 'T. D. Crawford and co-workers (Crawford group, Virginia Tech)',
    repository: `https://github.com/${CRAWFORD_REPO}`,
    commit: CRAWFORD_COMMIT,
    retrieved,
    license: 'No licence file is published in the upstream repository; the files are unmodified copies kept only as validation references.',
    files,
  },
  psi3: {
    title: 'PSI3 basis-set library (lib/pbasis.dat), STO-3G entries for H, C, O',
    repository: `https://github.com/${PSI3_REPO}`,
    commit: PSI3_COMMIT,
    url: psi3Url,
    retrieved,
    upstreamLicense: 'GPL-2.0 (the file); only the published basis-set parameters are reproduced, as data',
    upstreamSha256: sha256(pbasis),
    extracted: { 'psi3-sto-3g.json': { bytes: psi3Body.length, sha256: sha256(psi3Body) } },
  },
};
await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote manifest.json (retrieved ${retrieved})`);
