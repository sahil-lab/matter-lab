/**
 * Traceability: every reference number the package ships must be readable in a saved copy of its source.
 *
 * These tests go back to the snapshot files and re-read the values with code of their own (a few regular
 * expressions, deliberately not the build scripts), so a slip in the build scripts, a hand edit of a
 * generated file or a damaged snapshot shows up here.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KINETIC_RECORDS, KINETIC_SOURCE_RECORDS } from '../src/data/kinetics.generated';
import { THERMO_CITATIONS, THERMO_PAGES, THERMO_RECORDS, THERMO_SKIPPED_ROWS } from '../src/data/thermo.generated';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourcesDir = join(packageDir, 'data', 'sources');

interface ManifestEntry {
  id: string;
  url?: string;
  file?: string;
  kept?: boolean;
  used?: boolean;
  reason?: string;
  retrievedAt?: string;
  bytes?: number;
  sha256?: string;
  derivedFrom?: string[];
  excerpt?: { file: string; bytes: number; sha256: string };
}
const manifest = JSON.parse(readFileSync(join(sourcesDir, 'manifest.json'), 'utf8')) as { sources: ManifestEntry[] };
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Tag-free text of an HTML fragment, with the handful of entities these pages use decoded. */
function textOf(html: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ', deg: '\u00b0', ordm: '\u00ba', plusmn: '\u00b1' };
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&([a-z]+);/g, (whole, name: string) => entities[name] ?? whole)
    .replace(/\s+/g, ' ')
    .trim();
}
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Removes the space that tag stripping leaves in front of punctuation. */
const tidy = (text: string): string => text.replace(/\s+([.,;])/g, '$1');

/** "-74.6 ± 0.3" -> [-74.6, 0.3]; "0" -> [0, undefined]. */
function readValue(printed: string): [number, number | undefined] {
  const m = /^(-?\d+(?:\.\d*)?)(?: \u00b1 (\d+(?:\.\d*)?))?$/.exec(printed);
  if (!m) throw new Error(`cannot read "${printed}"`);
  return [Number(m[1]), m[2] === undefined ? undefined : Number(m[2])];
}

describe('source manifest and snapshots', () => {
  it('records where and when every source was retrieved, and a hash of what came back', () => {
    expect(manifest.sources.length).toBeGreaterThan(10);
    expect(new Set(manifest.sources.map((s) => s.id)).size).toBe(manifest.sources.length);
    for (const entry of manifest.sources) {
      expect(entry.sha256, entry.id).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.bytes, entry.id).toBeGreaterThan(0);
      if (entry.derivedFrom) {
        // An excerpt of a document that is itself registered.
        for (const parent of entry.derivedFrom) expect(manifest.sources.some((s) => s.id === parent), `${entry.id} <- ${parent}`).toBe(true);
      } else {
        expect(entry.url, entry.id).toMatch(/^https:\/\//);
        expect(entry.retrievedAt, entry.id).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
        expect(Number.isNaN(Date.parse(entry.retrievedAt!)), entry.id).toBe(false);
      }
    }
  });

  it('holds, for every source, the snapshot or excerpt the manifest promises, byte for byte', () => {
    let checked = 0;
    for (const entry of manifest.sources) {
      for (const item of [entry.file ? { file: entry.file, bytes: entry.bytes!, sha256: entry.sha256! } : undefined, entry.excerpt]) {
        if (!item) continue;
        const path = join(sourcesDir, item.file);
        expect(existsSync(path), item.file).toBe(true);
        const bytes = readFileSync(path);
        expect(bytes.length, item.file).toBe(item.bytes);
        expect(sha256(bytes), item.file).toBe(item.sha256);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(30);
  });

  it('accounts for every download: kept, excerpted, the parent of an excerpt, or listed as unused with a reason', () => {
    const parents = new Set(manifest.sources.flatMap((s) => s.derivedFrom ?? []));
    for (const entry of manifest.sources) {
      const accounted = Boolean(entry.file) || Boolean(entry.excerpt) || parents.has(entry.id) || (entry.used === false && Boolean(entry.reason));
      expect(accounted, entry.id).toBe(true);
    }
  });

  it('has no stray files next to the registered ones', () => {
    const registered = new Set(['manifest.json', '.gitattributes']);
    for (const entry of manifest.sources) {
      if (entry.file) registered.add(entry.file);
      if (entry.excerpt) registered.add(entry.excerpt.file);
    }
    const walk = (dir: string, prefix: string): string[] =>
      readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name), `${prefix}${name}/`) : [`${prefix}${name}`]));
    expect(walk(sourcesDir, '').sort()).toEqual([...registered].sort());
  });

  it('took nothing from a site that asks not to be read by programs', () => {
    // kinetics.nist.gov answers every agent except two search engines with "Disallow: /" in robots.txt.
    for (const entry of manifest.sources) if (entry.url) expect(new URL(entry.url).host, entry.id).not.toBe('kinetics.nist.gov');
  });

  // Each build tool runs as a Node process of its own and re-reads every snapshot. Together they took 1.2 to 2.5 s
  // on a quiet machine and 5 to 15 s while four suites ran side by side, which is past the 5 s default limit of a
  // test. The limits below only bound the waiting: what is asserted does not depend on them. The limit on the
  // child process is the one that can actually stop a tool that hangs, because the test runner cannot interrupt
  // a synchronous call.
  it('keeps the generated data files exactly as the snapshots produce them', { timeout: 180_000 }, () => {
    for (const tool of ['build-thermo.mjs', 'build-kinetics.mjs']) {
      const output = execFileSync(process.execPath, [join(packageDir, 'tools', tool), '--check'], { encoding: 'utf8', timeout: 80_000 });
      expect(output, tool).toMatch(/is up to date/);
    }
  });
});

