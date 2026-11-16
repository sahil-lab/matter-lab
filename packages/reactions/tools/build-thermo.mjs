// Builds src/data/thermo.generated.ts from the committed source snapshots.
//
//   node packages/reactions/tools/build-thermo.mjs           write src/data/thermo.generated.ts
//   node packages/reactions/tools/build-thermo.mjs --check   only verify that the committed file is up to date
//
// Sources (see data/sources/manifest.json for URLs, retrieval times and hashes):
//   - data/sources/codata/key1.html           CODATA Key Values for Thermodynamics, the complete table
//   - data/sources/webbook/*.excerpt.html     NIST Chemistry WebBook, one excerpt per species page
// No number is typed in by hand: every value below is read from those files, and the script stops if a
// page does not look the way it expects (missing column, unexpected unit, unknown row, formula mismatch).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  generatedDir,
  htmlToText,
  isoDate,
  longDate,
  manifestEntry,
  parseValueWithUncertainty,
  readManifest,
  sameComposition,
  sha256,
  sourcesDir,
} from './lib/common.mjs';
import { CODATA_NAMES, CODATA_SKIPPED, WEBBOOK_SPECIES } from './lib/selection.mjs';
import { PHASE_WORD, compilerInitials, compilers, dataRows, pageIdentity, parseReference, referenceFragment, thermoRows } from './lib/webbook.mjs';

const TOOL = 'packages/reactions/tools/build-thermo.mjs';
const DELTA = '\u0394';
const DEGREE = '\u00b0';

const citations = new Map();
const pages = new Map();

/** Registers a retrieved page under its manifest id and returns the id. */
function pageKey(entry, snapshot) {
  pages.set(entry.id, { url: entry.url, retrieved: isoDate(entry.retrievedAt), snapshot, sha256: entry.sha256 });
  return entry.id;
}

const referenceCitation = (ref) => {
  let source = ref.source;
  if (!source && ref.title && ref.text.includes(ref.title)) {
    // Reports and the like have no journal or publisher field; keep what the WebBook prints after the title.
    source = ref.text.slice(ref.text.indexOf(ref.title) + ref.title.length).replace(/^[\s,]+/, '').replace(/\.$/, '') || undefined;
  }
  return { authors: ref.authors, title: ref.title ?? ref.text, source, year: ref.year, doi: ref.doi, text: ref.text };
};

/** Registers a citation under a readable key and returns the key; identical citations share one key. */
function citationKey(preferredKey, citation) {
  const clean = Object.fromEntries(Object.entries(citation).filter(([, v]) => v !== undefined && v !== ''));
  const body = JSON.stringify(clean);
  let key = preferredKey;
  for (let n = 2; citations.has(key) && JSON.stringify(citations.get(key)) !== body; n++) key = `${preferredKey}-${n}`;
  citations.set(key, clean);
  return key;
}

const slug = (text) =>
  text
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');

// ---------------------------------------------------------------------------------------------------
// CODATA Key Values
// ---------------------------------------------------------------------------------------------------

function codataFormula(cellHtml, state) {
  const sup = [...cellHtml.matchAll(/<SUP>([\s\S]*?)<\/SUP>/gi)].map((m) => htmlToText(m[1]).replace(/\s+/g, ''));
  let body = htmlToText(cellHtml.replace(/<SUP>[\s\S]*?<\/SUP>/gi, '')).replace(/\s+/g, '');
  let chargeText = sup.join('');
  if (!chargeText && state.startsWith('aq') && /[+-]$/.test(body)) {
    // One row ("HS-") prints the charge on the line instead of as a superscript.
    chargeText = body.slice(-1);
    body = body.slice(0, -1);
  }
  const m = /^([+-])(\d*)$/.exec(chargeText);
  if (chargeText && !m) throw new Error(`CODATA: cannot read the charge "${chargeText}" of ${htmlToText(cellHtml)}`);
  const magnitude = m ? (m[2] ? Number(m[2]) : 1) : 0;
  const formula = !m ? body : magnitude === 1 ? `${body}${m[1]}` : `${body}^${magnitude}${m[1]}`;
  return { formula, printed: `${body}${chargeText}` };
}

