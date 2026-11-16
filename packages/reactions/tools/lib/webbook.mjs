// Reading NIST Chemistry WebBook species pages. The same functions work on a full page and on the
// excerpts written by excerpt-webbook.mjs, because an excerpt is made of fragments copied verbatim.

import { decodeEntities, htmlToText } from './common.mjs';

const DELTA = '\u0394';
const DEGREE = '\u00b0';

/** Rows of the thermochemistry tables: "ΔfH°gas", "S°gas,1 bar", "ΔfH°liquid", "S°solid", ... */
export const QUANTITY_LABEL = new RegExp(`^(${DELTA}fH${DEGREE}|S${DEGREE})(gas|liquid|solid)(,1 bar)?$`);

export const PHASE_WORD = { g: 'gas', l: 'liquid', s: 'solid' };

const fragment = (html, re, what) => {
  const m = re.exec(html);
  if (!m) throw new Error(`WebBook page: cannot find ${what}`);
  return m[0];
};

export function titleFragment(html) {
  return fragment(html, /<h1 id="Top">[\s\S]*?<\/h1>/, 'the page title');
}

export function formulaFragment(html) {
  return fragment(html, /<li><strong><a[^>]*>Formula<\/a>:<\/strong>[\s\S]*?<\/li>/, 'the formula line');
}

export function casFragment(html) {
  return fragment(html, /<li><strong>CAS Registry Number:<\/strong>[\s\S]*?<\/li>/, 'the CAS number line');
}

export function pageIdentity(html) {
  return {
    title: htmlToText(titleFragment(html)),
    formula: htmlToText(formulaFragment(html)).replace(/^Formula:\s*/, ''),
    cas: htmlToText(casFragment(html)).replace(/^CAS Registry Number:\s*/, ''),
  };
}

/** Section of a page from its <h2 id="..."> heading up to the next <h2> heading (or the end of <main>). */
export function sectionHtml(html, id) {
  const start = html.indexOf(`<h2 id="${id}"`);
  if (start < 0) return null;
  let end = html.indexOf('<h2 ', start + 4);
  if (end < 0) end = html.indexOf('</main>', start);
  if (end < 0) end = html.length;
  return html.slice(start, end);
}

/** The data rows (<tr class="cal|exp">) of a fragment, in page order, with their cells. */
export function dataRows(html) {
  const rows = [];
  for (const m of html.matchAll(/<tr class="(?:cal|exp)">(?:(?!<\/tr>)[\s\S])*<\/tr>/g)) {
    const cells = [...m[0].matchAll(/<td[^>]*>((?:(?!<\/td>)[\s\S])*)<\/td>/g)].map((c) => c[1]);
    rows.push({ html: m[0], cells, text: cells.map(htmlToText) });
  }
  return rows;
}

/** Rows of the one-dimensional thermochemistry tables that give an enthalpy of formation or an entropy. */
export function thermoRows(html) {
  return dataRows(html)
    .filter((r) => r.cells.length === 6 && QUANTITY_LABEL.test(r.text[0]))
    .map((r) => ({
      html: r.html,
      label: r.text[0],
      valueText: r.text[1],
      units: r.text[2],
      method: r.text[3],
      reference: r.text[4],
      comment: r.text[5],
      refIds: [...r.cells[4].matchAll(/href="#(ref-\d+)"/g)].map((m) => m[1]),
      commentRefIds: [...r.cells[5].matchAll(/href="#(ref-\d+)"/g)].map((m) => m[1]),
      individualPointsHref: (/href="([^"]*Type=HF[A-Z][^"]*)"[^>]*>Individual data points/.exec(r.cells[5]) ?? [])[1],
    }));
}

/** Verbatim reference block (<p> ... </p>) for a reference anchor such as "ref-3". */
export function referenceFragment(html, refId) {
  const re = new RegExp(`<span id="${refId}">(?:(?!</p>)[\\s\\S])*</p>`);
  const m = re.exec(html);
  if (!m) throw new Error(`WebBook page: cannot find reference ${refId}`);
  return m[0];
}

/** Percent-decoding that also accepts the Latin-1 escapes (e.g. %B0 for the degree sign) some COinS records use. */
function percentDecode(encoded) {
  const text = encoded.replace(/\+/g, ' ');
  try {
    return decodeURIComponent(text);
  } catch {
    return text.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => Buffer.from(run.replace(/%/g, ''), 'hex').toString('latin1'));
  }
}

/**
 * Structured citation from a reference block. The WebBook embeds a COinS record (span class="Z3988") with
 * the authors, title, journal or book, year, volume, pages and DOI; the visible text is kept as `text`.
 */
export function parseReference(blockHtml) {
  const label = htmlToText((/<strong>([\s\S]*?)<\/strong>/.exec(blockHtml) ?? [])[1] ?? '');
  const coins = (/<span class="Z3988" title="([^"]*)"/.exec(blockHtml) ?? [])[1];
  const fields = {};
  if (coins) {
    for (const pair of decodeEntities(coins).split('&')) {
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const key = pair.slice(0, eq);
      const value = percentDecode(pair.slice(eq + 1)).trim();
      if (!value) continue;
      (fields[key] ??= []).push(value);
    }
  }
  const first = (key) => fields[key]?.[0];
  const text = htmlToText(blockHtml.replace(/<span id="[^"]*">[\s\S]*?<\/span>\s*<br \/>/, ''))
    .replace(/\s*\[all data\]\s*$/, '')
    .replace(/\s+,/g, ',')
    .replace(/\s+\./g, '.')
    .trim();
  const doi = (fields.rft_id ?? []).map((v) => /^info:doi\/(.+)$/.exec(v)?.[1]).find(Boolean);
  const journal = first('rft.stitle') ?? first('rft.jtitle');
  const volumeIssue = `${first('rft.volume') ?? ''}${first('rft.issue') ? `(${first('rft.issue')})` : ''}`;
  const journalParts = [[journal, volumeIssue].filter(Boolean).join(' '), first('rft.pages')];
  const bookParts = [first('rft.pub'), first('rft.place')];
  const yearText = first('rft.date');
  return {
    label,
    text,
    authors: fields['rft.au']?.join('; '),
    title: first('rft.atitle') ?? first('rft.btitle'),
    source: (journal ? journalParts : bookParts).filter(Boolean).join(', ') || undefined,
    year: yearText && /^\d{4}$/.test(yearText) ? Number(yearText) : undefined,
    doi,
  };
}

/** Compilers credited on a page: { ALS: 'Hussein Y. Afeefy, Joel F. Liebman, and Stephen E. Stein', ... }. */
export function compilers(html) {
  const out = {};
  for (const m of html.matchAll(/<em><a href="\/cgi\/cbook\.cgi\?Contrib=([A-Za-z0-9]+)">[^<]*<\/a><\/em> - ([^<]*)/g)) {
    out[m[1]] = htmlToText(m[2]);
  }
  return out;
}

/** Compiler initials at the end of a comment cell, e.g. "...; ALS" -> ["ALS"]. */
export function compilerInitials(commentText, known) {
  const tail = commentText.split(';').pop()?.trim() ?? '';
  return tail.split(/,\s*/).filter((t) => t in known);
}
