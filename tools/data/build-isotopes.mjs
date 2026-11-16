// Builds the isotope table from the IAEA Live Chart of Nuclides ground-state dataset.
//
//   node tools/data/build-isotopes.mjs           rebuild from tools/data/sources/iaea-ground-states.csv
//   node tools/data/build-isotopes.mjs --fetch   refresh the snapshot first
//
// Underlying evaluations, as documented by the IAEA API guide
// (https://www-nds.iaea.org/relnsd/vcharthtml/api_v0_guide.html):
//   half-lives, decay modes, spins, abundances: ENSDF (April 2022 snapshot); masses: AME2020; NUBASE2020.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const csvPath = join(here, 'sources', 'iaea-ground-states.csv');
const manifestPath = join(here, 'sources', 'manifest.json');
const generatedDir = join(here, 'generated');
const tsOutPath = join(here, '..', '..', 'packages', 'core', 'src', 'isotopes', 'isotopes.generated.ts');

const IAEA_URL = 'https://nds.iaea.org/relnsd/v1/data?fields=ground_states&nuclides=all';

function parseCsvLine(line) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(field);
      field = '';
    } else field += ch;
  }
  out.push(field);
  return out;
}

const num = (s) => {
  const t = (s ?? '').trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

async function loadManifest() {
  try {
    return JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    return {};
  }
}

async function main() {
  const manifest = await loadManifest();
  if (process.argv.includes('--fetch')) {
    const res = await fetch(IAEA_URL, { headers: { 'User-Agent': 'Livechart/1.0' } });
    if (!res.ok) throw new Error(`IAEA request failed: ${res.status}`);
    await writeFile(csvPath, await res.text(), 'utf8');
    manifest.iaea = undefined;
  }

  const lines = (await readFile(csvPath, 'utf8')).split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = parseCsvLine(lines[0]);
  const col = (name) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`IAEA column missing: ${name}`);
    return i;
  };
  const C = {
    z: col('z'),
    n: col('n'),
    symbol: col('symbol'),
    abundance: col('abundance'),
    halfLife: col('half_life'),
    operator: col('operator_hl'),
    halfLifeSec: col('half_life_sec'),
    decay: col('decay_1'),
    decayPct: col('decay_1_%'),
    jp: col('jp'),
    mass: col('atomic_mass'),
    systematics: col('me_systematics'),
    extraction: col('Extraction_date'),
  };

  const rows = [];
  let extractionDate = '';
  for (const line of lines.slice(1)) {
    const f = parseCsvLine(line);
    const z = num(f[C.z]);
    const n = num(f[C.n]);
    if (z === null || n === null || z < 1 || z > 118) continue;
    extractionDate ||= f[C.extraction].trim();

    const halfLifeText = f[C.halfLife].trim();
    const stable = halfLifeText.toUpperCase() === 'STABLE';
    const halfLifeSec = stable ? null : num(f[C.halfLifeSec]);
    const stability = stable ? 'S' : halfLifeSec !== null ? 'R' : 'U';
    const massMicroU = num(f[C.mass]);

    rows.push([
      z,
      n,
      massMicroU === null ? null : massMicroU / 1e6,
      f[C.systematics].trim().toUpperCase() === 'Y' ? 1 : 0,
      num(f[C.abundance]),
      halfLifeSec,
      stability,
      stable ? '' : f[C.operator].trim().toUpperCase(),
      f[C.decay].trim(),
      num(f[C.decayPct]),
      f[C.jp].trim(),
    ]);
  }
  rows.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const covered = new Set(rows.map((r) => r[0]));
  for (let z = 1; z <= 118; z++) if (!covered.has(z)) throw new Error(`no isotopes for Z=${z}`);

  manifest.iaea = {
    url: IAEA_URL,
    retrieved: manifest.iaea?.retrieved ?? new Date().toISOString().slice(0, 10),
    datasetExtractionDate: extractionDate,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const source = {
    source: 'IAEA Nuclear Data Section, Live Chart of Nuclides (ground states)',
    url: 'https://www-nds.iaea.org/livechart/',
    retrieved: manifest.iaea.retrieved,
    version: `dataset extraction ${extractionDate}`,
    notes:
      'Half-lives, decay modes, spins and isotopic abundances from ENSDF (April 2022 snapshot); atomic masses from the AME2020 atomic mass evaluation; see NUBASE2020.',
    citations: [
      {
        title: 'Live Chart of Nuclides: nuclear structure and decay data',
        source: 'International Atomic Energy Agency, Nuclear Data Section',
        url: 'https://www-nds.iaea.org/livechart/',
      },
      {
        authors: 'M. Wang, W. J. Huang, F. G. Kondev, G. Audi, S. Naimi',
        title: 'The AME 2020 atomic mass evaluation (II). Tables, graphs and references',
        source: 'Chinese Physics C 45, 030003',
        year: 2021,
        doi: '10.1088/1674-1137/abddaf',
      },
      {
        authors: 'F. G. Kondev, M. Wang, W. J. Huang, S. Naimi, G. Audi',
        title: 'The NUBASE2020 evaluation of nuclear physics properties',
        source: 'Chinese Physics C 45, 030001',
        year: 2021,
        doi: '10.1088/1674-1137/abddae',
      },
    ],
  };

  const ts = [
    '// AUTO-GENERATED by tools/data/build-isotopes.mjs. Do not edit by hand; re-run the script instead.',
    "import type { Provenance } from '../provenance';",
    "import type { IsotopeRow } from './types';",
    '',
    `export const ISOTOPE_DATA_SOURCE: Provenance = ${JSON.stringify(source, null, 2)};`,
    '',
    '// [z, n, mass(u)|null, massFromSystematics, abundance(%)|null, halfLife(s)|null, stability, halfLifeLimit, decayMode, decay(%)|null, spinParity]',
    'export const ISOTOPE_ROWS: readonly IsotopeRow[] = [',
    ...rows.map((r) => `  ${JSON.stringify(r)},`),
    '];',
    '',
  ];
  await writeFile(tsOutPath, ts.join('\n'), 'utf8');

  await mkdir(generatedDir, { recursive: true });
  const columns = [
    'z',
    'n',
    'mass_u',
    'mass_from_systematics',
    'abundance_percent',
    'half_life_seconds',
    'stability',
    'half_life_limit',
    'decay_mode',
    'decay_percent',
    'spin_parity',
  ];
  await writeFile(join(generatedDir, 'isotopes.json'), JSON.stringify({ source, columns, rows }), 'utf8');

  const stable = rows.filter((r) => r[6] === 'S').length;
  console.log(`wrote ${rows.length} nuclides (${stable} stable) to ${tsOutPath} and tools/data/generated/isotopes.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