function codataState(stateText) {
  const [kind, ...rest] = stateText.split(',');
  const phase = { cr: 's', l: 'l', g: 'g', aq: 'aq' }[kind.trim()];
  if (!phase) throw new Error(`CODATA: unknown state "${stateText}"`);
  const detail = rest.join(',').trim();
  return { phase, stateDetail: detail === 'undissoc.' ? 'undissociated' : detail || undefined };
}

function codataValue(cellHtml, citationKeys) {
  const text = htmlToText(cellHtml);
  if (text === '') return null;
  const parsed = parseValueWithUncertainty(text);
  if (parsed.uncertainty === undefined) {
    if (parsed.value !== 0) throw new Error(`CODATA: value "${text}" has no uncertainty but is not the conventional zero`);
    return { value: 0, exact: true, asPrinted: parsed.text, citationKeys };
  }
  return { value: parsed.value, uncertainty: parsed.uncertainty, asPrinted: parsed.text, citationKeys };
}

async function buildCodata(manifest) {
  const entry = manifestEntry(manifest, 'codata-key-values');
  const bytes = await readFile(join(sourcesDir, entry.file));
  if (sha256(bytes) !== entry.sha256) throw new Error('codata/key1.html does not match the SHA-256 in manifest.json');
  const html = bytes.toString('latin1'); // the page declares charset=iso-8859-1

  const refMatch = /<P class="style3"><I>([\s\S]*?)<\/I>,([\s\S]*?)<\/P>/.exec(html);
  if (!refMatch) throw new Error('CODATA: reference paragraph not found');
  const refRest = htmlToText(refMatch[2]).replace(/\.$/, '').split(',').map((s) => s.trim());
  if (refRest.length !== 4 || !/^\d{4}$/.test(refRest[3])) throw new Error(`CODATA: unexpected reference "${htmlToText(refMatch[0])}"`);
  const key = citationKey('cox-wagman-medvedev-1989', {
    authors: htmlToText(refMatch[1]).replace(/,$/, ''),
    title: refRest[0],
    source: `${refRest[1]}, ${refRest[2]}`,
    year: Number(refRest[3]),
    text: htmlToText(refMatch[0]),
  });
  const page = pageKey(entry, entry.file);

  const pageText = htmlToText(html.slice(html.indexOf('CODATA KEY'), html.indexOf('<TABLE bgcolor')));
  const quote = (re) => {
    const m = re.exec(pageText);
    if (!m) throw new Error(`CODATA: sentence not found: ${re}`);
    return m[0].trim();
  };
  const statements = [
    quote(/The table includes the standard enthalpy of formation at 298\.15 K, the entropy at 298\.15 K, and the quantity H \u00b0 \(298\.15 K\)-H \u00b0\(0\)\./),
    quote(/A value of 0 in theDfH \u00b0 column for an element indicates the reference state for that element\./),
    quote(/The standard state pressure is 100000 Pa \(1 bar\)\./),
    quote(/The values given in this table represent the consensus judgement of an international group of experts\. While we believe there is a high probability that the true values fall within the stated uncertainty limits, CODATA cannot assume responsibility for any consequences of the use of these data\./),
  ];

  const tableStart = html.indexOf('<TABLE bgcolor');
  const table = html.slice(tableStart, html.indexOf('</TABLE>', tableStart));
  const rows = [...table.matchAll(/<TR[^>]*>([\s\S]*?)<\/TR>/gi)].map((m) => [...m[1].matchAll(/<TD[^>]*>([\s\S]*?)<\/TD>/gi)].map((c) => c[1]));
  const headings = rows[0].map(htmlToText);
  const units = rows[1].map(htmlToText);
  const expectHeadings = ['Substance', 'State', `DfH ${DEGREE} (298.15 K)`, `S ${DEGREE} (298.15 K)`, `H ${DEGREE} (298.15 K)-H ${DEGREE} (0)`];
  const expectUnits = ['', '', 'kJ mol-1', 'J K-1 mol-1', 'kJ mol-1'];
  if (JSON.stringify(headings) !== JSON.stringify(expectHeadings)) throw new Error(`CODATA: unexpected column headings ${JSON.stringify(headings)}`);
  if (JSON.stringify(units) !== JSON.stringify(expectUnits)) throw new Error(`CODATA: unexpected units ${JSON.stringify(units)}`);

  const records = [];
  const skipped = [];
  const unusedNames = new Set(Object.keys(CODATA_NAMES));
  for (const cells of rows.slice(2)) {
    if (cells.length !== 5) throw new Error('CODATA: a table row does not have five cells');
    if (cells.every((c) => htmlToText(c) === '')) continue;
    const state = htmlToText(cells[1]);
    const { formula, printed } = codataFormula(cells[0], state);
    const printedAs = `${htmlToText(cells[0])} | ${state}`;
    const nameKey = `${printed} | ${state}`;
    const skipKey = Object.keys(CODATA_SKIPPED).find((k) => k.replace(/\s+/g, '') === printedAs.replace(/\s+/g, ''));
    if (skipKey) {
      skipped.push({ printedAs, reason: CODATA_SKIPPED[skipKey] });
      continue;
    }
    const name = CODATA_NAMES[nameKey];
    if (!name) throw new Error(`CODATA: no name configured for row "${nameKey}"`);
    unusedNames.delete(nameKey);
    const { phase, stateDetail } = codataState(state);
    records.push({
      id: `${formula}(${phase})`,
      name,
      formula,
      phase,
      ...(stateDetail ? { stateDetail } : {}),
      source: 'codata-key-values',
      page,
      printedAs,
      deltaHf298: codataValue(cells[2], [key]),
      s298: codataValue(cells[3], [key]),
    });
  }
  if (unusedNames.size) throw new Error(`CODATA: names configured for rows that are not in the table: ${[...unusedNames].join('; ')}`);

  const source = {
    id: 'codata-key-values',
    name: htmlToText(/<p class="style17">([\s\S]*?)<\/p>/.exec(html)?.[1] ?? ''),
    url: entry.url,
    retrieved: isoDate(entry.retrievedAt),
    citationKey: key,
    statements,
  };
  if (source.name !== 'CODATA KEY VALUES FOR THERMODYNAMICS') throw new Error(`CODATA: unexpected page heading "${source.name}"`);
  return { source, records, skipped };
}

