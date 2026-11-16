// Writes the excerpts of the NIST Chemistry WebBook pages that the thermodynamic table is built from.
//
//   node packages/reactions/tools/excerpt-webbook.mjs
//
// Input:  the full pages downloaded by fetch-source.mjs --discard into data/.scratch/webbook/ (untracked).
// Output: data/sources/webbook/<page>.excerpt.html, plus the excerpt's size and SHA-256 in manifest.json.
//
// The WebBook's data compilation is copyrighted, so only the fragments a value is read from are kept:
// the page title, formula and CAS number, the enthalpy-of-formation and entropy rows of the
// thermochemistry tables, the references those rows cite, and the source's own notices. Each fragment
// is copied character for character. The SHA-256 of the complete page stays in the manifest, so anyone
// who re-downloads the page can tell whether it has changed since.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { htmlToText, manifestEntry, readManifest, scratchDir, sha256, sourcesDir, upsertManifestEntry, writeManifest } from './lib/common.mjs';
import { WEBBOOK_SPECIES, WEBBOOK_UNUSED } from './lib/selection.mjs';
import { casFragment, dataRows, formulaFragment, referenceFragment, sectionHtml, thermoRows, titleFragment } from './lib/webbook.mjs';

const TOOL = 'packages/reactions/tools/excerpt-webbook.mjs';

function must(html, re, what) {
  const m = re.exec(html);
  if (!m) throw new Error(`cannot find ${what}`);
  return m[0];
}

const all = (html, re) => [...html.matchAll(re)].map((m) => m[0]);

function headerComment(entry, reproduced) {
  return [
    '<!--',
    '  EXCERPT of a NIST Chemistry WebBook page, kept as the provenance record for values used by @matterlab/reactions.',
    `  Page:       ${entry.url}`,
    `  Retrieved:  ${entry.retrievedAt} (${entry.bytes} bytes, SHA-256 ${entry.sha256})`,
    `  Reproduced: ${reproduced}`,
    '  Every fragment below is copied character for character from the page. Comments like this one, and the',
    '  bare <ul>, <table> and </table> tags that only group fragments, are ours. Everything else on the page is omitted.',
    `  Written by ${TOOL}.`,
    '-->',
  ].join('\n');
}

function noticeFragments(sectionOrPage) {
  // Copyright notice and compiler credits printed at the head of a data section (not the "Go To" navigation).
  return all(sectionOrPage, /<p class="section-head"><strong>(?!Go To:)(?:(?!<\/p>)[\s\S])*<\/p>/g);
}

function notesFragments(html, symbolLabels) {
  const notes = sectionHtml(html, 'Notes') ?? '';
  const symbols = all(notes, /<tr><td class="symbol">(?:(?!<\/tr>)[\s\S])*<\/tr>/g).filter((row) => {
    const symbol = htmlToText((/<td class="symbol">([\s\S]*?)<\/td>/.exec(row) ?? [])[1] ?? '');
    return symbolLabels.has(symbol);
  });
  const out = ['<!-- notes: symbol definitions for the quantities above, database identification, disclaimer and copyright -->', '<h2 id="Notes">Notes</h2>', '<ul>'];
  if (symbols.length) out.push('<table class="symbol_table">', ...symbols, '</table>');
  out.push(must(notes, /<li>Data from NIST Standard Reference Database 69:[\s\S]*?<\/li>/, 'the database identification note'));
  out.push(must(notes, /<li>\s*The National Institute of Standards and Technology \(NIST\)[\s\S]*?<\/li>/, 'the NIST disclaimer'));
  out.push('</ul>');
  out.push(must(html, /<p id="copyright" lang="en">[\s\S]*?<\/p>/, 'the copyright line'));
  out.push(must(html, /<p lang="en">\s*Copyright for NIST Standard Reference Data[\s\S]*?<\/p>/, 'the Standard Reference Data Act line'));
  return out;
}

function referencesFragments(html, refIds) {
  if (!refIds.length) return [];
  const sorted = [...new Set(refIds)].sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));
  return ['<!-- references cited by the rows above -->', '<h2 id="Refs">References</h2>', ...sorted.map((id) => `<p>\n${referenceFragment(html, id)}`)];
}

