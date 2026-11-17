/**
 * Authentication and authorization placeholder: a static API key -> scopes mapping, enough to
 * demonstrate and test real scope enforcement on the lab endpoints without building a full
 * identity system. See README "Authentication and authorization (placeholder)" for how this is
 * meant to be replaced.
 */
import type { NextFunction, Request, Response } from 'express';
import type { Config } from './config.js';
import { ApiError } from './errors.js';
import { isUuid } from './util.js';

export interface AuthContext {
  readonly apiKey: string;
  readonly scopes: readonly string[];
  /** Caller-asserted owner id (`X-MatterLab-Owner`); not cryptographically verified. */
  readonly ownerId: string | null;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

function extractKey(req: Request): string | undefined {
  const authHeader = req.header('authorization');
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice('Bearer '.length).trim();
  const apiKeyHeader = req.header('x-matterlab-api-key');
  return apiKeyHeader?.trim();
}

export function authMiddleware(config: Config) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const key = extractKey(req);
    const scopes = key ? config.apiKeys.get(key) : undefined;
    if (!key || !scopes) {
      next(new ApiError(401, 'unauthorized', 'A valid API key is required (Authorization: Bearer <key> or X-MatterLab-Api-Key).'));
      return;
    }
    const ownerHeader = req.header('x-matterlab-owner');
    if (ownerHeader !== undefined && !isUuid(ownerHeader)) {
      next(new ApiError(400, 'bad_request', 'X-MatterLab-Owner must be a UUID.'));
      return;
    }
    req.auth = { apiKey: key, scopes, ownerId: ownerHeader ?? null };
    next();
  };
}

export function requireScope(scope: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth?.scopes.includes(scope)) {
      next(new ApiError(403, 'forbidden', `This request needs the "${scope}" scope.`));
      return;
    }
    next();
  };
}