// ---------------------------------------------------------------------------------------------------
// NIST Chemistry WebBook
// ---------------------------------------------------------------------------------------------------

async function readExcerpt(manifest, id) {
  const entry = manifestEntry(manifest, id);
  if (!entry.excerpt) throw new Error(`${id} has no excerpt; run excerpt-webbook.mjs first`);
  const bytes = await readFile(join(sourcesDir, entry.excerpt.file));
  if (sha256(bytes) !== entry.excerpt.sha256) throw new Error(`${entry.excerpt.file} does not match the SHA-256 in manifest.json`);
  return { entry, html: bytes.toString('utf8') };
}

async function webbookCitationTools(manifest) {
  const guide = await readExcerpt(manifest, 'webbook-citation-guide');
  const front = await readExcerpt(manifest, 'webbook-front-page');

  // "To cite the entire web site ...": editors, <strong>title</strong>, publisher, DOI link.
  const paragraphs = [...guide.html.matchAll(/<p class="indented">([\s\S]*?)<\/p>/g)].map((m) => m[1]);
  const site = paragraphs.find((p) => /^\s*P\.J\. Linstrom and W\.G\. Mallard, Eds\.,/.test(p));
  if (!site) throw new Error('WebBook citation guide: site citation not found');
  const m = /^\s*([\s\S]*?),\s*<strong>([\s\S]*?)<\/strong>,\s*([\s\S]*?),\s*<a href="https:\/\/doi\.org\/([^"]+)"/.exec(site);
  if (!m) throw new Error('WebBook citation guide: cannot split the site citation');
  const book = { title: htmlToText(m[2]), publisher: htmlToText(m[3]), doi: m[4], editors: htmlToText(m[1]) };
  const chapters = [...guide.html.matchAll(/<li>"([^"]+)" by ([^<]*)<\/li>/g)].map((c) => ({ title: c[1], authors: htmlToText(c[2]) }));

  const version = htmlToText(/Last update to data:[\s\S]*?<\/span>/.exec(front.html)?.[0] ?? '').replace(/^Last update to data:\s*/, '');
  if (!/^\d{4}$/.test(version)) throw new Error(`WebBook front page: cannot read the year of the last data update ("${version}")`);
  const dbName = `${htmlToText(/<h1 class="no-handheld">([\s\S]*?)<\/h1>/.exec(front.html)?.[1] ?? '')}, ${htmlToText(/<h2>([\s\S]*?)<\/h2>/.exec(front.html)?.[1] ?? '').replace(/\s*SRD\s*/, ' ')}`;

  // Both citation forms follow the wording of the WebBook's citation guide, with the date of retrieval filled in.
  const siteKey = (retrievedAt) =>
    citationKey('nist-webbook', {
      authors: book.editors,
      title: book.title,
      source: `${book.publisher} (retrieved ${longDate(retrievedAt)})`,
      doi: book.doi,
      url: `https://doi.org/${book.doi}`,
      text: `${book.editors}, ${book.title}, ${book.publisher}, https://doi.org/${book.doi}, (retrieved ${longDate(retrievedAt)}).`,
    });
  const chapterKey = (initials, compilerName, retrievedAt) => {
    const chapter = chapters.find((c) => c.authors === compilerName);
    if (!chapter) throw new Error(`WebBook citation guide: no chapter by "${compilerName}"`);
    return citationKey(`nist-webbook-${initials.toLowerCase()}`, {
      authors: chapter.authors,
      title: chapter.title,
      source: `in ${book.title}, Eds. P.J. Linstrom and W.G. Mallard, ${book.publisher} (retrieved ${longDate(retrievedAt)})`,
      doi: book.doi,
      url: `https://doi.org/${book.doi}`,
      text: `${chapter.authors}, "${chapter.title}" in ${book.title}, Eds. P.J. Linstrom and W.G. Mallard, ${book.publisher}, https://doi.org/${book.doi}, (retrieved ${longDate(retrievedAt)}).`,
    });
  };
  if (!book.editors.startsWith('P.J. Linstrom and W.G. Mallard')) throw new Error('WebBook citation guide: unexpected editors');
  return { siteKey, chapterKey, version, dbName, front: front.entry, book };
}

