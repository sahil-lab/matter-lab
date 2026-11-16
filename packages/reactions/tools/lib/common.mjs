// Shared helpers for the data tools in this folder. Node only; nothing here is imported by src/.

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const packageDir = resolve(here, '..', '..');
export const dataDir = join(packageDir, 'data');
export const sourcesDir = join(dataDir, 'sources');
export const scratchDir = join(dataDir, '.scratch');
export const manifestPath = join(sourcesDir, 'manifest.json');
export const generatedDir = join(packageDir, 'src', 'data');

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function readManifest() {
  return JSON.parse(await readFile(manifestPath, 'utf8'));
}

export async function writeManifest(manifest) {
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

export function manifestEntry(manifest, id) {
  const entry = manifest.sources.find((s) => s.id === id);
  if (!entry) throw new Error(`manifest.json has no source with id "${id}"`);
  return entry;
}

/** Replaces (or appends) the manifest entry with the same id, keeping the original position. */
export function upsertManifestEntry(manifest, entry) {
  const index = manifest.sources.findIndex((s) => s.id === entry.id);
  if (index >= 0) manifest.sources[index] = entry;
  else manifest.sources.push(entry);
}

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  deg: '\u00b0',
  ordm: '\u00ba',
  plusmn: '\u00b1',
  middot: '\u00b7',
  eacute: '\u00e9',
  otilde: '\u00f5',
  copy: '\u00a9',
  ndash: '\u2013',
  mdash: '\u2014',
};

export function decodeEntities(text, { lenient = false } = {}) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    if (named === undefined) {
      // Data tables are decoded strictly so that an unexpected symbol cannot slip through unnoticed.
      if (lenient) return whole;
      throw new Error(`Unhandled HTML entity ${whole}`);
    }
    return named;
  });
}

/** Tag-free, entity-decoded, whitespace-collapsed text of an HTML fragment. */
export function htmlToText(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

/** Element counts of a plain formula such as "Ca(OH)2" or "C2H5OH" (no charges, no hydrates). */
export function composition(formula) {
  const stack = [{}];
  const re = /([A-Z][a-z]?)(\d*)|(\()|(\))(\d*)/g;
  let consumed = 0;
  for (const m of formula.matchAll(re)) {
    if (m.index !== consumed) throw new Error(`Cannot read formula "${formula}"`);
    consumed += m[0].length;
    if (m[1]) {
      const top = stack[stack.length - 1];
      top[m[1]] = (top[m[1]] ?? 0) + (m[2] ? Number(m[2]) : 1);
    } else if (m[3]) {
      stack.push({});
    } else {
      if (stack.length < 2) throw new Error(`Unbalanced parenthesis in "${formula}"`);
      const group = stack.pop();
      const times = m[5] ? Number(m[5]) : 1;
      const top = stack[stack.length - 1];
      for (const [el, n] of Object.entries(group)) top[el] = (top[el] ?? 0) + n * times;
    }
  }
  if (consumed !== formula.length || stack.length !== 1) throw new Error(`Cannot read formula "${formula}"`);
  return stack[0];
}

export function sameComposition(a, b) {
  const ca = composition(a);
  const cb = composition(b);
  const keys = new Set([...Object.keys(ca), ...Object.keys(cb)]);
  for (const k of keys) if (ca[k] !== cb[k]) return false;
  return true;
}

/** "42.55 ± 0.20" -> { text, value, uncertainty }; "0" -> { text, value: 0 }. Throws on anything else. */
export function parseValueWithUncertainty(raw) {
  const text = raw.replace(/\s+/g, ' ').trim();
  const m = /^(-?\d+(?:\.\d*)?)(?: ?\u00b1 ?(\d+(?:\.\d*)?))?$/.exec(text);
  if (!m) throw new Error(`Cannot read numeric value "${raw}"`);
  const value = Number(m[1]);
  const uncertainty = m[2] === undefined ? undefined : Number(m[2]);
  if (!Number.isFinite(value) || (uncertainty !== undefined && !Number.isFinite(uncertainty))) {
    throw new Error(`Cannot read numeric value "${raw}"`);
  }
  return uncertainty === undefined ? { text, value } : { text, value, uncertainty };
}

export const isoDate = (isoDateTime) => isoDateTime.slice(0, 10);

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "2026-11-13T16:02:29.093Z" -> "November 13, 2026" (UTC), the form the WebBook citation guide uses. */
export function longDate(isoDateTime) {
  const d = new Date(isoDateTime);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
