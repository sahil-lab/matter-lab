// Builds src/data/kinetics.generated.ts from the committed excerpts of the IUPAC kinetic evaluation.
//
//   node packages/reactions/tools/build-kinetics.mjs           write src/data/kinetics.generated.ts
//   node packages/reactions/tools/build-kinetics.mjs --check   only verify that the committed file is up to date
//
// Source: data/sources/iupac/*.excerpts.txt (written by extract-pdf-excerpts.mjs; see manifest.json).
// No number is typed in by hand. Each model's parameters are read from the "Preferred Values" and
// "Reliability" blocks of its data sheet, and the script stops unless
//   - the Arrhenius expression reproduces the preferred k(298 K) printed on the same sheet within 15 %
//     (the two are rounded independently by the evaluators; a misread exponent would be off by orders
//     of magnitude),
//   - the units of k agree with the number of reactant molecules in the reaction, and
//   - the equation configured in tools/lib/selection.mjs has the same atoms on each side as the reaction
//     printed on the data sheet.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { composition, generatedDir, isoDate, manifestEntry, readManifest, sha256, sourcesDir } from './lib/common.mjs';
import { IUPAC_VOLUMES, KINETIC_SELECTION } from './lib/selection.mjs';

const TOOL = 'packages/reactions/tools/build-kinetics.mjs';
const SOURCE_ID = { I: 'iupac-acp-2004-vol1', II: 'iupac-acp-2006-vol2' };

const MINUS = /[\u2212-]/g;
const num = (text) => Number(text.replace(MINUS, '-'));

/** "1.4×10−12" or "1.6 × 1016" (superscripts flattened by the extractor) -> number. */
function scientific(mantissa, exponent) {
  const value = Number(`${mantissa}e${exponent.replace(MINUS, '-')}`);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`cannot read ${mantissa} x 10^${exponent}`);
  return value;
}

const UNITS = [
  { printed: /^cm3 molecule\u22121 s\u22121$/, units: 'cm3 molecule-1 s-1', order: 2 },
  { printed: /^cm6 molecule\u22122 s\u22121$/, units: 'cm6 molecule-2 s-1', order: 3 },
  { printed: /^s\u22121$/, units: 's-1', order: 1 },
];

function readUnits(printed) {
  const hit = UNITS.find((u) => u.printed.test(printed.trim()));
  if (!hit) throw new Error(`unknown units of k: "${printed}"`);
  return hit;
}

/** Atoms on one side of a reaction: sum over terms of coefficient x composition. Third bodies (M) are ignored. */
function sideAtoms(side) {
  const total = {};
  for (const raw of side.split(' + ')) {
    const term = raw.trim().replace(/\s*\(\d\)$/, ''); // "(1)" marks a numbered channel on some sheets
    if (term === 'M') continue;
    const m = /^(\d+)?\s*(.+)$/.exec(term);
    const coefficient = m[1] ? Number(m[1]) : 1;
    const atoms = composition(m[2].replace(/=/g, ''));
    for (const [el, n] of Object.entries(atoms)) total[el] = (total[el] ?? 0) + coefficient * n;
  }
  return total;
}

const sameAtoms = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

function reactantCoefficients(equation) {
  const [left] = equation.split('->');
  return left.split(' + ').map((raw) => {
    const m = /^(\d+)?\s*(\S+)$/.exec(raw.trim());
    return { formula: m[2], coefficient: m[1] ? Number(m[1]) : 1 };
  });
}