async function buildWebbook(manifest) {
  const cite = await webbookCitationTools(manifest);
  const records = [];
  const retrievedDates = [];
  let license;

  for (const species of WEBBOOK_SPECIES) {
    const { entry, html } = await readExcerpt(manifest, `webbook-${species.page}`);
    retrievedDates.push(entry.retrievedAt);
    const identity = pageIdentity(html);
    if (!sameComposition(species.formula, identity.formula)) {
      throw new Error(`WebBook ${species.page}: configured formula ${species.formula} does not match the page formula ${identity.formula}`);
    }
    const notice = htmlToText(/<p class="section-head"><strong>\s*Data compilation[\s\S]*?<\/strong><\/p>/.exec(html)?.[0] ?? '');
    if (!/^Data compilation copyright by the U\.S\. Secretary of Commerce on behalf of the U\.S\.A\. All rights reserved\.$/.test(notice)) {
      throw new Error(`WebBook ${species.page}: unexpected rights notice "${notice}"`);
    }
    license = notice;
    const known = compilers(html);
    const rows = thermoRows(html);

    const valueRecord = async (row, phase) => {
      const parsed = parseValueWithUncertainty(row.valueText);
      const keys = [];
      let individualPoints;
      let individualPointsPage;
      if (row.refIds.length) {
        for (const refId of row.refIds) {
          const ref = parseReference(referenceFragment(html, refId));
          keys.push(citationKey(slug(ref.label), referenceCitation(ref)));
        }
      } else {
        // An average computed by the WebBook: cite the determinations it averaged.
        const points = species.individualPoints?.[phase];
        if (row.method !== 'AVG' || !points) throw new Error(`WebBook ${species.page}: row "${row.label}" cites no reference and is not a configured average`);
        const pointsPage = await readExcerpt(manifest, points.id);
        pageKey(pointsPage.entry, pointsPage.entry.excerpt.file);
        const expectedHref = new URL(row.individualPointsHref.replace(/&amp;/g, '&'), entry.url).href;
        if (expectedHref !== pointsPage.entry.url) throw new Error(`WebBook ${species.page}: the individual data points page is ${expectedHref}, not ${pointsPage.entry.url}`);
        const pointRows = dataRows(pointsPage.html).filter((r) => r.cells.length === 4);
        const count = Number(/^Average of (\d+) values/.exec(row.comment)?.[1]);
        if (pointRows.length !== count) throw new Error(`WebBook ${species.page}: expected ${count} individual data points, found ${pointRows.length}`);
        individualPoints = pointRows.map((r) => ({ asPrinted: r.text[0], method: r.text[1], reference: r.text[2] }));
        individualPointsPage = pointsPage.entry.id;
        const pointCompilers = compilers(pointsPage.html);
        const usedInitials = new Set();
        for (const r of pointRows) {
          for (const refId of [...r.cells[2].matchAll(/href="#(ref-\d+)"/g)].map((x) => x[1])) {
            const ref = parseReference(referenceFragment(pointsPage.html, refId));
            keys.push(citationKey(slug(ref.label), referenceCitation(ref)));
          }
          for (const initials of compilerInitials(r.text[3], pointCompilers)) usedInitials.add(initials);
        }
        for (const initials of usedInitials) keys.push(cite.chapterKey(initials, pointCompilers[initials], pointsPage.entry.retrievedAt));
      }
      const credited = compilerInitials(row.comment, known);
      for (const initials of credited) keys.push(cite.chapterKey(initials, known[initials], entry.retrievedAt));
      if (!keys.some((k) => k.startsWith('nist-webbook'))) keys.push(cite.siteKey(entry.retrievedAt));
      return {
        value: parsed.value,
        ...(parsed.uncertainty !== undefined ? { uncertainty: parsed.uncertainty } : {}),
        asPrinted: parsed.text,
        label: row.label,
        method: row.method,
        reference: row.reference,
        ...(row.comment ? { comment: row.comment } : {}),
        ...(individualPoints ? { individualPoints, individualPointsPage } : {}),
        citationKeys: [...new Set(keys)],
      };
    };

    const page = pageKey(entry, entry.excerpt.file);
    for (const phase of species.phases) {
      const word = PHASE_WORD[phase];
      const hRow = rows.find((r) => r.label === `${DELTA}fH${DEGREE}${word}`);
      if (!hRow) throw new Error(`WebBook ${species.page}: no enthalpy of formation for the ${word}`);
      if (hRow.units !== 'kJ/mol') throw new Error(`WebBook ${species.page}: unexpected enthalpy unit ${hRow.units}`);
      // Gas entropies must be on the 1 bar standard state used by the CODATA table.
      const sLabels = phase === 'g' ? [`S${DEGREE}gas,1 bar`] : [`S${DEGREE}${word}`, `S${DEGREE}${word},1 bar`];
      const sRow = rows.find((r) => sLabels.includes(r.label));
      if (sRow && sRow.units !== 'J/mol*K') throw new Error(`WebBook ${species.page}: unexpected entropy unit ${sRow.units}`);
      records.push({
        id: `${species.formula}(${phase})`,
        name: species.name,
        formula: species.formula,
        phase,
        source: 'nist-webbook',
        page,
        printedAs: `${identity.title} | ${identity.formula} | CAS ${identity.cas}`,
        deltaHf298: await valueRecord(hRow, phase),
        s298: sRow ? await valueRecord(sRow, phase) : null,
        ...(species.identityNote ? { identityNote: species.identityNote } : {}),
      });
    }
  }

  const earliest = retrievedDates.sort()[0];
  const source = {
    id: 'nist-webbook',
    name: cite.dbName,
    url: `https://doi.org/${cite.book.doi}`,
    retrieved: isoDate(earliest),
    version: `data last updated ${cite.version}`,
    license,
    citationKey: cite.siteKey(earliest),
    statements: [
      'Selection rule used by this package: for each species and phase, the first row the WebBook lists for the enthalpy of formation and for the entropy; gas entropies only from rows labelled "S\u00b0gas,1 bar".',
    ],
  };
  return { source, records };
}

