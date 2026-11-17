import { createHash } from 'node:crypto';

/** Deterministic JSON: object keys sorted recursively, so identical data always hashes the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const sorted: Record<string, unknown> = {};
    for (const [key, val] of entries) sorted[key] = sortKeys(val);
    return sorted;
  }
  return value;
}

export function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** Weak ETag for a resource's integer revision, e.g. `W/"rev-3"`. */
export function etagFor(revision: number): string {
  return `W/"rev-${revision}"`;
}

/** Parses an If-Match/ETag-style header value back into the revision number it carries. Accepts
 * this API's own `W/"rev-3"` form and a bare `"3"` for lenience. */
export function parseRevisionEtag(headerValue: string): number | null {
  const trimmed = headerValue.trim();
  const tagged = /^(?:W\/)?"rev-(\d+)"$/.exec(trimmed);
  if (tagged) return Number.parseInt(tagged[1], 10);
  const bare = /^(?:W\/)?"(\d+)"$/.exec(trimmed);
  if (bare) return Number.parseInt(bare[1], 10);
  return null;
}

export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = typeof raw === 'string' ? Number.parseInt(raw, 10) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * `req.params[name]` as a plain string. @types/express types every route param as `string |
 * string[]` (to account for repeated wildcard segments); every param this API's routes declare
 * (`:id`, `:runId`, ...) is a single path segment and is always a single string at runtime.
 */
export function pathParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

/** Same lenience as `pathParam`, for a single-valued query-string parameter. */
export function queryParam(value: unknown): string | undefined {
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
  return typeof value === 'string' ? value : undefined;
}
