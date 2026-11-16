// Writes the text excerpts of the IUPAC kinetic evaluation (Atmos. Chem. Phys. articles) that the kinetic
// models are built from.
//
//   node packages/reactions/tools/extract-pdf-excerpts.mjs
//
// Input:  the article PDFs and article pages downloaded by fetch-source.mjs --discard into data/.scratch/
//         (untracked), and a pdftotext executable (Xpdf or Poppler). pdftotext is looked for in the
//         PDFTOTEXT environment variable, on PATH, and in Git for Windows (mingw64\bin\pdftotext.exe).
// Output: data/sources/iupac/*.excerpts.txt and their entries in manifest.json.
//
// The articles are licensed CC BY-NC-SA 2.5. To keep that licence from spreading to the rest of the
// repository the PDFs are not stored; only the bibliographic details, the short passages that define the
// conventions, and the "Preferred Values" and "Reliability" blocks of the data sheets actually used are
// kept. The SHA-256 of each PDF stays in the manifest so a fresh download can be compared with it.

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { decodeEntities, manifestEntry, readManifest, scratchDir, sha256, sourcesDir, upsertManifestEntry, writeManifest } from './lib/common.mjs';
import { IUPAC_VOLUMES, KINETIC_SELECTION } from './lib/selection.mjs';

const TOOL = 'packages/reactions/tools/extract-pdf-excerpts.mjs';
const run = promisify(execFile);

async function findPdftotext() {
  const candidates = [process.env.PDFTOTEXT, 'pdftotext', 'C:\\Program Files\\Git\\mingw64\\bin\\pdftotext.exe'].filter(Boolean);
  for (const exe of candidates) {
    try {
      // "-v" prints the version banner on stderr; Xpdf exits with a non-zero status when doing so.
      const { stdout, stderr } = await run(exe, ['-v']).catch((err) => (err.stderr || err.stdout ? err : Promise.reject(err)));
      const banner = `${stderr ?? ''}${stdout ?? ''}`;
      const version = /pdftotext version ([^\s]+)/.exec(banner)?.[1];
      if (version) return { exe, version };
    } catch {
      // try the next candidate
    }
  }
  throw new Error('pdftotext was not found. Set the PDFTOTEXT environment variable to its full path.');
}

async function pdfText(exe, pdfPath, outPath, extraArgs) {
  await run(exe, ['-q', ...extraArgs, '-enc', 'UTF-8', '-eol', 'unix', pdfPath, outPath]);
  return (await readFile(outPath, 'utf8')).split('\f');
}

function metaTags(landingHtml, name) {
  const re = new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"`, 'g');
  const lenient = { lenient: true };
  return [...landingHtml.matchAll(re)].map((m) => decodeEntities(decodeEntities(m[1], lenient), lenient).replace(/<[^>]+>/g, ''));
}

function articleInfo(landingHtml) {
  const one = (name) => {
    const values = metaTags(landingHtml, name);
    if (!values.length) throw new Error(`article page: no ${name} meta tag`);
    return values[0];
  };
  const stripped = landingHtml.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ');
  const text = decodeEntities(stripped, { lenient: true }).replace(/\s+/g, ' ');
  const licence = /\u00a9 Author\(s\) \d{4}\. This work is licensed under the Creative Commons [A-Za-z-]+ [\d.]+ License\./.exec(text)?.[0];
  if (!licence) throw new Error('article page: licence statement not found');
  return {
    authors: metaTags(landingHtml, 'citation_author').filter((a) => !/Subcommittee/i.test(a)),
    title: one('citation_title'),
    journal: one('citation_journal_title'),
    volume: one('citation_volume'),
    firstPage: Number(one('citation_firstpage')),
    lastPage: Number(one('citation_lastpage')),
    year: Number(one('citation_publication_date').slice(0, 4)),
    doi: one('citation_doi'),
    licence,
  };
}

const HEAD_OR_FOOT = /R\. Atkinson et al\.: Evaluated kinetic and photochemical data|Atmos\. Chem\. Phys\., \d+, \d+\u2013\d+, \d{4}|www\.atmos-chem-phys\.(?:org|net)\//;
const SHEET_HEADER = /^(?:I|II)\.A\d\.\d+\s+\S/;

