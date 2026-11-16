// Builds packages/core/src/elements/elements.generated.ts from committed source snapshots.
//
//   node tools/data/build-elements.mjs           rebuild from the snapshots in tools/data/sources
//   node tools/data/build-elements.mjs --fetch   refresh the PubChem snapshot first
//
// Sources
//   - PubChem Periodic Table (NCBI/NLM): names, atomic weights, colours, configurations, bulk properties.
//   - RDKit PeriodicTable (see dump_rdkit_periodic_table.py): covalent radii, valence model, common isotopes.
// Nothing in the output is typed in by hand except the two documented colour fallbacks below.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sourcesDir = join(here, 'sources');
const pubchemPath = join(sourcesDir, 'pubchem-periodic-table.json');
const rdkitPath = join(sourcesDir, 'rdkit-periodic-table.json');
const manifestPath = join(sourcesDir, 'manifest.json');
const outPath = join(here, '..', '..', 'packages', 'core', 'src', 'elements', 'elements.generated.ts');

const PUBCHEM_URL = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug/periodictable/JSON';

// PubChem lists no colour for erbium; Jmol's element colour table (the convention PubChem's other
// values follow) defines it. Elements 110-118 have no conventional colour at all.
const JMOL_COLOR_OVERRIDES = { 68: '00E675' };
const FALLBACK_COLOR = '8D96AB';

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function loadManifest() {
  try {
    return await readJson(manifestPath);
  } catch {
    return {};
  }
}

function tablePosition(z) {
  const starts = [1, 3, 11, 19, 37, 55, 87, 119];
  let period = 1;
  while (z >= starts[period]) period++;
  const idx = z - starts[period - 1];
  const len = starts[period] - starts[period - 1];

  let group = null;
  let block;
  if (len === 2) {
    group = idx === 0 ? 1 : 18;
    block = 's';
  } else if (len === 8) {
    group = idx < 2 ? idx + 1 : idx + 11;
    block = idx < 2 ? 's' : 'p';
  } else if (len === 18) {
    group = idx + 1;
    block = idx < 2 ? 's' : idx < 12 ? 'd' : 'p';
  } else if (idx < 2) {
    group = idx + 1;
    block = 's';
  } else if (idx <= 16) {
    // The 15-member lanthanide/actinide series as drawn on the IUPAC table; no group number is assigned.
    block = 'f';
  } else {
    group = idx - 13;
    block = group <= 12 ? 'd' : 'p';
  }

  const inSeries = group === null;
  return {
    period,
    group,
    block,
    tableRow: inSeries ? period + 3 : period,
    tableColumn: inSeries ? idx + 1 : group,
  };
}

const num = (s) => (s === '' || s === undefined ? null : Number(s));

function parseOxidationStates(s) {
  if (!s) return [];
  return s
    .split(',')
    .map((t) => Number(t.trim()))
    .filter((n) => Number.isFinite(n));
}

function normaliseConfiguration(raw) {
  const predicted = /\(predicted\)/i.test(raw);
  const text = raw
    .replace(/\(predicted\)/i, '')
    .replace(/\]/, '] ')
    .replace(/\s+/g, ' ')
    .trim();
  return { text, predicted };
}

function build(pubchem, rdkit) {
  const cols = pubchem.Table.Columns.Column;
  const col = (name) => {
    const i = cols.indexOf(name);
    if (i < 0) throw new Error(`PubChem column missing: ${name}`);
    return i;
  };
  const rows = pubchem.Table.Row.map((r) => r.Cell);
  if (rows.length !== 118) throw new Error(`expected 118 PubChem rows, got ${rows.length}`);
  if (rdkit.elements.length !== 118) throw new Error('expected 118 RDKit rows');

  return rows.map((cell, i) => {
    const z = Number(cell[col('AtomicNumber')]);
    const rd = rdkit.elements[i];
    if (z !== i + 1 || rd.z !== z) throw new Error(`row order mismatch at index ${i}`);
    const symbol = cell[col('Symbol')];
    if (rd.symbol !== symbol) throw new Error(`symbol mismatch for Z=${z}: ${symbol} vs ${rd.symbol}`);

    const config = normaliseConfiguration(cell[col('ElectronConfiguration')]);
    const stateRaw = cell[col('StandardState')];
    const statePredicted = /^Expected to be/i.test(stateRaw);
    const state = stateRaw.replace(/^Expected to be an? /i, '').toLowerCase();

    // PubChem serialises all-digit hex colours as numbers, which drops leading zeros
    // (palladium's 006985 arrives as "6985"), so restore the six-digit form.
    const pubchemColor = cell[col('CPKHexColor')];
    let color = pubchemColor ? pubchemColor.padStart(6, '0') : pubchemColor;
    let colorSource = 'pubchem';
    if (!color) {
      if (JMOL_COLOR_OVERRIDES[z]) {
        color = JMOL_COLOR_OVERRIDES[z];
        colorSource = 'jmol';
      } else {
        color = FALLBACK_COLOR;
        colorSource = 'fallback';
      }
    }

    const pubchemVdwPm = num(cell[col('AtomicRadius')]);
    const year = cell[col('YearDiscovered')];
    const valences = rd.valenceList.filter((v) => v >= 0);

    return {
      z,
      symbol,
      name: cell[col('Name')],
      atomicWeight: Number(cell[col('AtomicWeight')]),
      ...tablePosition(z),
      category: cell[col('GroupBlock')].toLowerCase().replace(/\s+/g, '-'),
      standardState: state,
      standardStatePredicted: statePredicted,
      electronConfiguration: config.text,
      electronConfigurationPredicted: config.predicted,
      electronegativityPauling: num(cell[col('Electronegativity')]),
      ionizationEnergyEv: num(cell[col('IonizationEnergy')]),
      electronAffinityEv: num(cell[col('ElectronAffinity')]),
      oxidationStates: parseOxidationStates(cell[col('OxidationStates')]),
      meltingPointK: num(cell[col('MeltingPoint')]),
      boilingPointK: num(cell[col('BoilingPoint')]),
      densityGPerCm3: num(cell[col('Density')]),
      yearDiscovered: year === 'Ancient' ? 'ancient' : Number(year),
      covalentRadius: rd.covalentRadius,
      vdwRadius: pubchemVdwPm !== null ? pubchemVdwPm / 100 : rd.vdwRadius,
      vdwRadiusSource: pubchemVdwPm !== null ? 'pubchem' : 'rdkit',
      color: `#${color.toUpperCase()}`,
      colorSource,
      valences,
      valenceUnconstrained: rd.valenceList.includes(-1),
      outerElectrons: rd.outerElectrons,
      mostCommonIsotope: rd.mostCommonIsotope,
      mostCommonIsotopeMass: rd.mostCommonIsotopeMass,
    };
  });
}

