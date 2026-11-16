// Downloads the raw STO-3G snapshot (H-Ar) from the Basis Set Exchange REST API into
// packages/quantum/data and records where, when and what was fetched in data/manifest.json.
//
//   node packages/quantum/tools/fetch-basis.mjs
//
// Behind a TLS-inspecting proxy Node's bundled CA list may reject the connection
// (UNABLE_TO_GET_ISSUER_CERT_LOCALLY); in that case trust the operating-system store for this one
// process:  node --use-system-ca packages/quantum/tools/fetch-basis.mjs
//
// Afterwards run build-basis.mjs to regenerate src/basis/sto3g.generated.ts from the snapshot.
// Nothing here is typed in by hand: exponents, contraction coefficients and references all come
// from the downloaded files.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = join(here, '..', 'data');

const ELEMENTS = Array.from({ length: 18 }, (_, i) => i + 1).join(',');
const API = 'https://www.basissetexchange.org/api';

const FILES = [
  {
    name: 'sto-3g.bse.json',
    role: 'Basis set (exponents and contraction coefficients), MolSSI BSE JSON schema',
    url: `${API}/basis/sto-3g/format/json/?elements=${ELEMENTS}`,
  },
  {
    name: 'sto-3g.references.bse.json',
    role: 'Literature references the Basis Set Exchange lists for this basis set',
    url: `${API}/references/sto-3g/format/json/?elements=${ELEMENTS}`,
  },
  {
    name: 'sto-3g.bse.nw',
    role: 'Same basis in NWChem format; kept because its header states the Basis Set Exchange version',
    url: `${API}/basis/sto-3g/format/nwchem/?elements=${ELEMENTS}`,
  },
];

async function download(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  return Buffer.from(await response.arrayBuffer());
}

await mkdir(dataDir, { recursive: true });
const retrieved = new Date().toISOString().slice(0, 10);
const files = {};
let bseVersion = null;

for (const file of FILES) {
  const body = await download(file.url);
  await writeFile(join(dataDir, file.name), body);
  files[file.name] = {
    role: file.role,
    url: file.url,
    retrieved,
    bytes: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
  };
  if (file.name.endsWith('.nw')) {
    const match = /^#\s*Basis Set Exchange\s*\r?\n#\s*Version\s+v?(\S+)/m.exec(body.toString('utf8'));
    if (!match) throw new Error('Could not find the Basis Set Exchange version in the NWChem header.');
    bseVersion = match[1];
  }
  console.log(`${file.name}: ${body.length} bytes`);
}

const basis = JSON.parse(await readFile(join(dataDir, 'sto-3g.bse.json'), 'utf8'));

const manifest = {
  'sto-3g': {
    source: 'Basis Set Exchange',
    homepage: 'https://www.basissetexchange.org',
    bseVersion,
    basisName: basis.name,
    basisVersion: basis.version,
    revisionDescription: basis.revision_description,
    revisionDate: basis.revision_date,
    elements: '1-18',
    retrieved,
    files,
  },
};

await writeFile(join(dataDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Basis Set Exchange version ${bseVersion}; basis "${basis.name}" version ${basis.version}; retrieved ${retrieved}`);