// ---------------------------------------------------------------------------------------------------

function tsArray(name, type, items) {
  return `export const ${name}: readonly ${type}[] = [\n${items.map((item) => `  ${JSON.stringify(item)},`).join('\n')}\n];\n`;
}

async function main() {
  const manifest = await readManifest();
  const codata = await buildCodata(manifest);
  const webbook = await buildWebbook(manifest);
  const records = [...codata.records, ...webbook.records];

  const ids = new Set();
  for (const r of records) {
    if (ids.has(r.id)) throw new Error(`duplicate species id ${r.id}`);
    ids.add(r.id);
  }

  const citationTable = Object.fromEntries([...citations.entries()].sort(([a], [b]) => a.localeCompare(b)));
  const pageTable = Object.fromEntries([...pages.entries()]);
  const out = [
    `// AUTO-GENERATED by ${TOOL} from the snapshots in packages/reactions/data/sources.`,
    '// Do not edit by hand; change the snapshots or the selection in tools/lib/selection.mjs and re-run the script.',
    "import type { SourceCitationRecord, SourcePageRecord, ThermoRecord, ThermoSourceRecord } from './records';",
    '',
    tsArray('THERMO_SOURCE_RECORDS', 'ThermoSourceRecord', [codata.source, webbook.source]),
    `export const THERMO_PAGES: Readonly<Record<string, SourcePageRecord>> = ${JSON.stringify(pageTable, null, 2)};\n`,
    `export const THERMO_CITATIONS: Readonly<Record<string, SourceCitationRecord>> = ${JSON.stringify(citationTable, null, 2)};\n`,
    '/** Rows of the source tables that were deliberately left out, with the reason. */',
    tsArray('THERMO_SKIPPED_ROWS', '{ readonly printedAs: string; readonly reason: string }', codata.skipped),
    tsArray('THERMO_RECORDS', 'ThermoRecord', records),
  ].join('\n');

  await mkdir(generatedDir, { recursive: true });
  const target = join(generatedDir, 'thermo.generated.ts');
  const withEntropy = records.filter((r) => r.s298).length;
  const summary =
    `${records.length} species (${codata.records.length} CODATA, ${webbook.records.length} WebBook), ` +
    `${withEntropy} with entropy, ${citations.size} citations, ${codata.skipped.length} CODATA row(s) skipped`;
  if (process.argv.includes('--check')) {
    // Used by the test suite: the committed file must be exactly what the snapshots produce.
    const existing = await readFile(target, 'utf8').catch(() => '');
    if (existing.replace(/\r\n/g, '\n') !== out) throw new Error('src/data/thermo.generated.ts is not what the source snapshots produce; re-run build-thermo.mjs.');
    console.log(`thermo.generated.ts is up to date: ${summary}`);
    return;
  }
  await writeFile(target, out);
  console.log(`thermo.generated.ts: ${summary}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
