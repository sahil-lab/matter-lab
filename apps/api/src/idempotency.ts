/**
 * Idempotency-Key support for POST endpoints that create a resource or queue a job (scene create,
 * scene duplicate, run create, template create), per the brief's "idempotency keys on creates/jobs".
 */
import type { Request } from 'express';
import type { Database } from './db.js';
import { ApiError } from './errors.js';
import { canonicalJson, sha256Hex } from './util.js';

export interface IdempotentResult<T> {
  readonly status: number;
  readonly body: T;
  readonly replayed: boolean;
}

export function idempotencyKeyOf(req: Request): string | undefined {
  const key = req.header('idempotency-key');
  return key && key.trim() !== '' ? key.trim() : undefined;
}

/**
 * Runs `compute` at most once per (scope, key, requestBody). A retried request with the same key
 * and body returns the original response; the same key with a different body is a 409 (the key was
 * reused for a different request, which almost always means a client bug).
 */
export async function withIdempotency<T>(
  db: Database,
  scope: string,
  key: string | undefined,
  requestBody: unknown,
  compute: () => Promise<{ status: number; body: T }>,
): Promise<IdempotentResult<T>> {
  if (!key) {
    const result = await compute();
    return { ...result, replayed: false };
  }
  const requestHash = sha256Hex(canonicalJson(requestBody));
  const existing = await db.queryOne<{ request_hash: string; response_status: number; response_body: T }>(
    'SELECT request_hash, response_status, response_body FROM api_idempotency_key WHERE scope = $1 AND idempotency_key = $2',
    [scope, key],
  );
  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw new ApiError(409, 'idempotency_key_reused', `The idempotency key "${key}" was already used for a different request body.`);
    }
    return { status: existing.response_status, body: existing.response_body, replayed: true };
  }
  const result = await compute();
  try {
    await db.query(
      'INSERT INTO api_idempotency_key (scope, idempotency_key, request_hash, response_status, response_body) VALUES ($1, $2, $3, $4, $5)',
      [scope, key, requestHash, result.status, JSON.stringify(result.body)],
    );
  } catch (error) {
    // A concurrent request with the same key won the race to insert first: that is still a
    // correct idempotent outcome, so fall through to returning this request's own freshly
    // computed result rather than failing it.
    if (!(error as { code?: string }).code || (error as { code?: string }).code !== '23505') throw error;
  }
  return { ...result, replayed: false };
}