/** Lines of one data sheet, each tagged with its PDF page, from its header line to the next data sheet. */
function dataSheetLines(pages, id) {
  const header = new RegExp(`^${id.replace(/\./g, '\\.')}\\s+\\S`);
  const lines = [];
  let started = false;
  for (let p = 0; p < pages.length; p++) {
    for (const line of pages[p].split('\n')) {
      if (!started) {
        if (header.test(line)) started = true;
        else continue;
      } else if (SHEET_HEADER.test(line) && !header.test(line)) {
        return lines;
      }
      lines.push({ page: p + 1, text: line });
    }
    if (started && lines.length > 2000) break;
  }
  if (!started) throw new Error(`data sheet ${id} not found`);
  return lines;
}

function trimBlank(lines) {
  let a = 0;
  let b = lines.length;
  while (a < b && lines[a].text.trim() === '') a++;
  while (b > a && lines[b - 1].text.trim() === '') b--;
  return lines.slice(a, b);
}

/** Replaces running heads and feet by a bracketed note at each page change. */
function withoutPageFurniture(lines, journalPage) {
  const out = [];
  let previousPage = lines[0]?.page;
  for (const line of lines) {
    if (HEAD_OR_FOOT.test(line.text)) continue;
    if (line.page !== previousPage) {
      while (out.length && out[out.length - 1].trim() === '') out.pop();
      out.push('', `[page break: journal page ${journalPage(previousPage)} -> ${journalPage(line.page)}; running foot and head omitted]`, '');
      previousPage = line.page;
      if (line.text.trim() === '') continue;
    }
    if (line.text.trim() === '' && out.length && out[out.length - 1].startsWith('[page break')) continue;
    out.push(line.text.replace(/\s+$/, ''));
  }
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  return out;
}

function dataSheetExcerpt(pages, id, journalPage, keepComments = []) {
  const lines = dataSheetLines(pages, id);
  const find = (re, from = 0) => {
    const i = lines.findIndex((l, n) => n >= from && re.test(l.text));
    if (i < 0) throw new Error(`data sheet ${id}: no line matching ${re}`);
    return i;
  };
  const rateData = find(/^\s*Rate coef\S*cient data\s*$/);
  const preferred = find(/^\s*Preferred Values\s*$/, rateData);
  const comments = find(/^\s*Comments on Preferred Values\s*$/, preferred);
  const head = trimBlank(lines.slice(0, rateData));
  const block = trimBlank(lines.slice(preferred, comments));
  const kept = keepComments.map(({ from, to }) => {
    const a = find(from, rateData);
    const b = find(to, a);
    if (b >= preferred) throw new Error(`data sheet ${id}: kept comment runs past the rate data section`);
    return lines.slice(a, b + 1);
  });
  const pdfPages = [...new Set([...head, ...kept.flat(), ...block].map((l) => l.page))].sort((x, y) => x - y);
  const journalPages = pdfPages.map(journalPage);
  return [
    `=== DATA SHEET ${id} === (PDF page${pdfPages.length > 1 ? 's' : ''} ${pdfPages.join('-')}, journal page${journalPages.length > 1 ? 's' : ''} ${journalPages.join('-')})`,
    ...withoutPageFurniture(head, journalPage),
    '',
    kept.length
      ? '[... table of rate coefficient data omitted; of the comments on it only the following is kept ...]'
      : '[... table of rate coefficient data and the comments on it omitted ...]',
    '',
    ...kept.flatMap((passage) => [...withoutPageFurniture(passage, journalPage), '']),
    ...(kept.length ? ['[... remaining comments omitted ...]', ''] : []),
    ...withoutPageFurniture(block, journalPage),
    '',
    '[... comments on preferred values and references omitted ...]',
    `=== END ${id} ===`,
  ];
}

