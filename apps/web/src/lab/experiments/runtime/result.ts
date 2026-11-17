/**
 * Small `Result` helper used throughout the reducer so every validation failure carries a
 * human-readable reason instead of throwing. Acceptance test: "Invalid attachments and unsupported
 * calculation paths fail transparently without corrupting scene state" — a `Result` that is never
 * unwrapped without checking `ok` is what makes that true by construction.
 */
export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail<T = never>(reason: string): Result<T> {
  return { ok: false, reason };
}

export function isOk<T>(result: Result<T>): result is { ok: true; value: T } {
  return result.ok;
}