describe('CODATA Key Values: every number can be read in the saved page', () => {
  const entry = manifest.sources.find((s) => s.id === 'codata-key-values')!;
  const html = readFileSync(join(sourcesDir, entry.file!)).toString('latin1');
  const tableStart = html.indexOf('<TABLE bgcolor');
  const table = html.slice(tableStart, html.indexOf('</TABLE>', tableStart));
  const rows = [...table.matchAll(/<TR[^>]*>([\s\S]*?)<\/TR>/gi)]
    .map((m) => [...m[1]!.matchAll(/<TD[^>]*>([\s\S]*?)<\/TD>/gi)].map((c) => textOf(c[1]!)))
    .filter((cells) => cells.length === 5 && cells[1] !== '' && cells[0] !== 'Substance');
  const byLabel = new Map(rows.map((cells) => [`${cells[0]} | ${cells[1]}`, cells]));
  const records = THERMO_RECORDS.filter((r) => r.source === 'codata-key-values');

  it('reads the page it says it reads', () => {
    expect(THERMO_PAGES['codata-key-values']).toEqual({
      url: 'https://www.codata.info/resources/databases/key1.html',
      retrieved: entry.retrievedAt!.slice(0, 10),
      snapshot: entry.file,
      sha256: entry.sha256,
    });
    expect(textOf(html)).toContain('Cox, J. D., Wagman, D. D., and Medvedev, V. A., CODATA Key Values for Thermodynamics, Hemisphere Publishing Corp., New York, 1989.');
    expect(THERMO_CITATIONS['cox-wagman-medvedev-1989']).toMatchObject({ title: 'CODATA Key Values for Thermodynamics', year: 1989 });
    expect(textOf(table)).toMatch(/Substance State DfH \u00b0 \(298\.15 K\) S \u00b0 \(298\.15 K\) H \u00b0 \(298\.15 K\)-H \u00b0 \(0\) kJ mol-1 J K-1 mol-1 kJ mol-1/);
  });

  it('uses every row of the table except the one it lists as left out', () => {
    expect(byLabel.size).toBe(rows.length);
    expect(rows).toHaveLength(151);
    expect(records).toHaveLength(150);
    expect(THERMO_SKIPPED_ROWS).toHaveLength(1);
    const used = new Set(records.map((r) => r.printedAs));
    const unused = [...byLabel.keys()].filter((label) => !used.has(label));
    expect(unused).toEqual(THERMO_SKIPPED_ROWS.map((r) => r.printedAs));
  });

  it('carries each enthalpy of formation and entropy exactly as printed', () => {
    for (const record of records) {
      const cells = byLabel.get(record.printedAs);
      expect(cells, record.id).toBeDefined();
      for (const [value, cell, what] of [
        [record.deltaHf298, cells![2]!, 'enthalpy'],
        [record.s298, cells![3]!, 'entropy'],
      ] as const) {
        expect(value, `${record.id} ${what}`).not.toBeNull();
        expect(value!.asPrinted, `${record.id} ${what}`).toBe(cell);
        const [number, uncertainty] = readValue(cell);
        expect(value!.value, `${record.id} ${what}`).toBe(number);
        expect(value!.uncertainty, `${record.id} ${what}`).toBe(uncertainty);
        // A bare 0 is a reference state or the hydrogen-ion convention, and only that is marked exact.
        expect(value!.exact === true, `${record.id} ${what}`).toBe(cell === '0');
      }
    }
  });

  it('reads the state and the charge of each row correctly', () => {
    for (const record of records) {
      const [substance, state] = record.printedAs.split(' | ') as [string, string];
      const phase = { cr: 's', l: 'l', g: 'g', aq: 'aq' }[state.split(',')[0]!];
      expect(record.phase, record.id).toBe(phase);
      // The page prints charges as a sign followed by the magnitude: "+", "-", "+2", "-2", "+3".
      const charge = /([+-])(\d?)$/.exec(substance);
      const expected = charge ? (charge[1] === '+' ? 1 : -1) * (charge[2] ? Number(charge[2]) : 1) : 0;
      const stored = /(?:\^(\d+))?([+-])$/.exec(record.formula);
      const actual = stored ? (stored[2] === '+' ? 1 : -1) * (stored[1] ? Number(stored[1]) : 1) : 0;
      expect(actual, record.id).toBe(expected);
      // Without the charge, the formula is the substance as printed.
      expect(record.formula.replace(/(?:\^\d+)?[+-]$/, ''), record.id).toBe(substance.replace(/[+-]\d?$/, ''));
    }
  });
});