/** Guide passages quoted from the reading-order text; each pattern must occur exactly once in the article. */
const GUIDE_QUOTES = [
  {
    label: 'Summary table, footnote a',
    pattern: /a The cited uncertainty is an expanded uncertainty corresponding approximately to a 95% con\S*dence limit\./,
  },
  {
    label: 'Guide to the data sheets, "Conventions concerning rate coefficients" (first sentence)',
    pattern: /All of the reactions in the table are elementary processes\./,
  },
  {
    label: 'Guide to the data sheets, "Conventions concerning rate coefficients" (sentence after the rate expression for A + A -> B + C)',
    pattern: /Note that the stoichiometric coef\S*cient for A, i\.e\. 2, appears in the denominator before the rate of change of \[A\] \(which is equal to 2k\[A\]2\) and as a power on the right-hand side\./,
  },
  {
    label: 'Guide to the data sheets, "Assignment of uncertainties" (first paragraph)',
    pattern: /Under the heading \u201creliability,?\u201d,? estimates have been made of[\s\S]*?expanded uncertainties corresponding approximately to a 95% con\S*dence limit\./,
  },
  {
    label: 'Guide to the data sheets, "Assignment of uncertainties" (sentence introducing the temperature dependence of the uncertainty)',
    pattern: /For second-order rate coef\S*cients listed in this evaluation, an estimate of the uncertainty at any given temperature within the recommended temperature range may be obtained from the equation:/,
  },
  {
    label: 'Guide to the data sheets, "Assignment of uncertainties" (the equation that sentence introduces)',
    pattern: /log k\(T ?\) = log k\(298 K\) \+ 0\.4343 ?\{ ?E\/R ?\(1\/T \u2212 1\/298\) ?\}/,
  },
];