function speciesExcerpt(html, entry) {
  const parts = [
    headerComment(entry, 'page title, formula and CAS number; enthalpy-of-formation and entropy rows of the thermochemistry tables; the references they cite; the notices.'),
    titleFragment(html),
    '<ul>',
    formulaFragment(html),
    casFragment(html),
    '</ul>',
  ];
  const refIds = [];
  const labels = new Set();
  for (const sectionId of ['Thermo-Gas', 'Thermo-Condensed']) {
    const section = sectionHtml(html, sectionId);
    if (!section) continue;
    const rows = thermoRows(section);
    if (!rows.length) continue;
    parts.push(`<!-- section ${sectionId}: only the rows giving an enthalpy of formation or an entropy -->`);
    parts.push(must(section, /<h2 id="[^"]+">[\s\S]*?<\/h2>/, 'the section heading'));
    parts.push(...noticeFragments(section));
    parts.push('<table class="data" aria-label="One dimensional data">' + must(section, /<tr>\s*<th scope="col">Quantity<\/th>[\s\S]*?<\/tr>/, 'the table header'));
    for (const row of rows) {
      parts.push(row.html);
      refIds.push(...row.refIds, ...row.commentRefIds);
      labels.add(row.label);
    }
    parts.push('</table>');
  }
  if (!labels.size) throw new Error('the page has no enthalpy-of-formation or entropy rows');
  parts.push(...referencesFragments(html, refIds));
  parts.push(...notesFragments(html, labels));
  return parts.join('\n') + '\n';
}

function individualPointsExcerpt(html, entry) {
  const sectionId = (/<h2 id="(HF[A-Z])">/.exec(html) ?? [])[1];
  if (!sectionId) throw new Error('cannot find the individual data points section');
  const section = sectionHtml(html, sectionId);
  const table = must(section, /<table class="data"[\s\S]*?<\/table>/, 'the table of individual data points');
  const refIds = dataRows(table).flatMap((r) => [...r.html.matchAll(/href="#(ref-\d+)"/g)].map((m) => m[1]));
  const parts = [
    headerComment(entry, 'page title, formula and CAS number; the complete table of individual data points; the references it cites; the notices.'),
    titleFragment(html),
    '<ul>',
    formulaFragment(html),
    casFragment(html),
    '</ul>',
    '<!-- the individual determinations behind the averaged value shown on the species page -->',
    must(section, /<h2 id="[^"]+">[\s\S]*?<\/h2>/, 'the section heading'),
    ...noticeFragments(section),
    table,
    ...referencesFragments(html, refIds),
    ...notesFragments(html, new Set()),
  ];
  return parts.join('\n') + '\n';
}

function frontPageExcerpt(html, entry) {
  return (
    [
      headerComment(entry, 'the lines that identify the database: name, Standard Reference Database number, date of the last data update and DOI.'),
      must(html, /<h1 class="no-handheld">NIST Chemistry WebBook<\/h1>/, 'the database name'),
      must(html, /<h2>NIST <span class="no-handheld">Standard Reference Database<\/span>[\s\S]*?<\/h2>/, 'the database number'),
      must(html, /<p aria-hidden="true" class="no-handheld"[^>]*>\s*<span[^>]*>Last update to data:[\s\S]*?<\/p>/, 'the update and DOI line'),
    ].join('\n') + '\n'
  );
}

function citationGuideExcerpt(html, entry, compilerNames) {
  const main = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
  const paragraphs = all(main, /<p(?: class="indented")?>(?:(?!<\/p>)[\s\S])*<\/p>/g);
  const chapters = all(main, /<li>"[^"]+" by [^<]*<\/li>/g).filter((li) => compilerNames.some((name) => li.includes(` by ${name}</li>`)));
  if (chapters.length !== compilerNames.length) throw new Error('could not match every compiler credited on the species pages to a chapter of the citation guide');
  const upToChapterList = paragraphs.findIndex((p) => p.includes('The "chapters" are:'));
  if (upToChapterList < 0) throw new Error('cannot find the chapter list of the citation guide');
  return (
    [
      headerComment(entry, 'the citation instructions; of the list of "chapters", only those whose compilers are credited for values used here.'),
      must(main, /<h2>The proper citation of the NIST WebBook<\/h2>/, 'the guide heading'),
      ...paragraphs.slice(0, upToChapterList + 1),
      '<ul>',
      '<!-- the other entries of the chapter list are omitted -->',
      ...chapters,
      '</ul>',
      ...paragraphs.slice(upToChapterList + 1),
    ].join('\n') + '\n'
  );
}

async function writeExcerpt(manifest, id, scratchFile, excerptFile, build) {
  const entry = manifestEntry(manifest, id);
  const bytes = await readFile(join(scratchDir, scratchFile));
  if (sha256(bytes) !== entry.sha256) throw new Error(`${scratchFile} does not match the SHA-256 recorded for ${id}; fetch it again.`);
  const excerpt = build(bytes.toString('utf8'), entry);
  const target = join(sourcesDir, excerptFile);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, excerpt);
  const excerptBytes = Buffer.from(excerpt, 'utf8');
  const { used: _used, reason: _reason, ...rest } = entry;
  upsertManifestEntry(manifest, { ...rest, excerpt: { file: excerptFile, bytes: excerptBytes.length, sha256: sha256(excerptBytes), writtenBy: TOOL } });
  console.log(`${id}: ${excerptFile} (${excerptBytes.length} bytes, from a ${entry.bytes}-byte page)`);
}

async function main() {
  const manifest = await readManifest();
  const compilerNames = new Set();

  for (const species of WEBBOOK_SPECIES) {
    await writeExcerpt(manifest, `webbook-${species.page}`, `webbook/${species.page}.html`, `webbook/${species.page}.excerpt.html`, (html, entry) => {
      const excerpt = speciesExcerpt(html, entry);
      for (const m of excerpt.matchAll(/<em><a href="\/cgi\/cbook\.cgi\?Contrib=[A-Za-z0-9]+">[^<]*<\/a><\/em> - ([^<]*)/g)) compilerNames.add(htmlToText(m[1]));
      return excerpt;
    });
    for (const points of Object.values(species.individualPoints ?? {})) {
      await writeExcerpt(manifest, points.id, points.scratchFile, points.excerptFile, individualPointsExcerpt);
    }
  }
  await writeExcerpt(manifest, 'webbook-front-page', 'webbook/front-page.html', 'webbook/front-page.excerpt.html', frontPageExcerpt);
  await writeExcerpt(manifest, 'webbook-citation-guide', 'webbook/citation-guide.html', 'webbook/citation-guide.excerpt.html', (html, entry) =>
    citationGuideExcerpt(html, entry, [...compilerNames]),
  );

  for (const unused of WEBBOOK_UNUSED) {
    const entry = manifestEntry(manifest, unused.id);
    upsertManifestEntry(manifest, { ...entry, used: false, reason: unused.reason });
  }
  await writeManifest(manifest);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