describe('NIST Chemistry WebBook: every number can be read in the saved excerpt', () => {
  const records = THERMO_RECORDS.filter((r) => r.source === 'nist-webbook');
  const excerptOf = (pageKey: string): { text: string; html: string } => {
    const html = readFileSync(join(sourcesDir, THERMO_PAGES[pageKey]!.snapshot), 'utf8');
    return { html, text: textOf(html) };
  };

  it('points every record at a registered page and its excerpt', () => {
    expect(records.length).toBeGreaterThan(20);
    for (const record of records) {
      const page = THERMO_PAGES[record.page]!;
      const entry = manifest.sources.find((s) => s.id === record.page)!;
      expect(page.url, record.id).toBe(entry.url);
      expect(page.url, record.id).toMatch(/^https:\/\/webbook\.nist\.gov\/cgi\/cbook\.cgi\?ID=C\d+&Units=SI&Mask=3$/);
      expect(page.sha256, record.id).toBe(entry.sha256);
      expect(page.snapshot, record.id).toBe(entry.excerpt!.file);
      expect(page.retrieved, record.id).toBe(entry.retrievedAt!.slice(0, 10));
    }
  });

  it('identifies the substance of each page by name, formula and CAS number', () => {
    for (const record of records) {
      const { text } = excerptOf(record.page);
      const [title, formula, cas] = record.printedAs.split(' | ') as [string, string, string];
      expect(cas, record.id).toMatch(/^CAS \d+-\d\d-\d$/);
      expect(text, record.id).toContain(`${title} Formula: ${formula} CAS Registry Number: ${cas.slice(4)}`);
    }
  });

  it('carries each value exactly as printed, with its method and reference, from the first-listed row', () => {
    const phaseWord = { g: 'gas', l: 'liquid', s: 'solid', aq: '' } as const;
    for (const record of records) {
      const { text } = excerptOf(record.page);
      for (const [value, unit, kind] of [
        [record.deltaHf298, 'kJ/mol', 'H'],
        [record.s298, 'J/mol*K', 'S'],
      ] as const) {
        if (!value) continue;
        const where = `${record.id} ${kind}`;
        // The row label names the phase the record claims.
        const expectedLabel = kind === 'H' ? `\u0394fH\u00b0${phaseWord[record.phase]}` : `S\u00b0${phaseWord[record.phase]}`;
        expect(value.label!.startsWith(expectedLabel), where).toBe(true);
        if (kind === 'S' && record.phase === 'g') expect(value.label, where).toBe('S\u00b0gas,1 bar');
        // The row as it appears once the tags are stripped: label, value, unit, method, reference.
        const row = `${value.label}${value.asPrinted}${unit}${value.method}${value.reference}`;
        const at = text.indexOf(row);
        expect(at, `${where}: "${row}"`).toBeGreaterThanOrEqual(0);
        // It is the first row with this label, which is the selection rule the package states.
        const first = new RegExp(`${escapeRegExp(value.label!)}-?\\d`).exec(text);
        expect(first?.index, where).toBe(at);
        const [number, uncertainty] = readValue(value.asPrinted);
        expect(value.value, where).toBe(number);
        expect(value.uncertainty, where).toBe(uncertainty);
        expect(value.exact, where).toBeUndefined();
        expect(value.citationKeys.length, where).toBeGreaterThanOrEqual(2);
        for (const key of value.citationKeys) expect(THERMO_CITATIONS[key], `${where} ${key}`).toBeDefined();
      }
    }
  });

  it('cites the reference the WebBook lists for the row', () => {
    for (const record of records) {
      const text = tidy(excerptOf(record.page).text);
      for (const value of [record.deltaHf298, record.s298]) {
        if (!value || value.reference === 'N/A') continue;
        // The reference label of the row heads an entry of the reference list, and that entry is what is cited.
        const cited = value.citationKeys.map((k) => THERMO_CITATIONS[k]!).find((c) => c.text && text.includes(tidy(`${value.reference} ${c.text}`)));
        expect(cited, `${record.id} ${value.reference}`).toBeDefined();
      }
    }
  });

  it('cites every determination behind a value the WebBook averaged', () => {
    const averaged = records.flatMap((r) => [r.deltaHf298, r.s298]).filter((v) => v?.individualPoints);
    expect(averaged).toHaveLength(1);
    const value = averaged[0]!;
    const text = tidy(excerptOf(value.individualPointsPage!).text);
    expect(value.comment).toBe(`Average of ${value.individualPoints!.length} values; Individual data points`);
    for (const point of value.individualPoints!) {
      expect(text, point.reference).toContain(`${point.asPrinted}${point.method}${point.reference}`);
      const cited = value.citationKeys.map((k) => THERMO_CITATIONS[k]!).find((c) => c.text && text.includes(tidy(`${point.reference} ${c.text}`)));
      expect(cited, point.reference).toBeDefined();
    }
    // The stated value is consistent with the average of the listed determinations, to the precision printed.
    const mean = value.individualPoints!.reduce((sum, p) => sum + readValue(p.asPrinted)[0], 0) / value.individualPoints!.length;
    expect(Math.abs(mean - value.value)).toBeLessThan(1);
  });

  it('keeps the notices of the source with every excerpt', () => {
    const files = readdirSync(join(sourcesDir, 'webbook')).filter((name) => /^C\d+(-HF[A-Z])?\.excerpt\.html$/.test(name));
    expect(files.length).toBeGreaterThanOrEqual(records.length - 1);
    for (const name of files) {
      const html = readFileSync(join(sourcesDir, 'webbook', name), 'utf8');
      const text = textOf(html);
      expect(html.startsWith('<!--\n  EXCERPT of a NIST Chemistry WebBook page'), name).toBe(true);
      expect(html, name).toMatch(/Page: +https:\/\/webbook\.nist\.gov\/cgi\/cbook\.cgi\?ID=C\d+&Units=SI&(Mask=3|Type=HF[A-Z])\n/);
      expect(html, name).toMatch(/Retrieved: +\d{4}-\d{2}-\d{2}T[\d:.]+Z \(\d+ bytes, SHA-256 [0-9a-f]{64}\)\n/);
      expect(text, name).toContain('Data compilation copyright by the U.S. Secretary of Commerce on behalf of the U.S.A. All rights reserved.');
      expect(text, name).toContain('Data from NIST Standard Reference Database 69: NIST Chemistry WebBook');
      expect(text, name).toMatch(/by the U\.S\. Secretary of Commerce on behalf of the United States of America\. All rights reserved\./);
    }
    const guide = textOf(readFileSync(join(sourcesDir, 'webbook', 'citation-guide.excerpt.html'), 'utf8'));
    const site = THERMO_CITATIONS['nist-webbook']!;
    expect(guide).toContain('P.J. Linstrom and W.G. Mallard, Eds., NIST Chemistry WebBook, NIST Standard Reference Database Number 69, National Institute of Standards and Technology, Gaithersburg MD, 20899, https://doi.org/10.18434/T4D303');
    expect(site.text).toMatch(/^P\.J\. Linstrom and W\.G\. Mallard, Eds\., NIST Chemistry WebBook, NIST Standard Reference Database Number 69, National Institute of Standards and Technology, Gaithersburg MD, 20899, https:\/\/doi\.org\/10\.18434\/T4D303, \(retrieved [A-Z][a-z]+ \d{1,2}, \d{4}\)\.$/);
  });
});