/** Reading-order text of a page as one line, without its running head and foot. */
function flatPage(page) {
  return page
    .split('\n')
    .filter((line) => !HEAD_OR_FOOT.test(line) && !/^\s*\d{4}\s*$/.test(line))
    .join('\n')
    .replace(/-\n(?=[a-z])/g, '')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

function guideExcerpt(readingOrderPages, journalPage) {
  const flat = readingOrderPages.map(flatPage);
  const out = [];
  for (const quote of GUIDE_QUOTES) {
    const hits = [];
    flat.forEach((text, index) => {
      // A passage may run over a page break, so each page is searched together with the next one.
      const window = `${text} ${flat[index + 1] ?? ''}`;
      for (const m of window.matchAll(new RegExp(quote.pattern.source, 'g'))) {
        if (m.index >= text.length) continue; // belongs to the next page; found again there
        hits.push({ page: index + 1, spansNext: m.index + m[0].length > text.length, text: m[0] });
      }
    });
    if (hits.length !== 1) throw new Error(`guide passage "${quote.label}" found ${hits.length} times, expected exactly once`);
    const [hit] = hits;
    const where = hit.spansNext
      ? `PDF pages ${hit.page}-${hit.page + 1}, journal pages ${journalPage(hit.page)}-${journalPage(hit.page + 1)}`
      : `PDF page ${hit.page}, journal page ${journalPage(hit.page)}`;
    out.push(`=== QUOTE === ${quote.label} (${where})`, hit.text, '=== END QUOTE ===', '');
  }
  return out;
}

async function main() {
  const manifest = await readManifest();
  const { exe, version } = await findPdftotext();
  await mkdir(scratchDir, { recursive: true });

  for (const [volume, cfg] of Object.entries(IUPAC_VOLUMES)) {
    const pdfEntry = manifestEntry(manifest, cfg.pdfSourceId);
    const landingEntry = manifestEntry(manifest, cfg.landingSourceId);
    const pdfPath = join(scratchDir, cfg.scratchPdf);
    const pdfBytes = await readFile(pdfPath);
    if (sha256(pdfBytes) !== pdfEntry.sha256) throw new Error(`${cfg.scratchPdf} does not match the SHA-256 recorded for ${cfg.pdfSourceId}; fetch it again.`);
    const landingBytes = await readFile(join(scratchDir, cfg.scratchLanding));
    if (sha256(landingBytes) !== landingEntry.sha256) throw new Error(`${cfg.scratchLanding} does not match the SHA-256 recorded for ${cfg.landingSourceId}; fetch it again.`);
    const info = articleInfo(landingBytes.toString('utf8'));

    const layoutPages = await pdfText(exe, pdfPath, join(scratchDir, cfg.scratchPdf.replace(/\.pdf$/, '.layout.txt')), ['-layout']);
    const readingPages = await pdfText(exe, pdfPath, join(scratchDir, cfg.scratchPdf.replace(/\.pdf$/, '.reading.txt')), []);
    if (layoutPages.length !== readingPages.length) throw new Error('page counts of the two extractions differ');
    // Journal page of a PDF page: the article starts on its first journal page, one journal page per PDF page.
    const journalPage = (pdfPage) => info.firstPage + pdfPage - 1;
    const upperGreek = /[\u0391-\u03a9\u2206]/.test(layoutPages.join(''));

    const sheets = KINETIC_SELECTION.filter((k) => k.volume === volume);
    const body = [
      'EXCERPTS kept as the provenance record for the kinetic models of @matterlab/reactions, taken from:',
      '',
      `  ${info.authors.join(', ')}:`,
      `  ${info.title},`,
      `  ${info.journal}, ${info.volume}, ${info.firstPage}-${info.lastPage}, ${info.year}. ${info.doi}`,
      '',
      `  Article page: ${landingEntry.url} (retrieved ${landingEntry.retrievedAt}, SHA-256 ${landingEntry.sha256}).`,
      `  The article page states: "${info.licence}"`,
      `  PDF: ${pdfEntry.url} (retrieved ${pdfEntry.retrievedAt}, ${pdfEntry.bytes} bytes, SHA-256 ${pdfEntry.sha256}).`,
      '  The PDF itself is not stored in this repository; these excerpts are distributed under the same licence as the article.',
      '',
      `Text extracted with pdftotext ${version}: "-layout" for the data sheets, default reading order for the quoted passages.`,
      'Everything between === markers is extractor output and is otherwise unchanged; the quoted passages have their line',
      'breaks (and end-of-line hyphenation) removed. This header and the notes in [square brackets] are ours.',
      'Extraction artefacts to keep in mind when reading:',
      '  - superscripts and subscripts are flattened, so "1.4\u00d710\u221212" is 1.4 x 10^-12, "1016" after a multiplication sign is 10^16,',
      '    "cm3 molecule\u22121 s\u22121" is cm^3 molecule^-1 s^-1 and "O3" is O with subscript 3;',
      upperGreek
        ? '  - upper-case Greek letters are present in the extracted text.'
        : '  - the extractor emits no upper-case Greek letter anywhere in this article. The capital delta of the PDF is therefore missing:\n' +
          '    "H \u25e6 = ..." under a reaction is its standard enthalpy change, and "log k = \u00b1 ..." and "(E/R) = \u00b1 ..." under "Reliability"\n' +
          '    are the uncertainties of log k and of E/R that the quoted "Assignment of uncertainties" passage defines.',
      '',
      '--- Passages that define the conventions ---',
      '',
      ...guideExcerpt(readingPages, journalPage),
      '--- Data sheets used ---',
      '',
      ...sheets.flatMap((s) => [...dataSheetExcerpt(layoutPages, s.datasheet, journalPage, s.keepComments), '']),
    ];
    const text = body.join('\n').replace(/\n+$/, '\n');
    const target = join(sourcesDir, cfg.excerptFile);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text);
    const bytes = Buffer.from(text, 'utf8');
    upsertManifestEntry(manifest, {
      id: cfg.excerptId,
      derivedFrom: [cfg.pdfSourceId, cfg.landingSourceId],
      file: cfg.excerptFile,
      bytes: bytes.length,
      sha256: sha256(bytes),
      writtenBy: TOOL,
      extractor: `pdftotext ${version}`,
      licence: info.licence,
      dataSheets: sheets.map((s) => s.datasheet),
    });
    console.log(`${cfg.excerptId}: ${cfg.excerptFile} (${bytes.length} bytes; data sheets ${sheets.map((s) => s.datasheet).join(', ')})`);
  }
  await writeManifest(manifest);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