async function main() {
  const manifest = await loadManifest();
  if (process.argv.includes('--fetch') || !manifest.pubchem) {
    const res = await fetch(PUBCHEM_URL);
    if (!res.ok) throw new Error(`PubChem request failed: ${res.status}`);
    const text = await res.text();
    JSON.parse(text);
    await writeFile(pubchemPath, text, 'utf8');
    manifest.pubchem = { url: PUBCHEM_URL, retrieved: new Date().toISOString().slice(0, 10) };
  }

  const pubchem = await readJson(pubchemPath);
  const rdkit = await readJson(rdkitPath);
  manifest.rdkit = { version: rdkit.rdkitVersion, generated: rdkit.generated.slice(0, 10) };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const elements = build(pubchem, rdkit);
  const sources = [
    {
      id: 'pubchem-periodic-table',
      title: 'PubChem Periodic Table',
      publisher: 'National Center for Biotechnology Information, U.S. National Library of Medicine',
      url: 'https://pubchem.ncbi.nlm.nih.gov/periodic-table/',
      retrieved: manifest.pubchem.retrieved,
      license: 'U.S. Government work; see NCBI data usage policies',
      fields:
        'name, atomicWeight, category, standardState, electronConfiguration, electronegativityPauling, ionizationEnergyEv, electronAffinityEv, oxidationStates, meltingPointK, boilingPointK, densityGPerCm3, yearDiscovered, vdwRadius (where listed), color (where listed)',
    },
    {
      id: 'rdkit-periodic-table',
      title: 'RDKit PeriodicTable',
      publisher: 'RDKit: Open-source cheminformatics',
      url: 'https://www.rdkit.org',
      version: rdkit.rdkitVersion,
      retrieved: manifest.rdkit.generated,
      license: 'BSD-3-Clause',
      fields:
        'covalentRadius, valences, valenceUnconstrained, outerElectrons, mostCommonIsotope, mostCommonIsotopeMass, vdwRadius (fallback where PubChem lists none)',
    },
    {
      id: 'jmol-element-colors',
      title: 'Jmol element colour table',
      publisher: 'Jmol project',
      url: 'https://jmol.sourceforge.net/jscolors/',
      fields: 'color for erbium only (PubChem lists none)',
    },
  ];

  const lines = [
    '// AUTO-GENERATED by tools/data/build-elements.mjs. Do not edit by hand; re-run the script instead.',
    "import type { ElementInfo, ElementDataSource } from './types';",
    '',
    `export const ELEMENT_DATA_SOURCES: readonly ElementDataSource[] = ${JSON.stringify(sources, null, 2)};`,
    '',
    '/** Colour used for elements without a conventional colour (Z = 110-118). */',
    `export const FALLBACK_ELEMENT_COLOR = '#${FALLBACK_COLOR}';`,
    '',
    'export const ELEMENT_RECORDS: readonly ElementInfo[] = [',
    ...elements.map((e) => `  ${JSON.stringify(e)},`),
    '];',
    '',
  ];
  await writeFile(outPath, lines.join('\n'), 'utf8');

  // The same table as JSON, for consumers that cannot import TypeScript (the science service seeds from it).
  const generatedDir = join(here, 'generated');
  await mkdir(generatedDir, { recursive: true });
  await writeFile(join(generatedDir, 'elements.json'), JSON.stringify({ sources, elements }, null, 1), 'utf8');

  console.log(`wrote ${outPath} and tools/data/generated/elements.json (${elements.length} elements)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