function parseDataSheet(excerpt, selection) {
  const id = selection.datasheet;
  const start = excerpt.indexOf(`=== DATA SHEET ${id} ===`);
  const end = excerpt.indexOf(`=== END ${id} ===`);
  if (start < 0 || end < 0) throw new Error(`data sheet ${id} is not in the excerpt file`);
  const lines = excerpt
    .slice(start, end)
    .split('\n')
    .map((l) => l.trim());
  const location = /\(PDF pages? [\d-]+, (journal pages? [\d-]+)\)$/.exec(lines[0])?.[1];
  if (!location) throw new Error(`data sheet ${id}: cannot read its location`);

  const header = lines.find((l) => l.startsWith(`${id} `));
  if (!header) throw new Error(`data sheet ${id}: header line not found`);
  const reactionAsPrinted = header.slice(id.length).trim().replace(/\s+/g, ' ').replace(/\s*\u2192\s*/, ' \u2192 ');
  const [printedLeft, printedRight] = reactionAsPrinted.split(' \u2192 ');
  const [left, right] = selection.equation.split(' -> ');
  if (!sameAtoms(sideAtoms(printedLeft), sideAtoms(left)) || !sameAtoms(sideAtoms(printedRight), sideAtoms(right))) {
    throw new Error(`data sheet ${id}: configured equation "${selection.equation}" does not match the printed reaction "${reactionAsPrinted}"`);
  }

  const enthalpyLine = lines.find((l) => /^H \u25e6 = /.test(l));
  const enthalpy = enthalpyLine ? /^H \u25e6 = ([\u2212-]?\d+(?:\.\d+)?) kJ[ \u00b7]mol\u22121$/.exec(enthalpyLine) : null;
  if (enthalpyLine && !enthalpy) throw new Error(`data sheet ${id}: cannot read "${enthalpyLine}"`);

  const preferredAt = lines.indexOf('Preferred Values');
  const reliabilityAt = lines.indexOf('Reliability');
  if (preferredAt < 0 || reliabilityAt < preferredAt) throw new Error(`data sheet ${id}: Preferred Values / Reliability blocks not found`);
  const preferred = lines.slice(preferredAt + 1, reliabilityAt).filter((l) => l && !l.startsWith('['));
  const reliability = lines.slice(reliabilityAt + 1).filter((l) => l && !l.startsWith('['));

  const NUMBER = String.raw`(\d+(?:\.\d+)?)\s*\u00d7\s*10([\u2212-]?\d+)`;
  const at298 = preferred.map((l) => new RegExp(String.raw`^k\s*=\s*${NUMBER}\s+(.+?)\s+at 298 K( and 1 bar)?\.$`).exec(l)).find(Boolean);
  const arrhenius = preferred
    .map((l) => new RegExp(String.raw`^k\s*=\s*${NUMBER}\s*exp\(([\u2212-]?\d+)\/T ?\)\s+(.+?)\s+over the temperature range (\d+)[\u2013-](\d+) K( at 1 bar)?\.$`).exec(l))
    .find(Boolean);
  if (!at298 || !arrhenius) throw new Error(`data sheet ${id}: cannot read the preferred values:\n${preferred.join('\n')}`);
  if (preferred.length !== 2) throw new Error(`data sheet ${id}: expected exactly two preferred-value lines, found ${preferred.length}`);

  const units = readUnits(arrhenius[4]);
  if (readUnits(at298[3]).units !== units.units) throw new Error(`data sheet ${id}: k(298 K) and the Arrhenius expression have different units`);
  const A = scientific(arrhenius[1], arrhenius[2]);
  // The sheet prints k = A exp(B/T); in the usual form k = A exp(-(E/R)/T) this is E/R = -B.
  const EOverRK = -num(arrhenius[3]);
  const range = [Number(arrhenius[5]), Number(arrhenius[6])];
  const k298 = scientific(at298[1], at298[2]);
  const pressure = arrhenius[7] ? '1 bar' : undefined;
  if (Boolean(at298[4]) !== Boolean(arrhenius[7])) throw new Error(`data sheet ${id}: pressure qualifier differs between the two preferred-value lines`);
  if (!(range[0] < range[1])) throw new Error(`data sheet ${id}: bad temperature range`);

  const computed298 = A * Math.exp(-EOverRK / 298);
  if (Math.abs(computed298 / k298 - 1) > 0.15) {
    throw new Error(`data sheet ${id}: the Arrhenius expression gives ${computed298.toExponential(3)} at 298 K but the sheet prints ${k298.toExponential(3)}`);
  }

  const dLog = reliability.map((l) => /^log k\s*=\s*\u00b1\s*(\d+(?:\.\d+)?) at 298 K\.$/.exec(l)).find(Boolean);
  const dE = reliability.map((l) => /^\(E\/R ?\)\s*=\s*\u00b1\s*(\d+) K\.$/.exec(l)).find(Boolean);
  if (!dLog || !dE) throw new Error(`data sheet ${id}: cannot read the reliability block:\n${reliability.join('\n')}`);

  const reactants = reactantCoefficients(selection.equation);
  const molecularity = reactants.reduce((sum, r) => sum + r.coefficient, 0);
  if (molecularity !== units.order) {
    throw new Error(`data sheet ${id}: units ${units.units} imply order ${units.order}, but the equation has ${molecularity} reactant molecule(s)`);
  }
  for (const formula of [...selection.equation.matchAll(/[A-Z][A-Za-z0-9]*/g)].map((m) => m[0])) {
    if (!(formula in selection.species)) throw new Error(`data sheet ${id}: no name configured for ${formula}`);
  }

  return {
    id: selection.id,
    name: selection.name,
    reactionClass: selection.reactionClass,
    equation: selection.equation,
    speciesNames: selection.species,
    source: SOURCE_ID[selection.volume],
    dataSheet: id,
    location,
    reactionAsPrinted,
    expressionAsPrinted: arrhenius[0],
    A,
    AUnits: units.units,
    EOverRK,
    temperatureRangeK: range,
    overallOrder: units.order,
    k298,
    k298AsPrinted: at298[0],
    deltaLog10K298: Number(dLog[1]),
    deltaEOverRK: Number(dE[1]),
    ...(pressure ? { pressure } : {}),
    ...(enthalpy ? { reactionEnthalpyKJPerMol: num(enthalpy[1]) } : {}),
    ...(selection.extraNotes ? { extraNotes: selection.extraNotes } : {}),
  };
}