describe('IUPAC kinetic evaluation: every number can be read in the saved excerpt', () => {
  const excerpt = (sourceId: string): string => readFileSync(join(sourcesDir, KINETIC_SOURCE_RECORDS.find((s) => s.id === sourceId)!.excerpt), 'utf8');
  const sheet = (sourceId: string, dataSheet: string): string => {
    const text = excerpt(sourceId);
    const start = text.indexOf(`=== DATA SHEET ${dataSheet} ===`);
    const end = text.indexOf(`=== END ${dataSheet} ===`);
    expect(start, dataSheet).toBeGreaterThanOrEqual(0);
    expect(end, dataSheet).toBeGreaterThan(start);
    return text.slice(start, end);
  };
  const number = (text: string): number => Number(text.replace(/\u2212/g, '-'));

  it('registers each article, its licence and the hash of its PDF', () => {
    expect(KINETIC_SOURCE_RECORDS).toHaveLength(2);
    for (const source of KINETIC_SOURCE_RECORDS) {
      const excerptEntry = manifest.sources.find((s) => s.excerpt === undefined && s.file === source.excerpt)!;
      expect(excerptEntry, source.id).toBeDefined();
      expect(source.excerptSha256, source.id).toBe(excerptEntry.sha256);
      const pdf = manifest.sources.find((s) => s.url === source.pdfUrl)!;
      expect(pdf.sha256, source.id).toBe(source.pdfSha256);
      expect(pdf.kept, source.id).toBe(false);
      expect(excerptEntry.derivedFrom, source.id).toContain(pdf.id);
      expect(source.retrieved, source.id).toBe(pdf.retrievedAt!.slice(0, 10));
      expect(source.url, source.id).toMatch(/^https:\/\/acp\.copernicus\.org\/articles\//);
      const text = excerpt(source.id);
      expect(text, source.id).toContain(source.license);
      expect(text, source.id).toContain(source.citation.url!);
      expect(text, source.id).toContain(source.citation.title);
      expect(text, source.id).toContain(source.pdfSha256);
      expect(source.license, source.id).toMatch(/^\u00a9 Author\(s\) \d{4}\. This work is licensed under the Creative Commons Attribution-NonCommercial-ShareAlike 2\.5 License\.$/);
      for (const statement of source.statements) expect(text, statement.label).toContain(statement.text);
    }
  });

  it('carries the preferred expression and the 298 K value of each data sheet exactly as extracted', () => {
    expect(KINETIC_RECORDS.length).toBeGreaterThanOrEqual(4);
    for (const record of KINETIC_RECORDS) {
      const block = sheet(record.source, record.dataSheet);
      expect(block, record.id).toContain(record.expressionAsPrinted);
      expect(block, record.id).toContain(record.k298AsPrinted);
      expect(block.split('\n')[1]!.replace(/\s+/g, ' ').replace(/\s*\u2192\s*/, ' \u2192 '), record.id).toBe(`${record.dataSheet} ${record.reactionAsPrinted}`);
      // Both lines sit in the "Preferred Values" block, before "Reliability".
      const preferred = block.slice(block.indexOf('Preferred Values'), block.indexOf('Reliability'));
      expect(preferred, record.id).toContain(record.expressionAsPrinted);
      expect(preferred, record.id).toContain(record.k298AsPrinted);
    }
  });

  it('reads A, E/R, the temperature range, the units and the reliability correctly from those lines', () => {
    const units: Record<string, string> = { 'cm3 molecule\u22121 s\u22121': 'cm3 molecule-1 s-1', 'cm6 molecule\u22122 s\u22121': 'cm6 molecule-2 s-1', 's\u22121': 's-1' };
    for (const record of KINETIC_RECORDS) {
      // "k = 1.4×10−12 exp(−1310/T ) cm3 molecule−1 s−1 over the temperature range 195–308 K."
      const m = /^k\s*=\s*([\d.]+)\s*\u00d7\s*10([\u2212-]?\d+)\s*exp\(([\u2212-]?\d+)\/T ?\)\s+(.+?)\s+over the temperature range (\d+)[\u2013-](\d+) K/.exec(record.expressionAsPrinted);
      expect(m, record.id).not.toBeNull();
      const [, mantissa, exponent, slope, printedUnits, low, high] = m!;
      expect(record.A / (Number(mantissa) * 10 ** number(exponent!)), record.id).toBeCloseTo(1, 12);
      // The sheet prints exp(B/T); E/R is −B.
      expect(record.EOverRK, record.id).toBe(-number(slope!));
      expect(record.temperatureRangeK, record.id).toEqual([Number(low), Number(high)]);
      expect(record.AUnits, record.id).toBe(units[printedUnits!]);
      expect(record.overallOrder, record.id).toBe({ 's-1': 1, 'cm3 molecule-1 s-1': 2, 'cm6 molecule-2 s-1': 3 }[record.AUnits]);
      expect(Boolean(record.pressure), record.id).toBe(/ at 1 bar\.$/.test(record.expressionAsPrinted));

      const at298 = /^k\s*=\s*([\d.]+)\s*\u00d7\s*10([\u2212-]?\d+)\s/.exec(record.k298AsPrinted);
      expect(record.k298 / (Number(at298![1]) * 10 ** number(at298![2]!)), record.id).toBeCloseTo(1, 12);

      const block = sheet(record.source, record.dataSheet);
      const reliability = block.slice(block.indexOf('Reliability'));
      expect(Number(/log k\s*=\s*\u00b1\s*([\d.]+) at 298 K\./.exec(reliability)![1]), record.id).toBe(record.deltaLog10K298);
      expect(Number(/\(E\/R ?\)\s*=\s*\u00b1\s*(\d+) K\./.exec(reliability)![1]), record.id).toBe(record.deltaEOverRK);
      const enthalpy = /H \u25e6 = ([\u2212-]?[\d.]+) kJ/.exec(block);
      expect(record.reactionEnthalpyKJPerMol, record.id).toBe(enthalpy ? number(enthalpy[1]!) : undefined);
    }
  });

  it('keeps the source sentences behind the extra notes of a model', () => {
    const mpan = KINETIC_RECORDS.find((r) => r.id === 'mpan-decomposition')!;
    const block = sheet(mpan.source, mpan.dataSheet).replace(/\s+/g, ' ');
    expect(mpan.extraNotes).toMatch(/one atmosphere of air/);
    expect(block).toContain('was studied in one atmosphere of air, with added NO to ensure that');
    expect(block).toContain('rather than reacting with NO2 to reform MPAN');
    const self = KINETIC_RECORDS.find((r) => r.id === 'acetylperoxy-self')!;
    expect(sheet(self.source, self.dataSheet)).toMatch(/k is de\S+ned by -d\[CH3C\(O\)O2\]\/dt=2k \[CH3C\(O\)O2\]2\./);
  });
});

describe('README.md says what the data say', () => {
  const readme = readFileSync(join(packageDir, 'README.md'), 'utf8');

  it('quotes the species counts of the table as they are', () => {
    const counts =
      /\*\*(\d+) species\*\* at 298\.15 K \u2013 (\d+) gases, (\d+) liquids, (\d+) solids, (\d+) aqueous species \((\d+) ions\s+and (\d+) undissociated solutes\)\. (\d+) have both/.exec(
        readme,
      );
    expect(counts).not.toBeNull();
    const phase = (p: string): number => THERMO_RECORDS.filter((r) => r.phase === p).length;
    const ions = THERMO_RECORDS.filter((r) => r.phase === 'aq' && /[+-]$/.test(r.formula)).length;
    expect(counts!.slice(1).map(Number)).toEqual([
      THERMO_RECORDS.length,
      phase('g'),
      phase('l'),
      phase('s'),
      phase('aq'),
      ions,
      phase('aq') - ions,
      THERMO_RECORDS.filter((r) => r.deltaHf298 && r.s298).length,
    ]);
    const perSource = (id: string): number => THERMO_RECORDS.filter((r) => r.source === id).length;
    expect(readme).toContain(`### 1. CODATA Key Values for Thermodynamics \u2013 ${perSource('codata-key-values')} species`);
    const pages = new Set(THERMO_RECORDS.filter((r) => r.source === 'nist-webbook').map((r) => r.page)).size;
    expect(readme).toContain(`\u2013 ${perSource('nist-webbook')} species from ${pages} pages`);
    const withoutUncertainty = THERMO_RECORDS.filter((r) => r.source === 'nist-webbook' && r.deltaHf298!.uncertainty === undefined).length;
    expect(readme).toContain(`(${withoutUncertainty} of the ${perSource('nist-webbook')} enthalpies have none)`);
  });

  it('lists every kinetic model with its validated temperature range', () => {
    expect(readme).toContain(`**${KINETIC_RECORDS.length} gas-phase reactions**`);
    expect(readme).toContain(`\u2013 ${KINETIC_RECORDS.length} kinetic models`);
    const rows = [...readme.matchAll(/^\s*\| `([a-z0-9-]+)` \| .+ \| (\d+)\u2013(\d+) \|$/gm)].map((m) => [m[1], Number(m[2]), Number(m[3])]);
    expect(rows).toEqual(KINETIC_RECORDS.map((r) => [r.id, ...r.temperatureRangeK]));
    for (const record of KINETIC_RECORDS) expect(readme, record.id).toContain(record.dataSheet);
  });

  it('names the sources by their own citations', () => {
    const flat = readme.replace(/\s+/g, ' ');
    expect(flat).toContain('https://www.codata.info/resources/databases/key1.html');
    expect(flat).toContain('https://doi.org/10.18434/T4D303');
    for (const source of KINETIC_SOURCE_RECORDS) expect(flat).toContain(source.citation.url!);
    expect(flat).toContain('Creative Commons Attribution-NonCommercial-ShareAlike 2.5 License');
    expect(flat).toContain('Data compilation copyright by the U.S. Secretary of Commerce on behalf of the U.S.A. All rights reserved.');
    expect(flat).toContain('J. D. Cox, D. D. Wagman and V. A. Medvedev, *CODATA Key Values for Thermodynamics*, Hemisphere Publishing Corp., New York, 1989');
  });
});

describe('browser safety of src/', () => {
  it('uses no Node-only modules or globals', () => {
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));
    const files = walk(join(packageDir, 'src')).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(8);
    for (const file of files) {
      const code = readFileSync(file, 'utf8');
      expect(code, file).not.toMatch(/from\s+['"]node:/);
      expect(code, file).not.toMatch(/\brequire\s*\(/);
      expect(code, file).not.toMatch(/\bprocess\.(env|argv|cwd|exit)\b/);
      expect(code, file).not.toMatch(/\bBuffer\b/);
      expect(code, file).not.toMatch(/from\s+['"](fs|path|crypto|child_process|os|url)['"]/);
      // The only package dependency is @matterlab/core.
      for (const m of code.matchAll(/from\s+['"]([^'"./][^'"]*)['"]/g)) expect(m[1], file).toBe('@matterlab/core');
    }
  });
});