function parseSource(excerpt, volume, manifest) {
  const cfg = IUPAC_VOLUMES[volume];
  const excerptEntry = manifestEntry(manifest, cfg.excerptId);
  const pdfEntry = manifestEntry(manifest, cfg.pdfSourceId);
  const landingEntry = manifestEntry(manifest, cfg.landingSourceId);
  const head = excerpt.slice(0, excerpt.indexOf('--- Passages that define the conventions ---')).split('\n');
  const authors = head[2].trim().replace(/:$/, '');
  const title = head[3].trim().replace(/,$/, '');
  const journal = /^(.+?), (\d+), (\d+)-(\d+), (\d{4})\. (https:\/\/doi\.org\/(\S+))$/.exec(head[4].trim());
  if (!journal) throw new Error(`volume ${volume}: cannot read the bibliographic line "${head[4]}"`);
  const statements = [...excerpt.matchAll(/=== QUOTE === (.+) \(((?:PDF pages?) [^)]+)\)\n([\s\S]*?)\n=== END QUOTE ===/g)].map((m) => ({
    label: m[1],
    location: m[2].replace(/^PDF pages? [\d-]+, /, ''),
    text: m[3],
  }));
  if (statements.length !== 6) throw new Error(`volume ${volume}: expected 6 quoted passages, found ${statements.length}`);
  return {
    id: SOURCE_ID[volume],
    citation: {
      authors,
      title,
      source: `${journal[1]} ${journal[2]}, ${journal[3]}-${journal[4]}`,
      year: Number(journal[5]),
      doi: journal[7],
      url: journal[6],
    },
    url: landingEntry.url,
    pdfUrl: pdfEntry.url,
    retrieved: isoDate(pdfEntry.retrievedAt),
    pdfSha256: pdfEntry.sha256,
    license: excerptEntry.licence,
    excerpt: excerptEntry.file,
    excerptSha256: excerptEntry.sha256,
    statements,
  };
}

function tsArray(name, type, items) {
  return `export const ${name}: readonly ${type}[] = [\n${items.map((item) => `  ${JSON.stringify(item)},`).join('\n')}\n];\n`;
}

async function main() {
  const manifest = await readManifest();
  const sources = [];
  const records = [];
  const excerpts = {};
  for (const [volume, cfg] of Object.entries(IUPAC_VOLUMES)) {
    const entry = manifestEntry(manifest, cfg.excerptId);
    const bytes = await readFile(join(sourcesDir, entry.file));
    if (sha256(bytes) !== entry.sha256) throw new Error(`${entry.file} does not match the SHA-256 in manifest.json`);
    excerpts[volume] = bytes.toString('utf8');
    sources.push(parseSource(excerpts[volume], volume, manifest));
  }
  const ids = new Set();
  for (const selection of KINETIC_SELECTION) {
    if (ids.has(selection.id)) throw new Error(`duplicate kinetic model id ${selection.id}`);
    ids.add(selection.id);
    records.push(parseDataSheet(excerpts[selection.volume], selection));
  }

  const out = [
    `// AUTO-GENERATED by ${TOOL} from the excerpts in packages/reactions/data/sources/iupac.`,
    '// Do not edit by hand; change the excerpts or the selection in tools/lib/selection.mjs and re-run the script.',
    "import type { KineticRecord, KineticSourceRecord } from './records';",
    '',
    tsArray('KINETIC_SOURCE_RECORDS', 'KineticSourceRecord', sources),
    tsArray('KINETIC_RECORDS', 'KineticRecord', records),
  ].join('\n');
  await mkdir(generatedDir, { recursive: true });
  const target = join(generatedDir, 'kinetics.generated.ts');
  if (process.argv.includes('--check')) {
    // Used by the test suite: the committed file must be exactly what the excerpts produce.
    const existing = await readFile(target, 'utf8').catch(() => '');
    if (existing.replace(/\r\n/g, '\n') !== out) throw new Error('src/data/kinetics.generated.ts is not what the source excerpts produce; re-run build-kinetics.mjs.');
    console.log(`kinetics.generated.ts is up to date: ${records.length} models from ${sources.length} articles`);
    return;
  }
  await writeFile(target, out);
  console.log(`kinetics.generated.ts: ${records.length} models from ${sources.length} articles`);
  for (const r of records) {
    console.log(`  ${r.dataSheet.padEnd(10)} ${r.equation.padEnd(30)} A=${r.A.toExponential(2)} ${r.AUnits}  E/R=${r.EOverRK} K  ${r.temperatureRangeK.join('-')} K  k298=${r.k298.toExponential(2)}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
