/**
 * RFC 9457 Problem Details for every `/api/v1/lab/**` response outside the 2xx range, as required
 * by `00_SHARED_INTEGRATION_CONTRACT.md` Section 5. Distinct from (and not a replacement for) the
 * existing science service's `{"error": {code, message, details}}` shape.
 */
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import type { ProblemDetails } from '@matterlab/contracts-lab';
import { DatabaseUnavailable } from './db.js';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string;
  readonly errors?: ProblemDetails['errors'];

  constructor(status: number, code: string, detail: string, errors?: ProblemDetails['errors']) {
    super(detail);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.errors = errors;
  }
}

const TITLES: Record<number, string> = {
  400: 'Bad request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Resource not found',
  409: 'Conflict',
  412: 'Precondition failed',
  413: 'Payload too large',
  422: 'Unprocessable request',
  428: 'Precondition required',
  429: 'Too many requests',
  500: 'Internal error',
  503: 'Service unavailable',
};

export function problem(status: number, code: string, detail: string, errors?: ProblemDetails['errors']): ProblemDetails {
  return {
    type: 'about:blank',
    title: TITLES[status] ?? 'Error',
    status,
    detail,
    code,
    ...(errors ? { errors } : {}),
  };
}

export function notFound(resource: string, id: string): ApiError {
  return new ApiError(404, 'not_found', `${resource} ${id} does not exist.`);
}

export function revisionConflict(current: number, expected: number): ApiError {
  return new ApiError(
    409,
    'revision_conflict',
    `The resource is at revision ${current}, not ${expected}; it was changed since you loaded it (If-Match did not match).`,
  );
}

function zodIssuesToProblem(error: ZodError): ApiError {
  const errors = error.issues.map((issue) => ({ path: issue.path.map((segment) => (typeof segment === 'symbol' ? segment.toString() : segment)), message: issue.message }));
  const summary = errors
    .slice(0, 5)
    .map((e) => `${e.path.join('.') || '(body)'}: ${e.message}`)
    .join('; ');
  return new ApiError(422, 'validation_error', `Request validation failed: ${summary}`, errors);
}

/** Parses `data` with `schema`, raising the standard 422 ApiError (never a raw ZodError) on failure. */
export function parseOrThrow<T>(schema: { parse: (data: unknown) => T }, data: unknown): T {
  try {
    return schema.parse(data);
  } catch (error) {
    if (error instanceof ZodError) throw zodIssuesToProblem(error);
    throw error;
  }
}

export function sendProblem(res: Response, status: number, code: string, detail: string, errors?: ProblemDetails['errors']): void {
  res.status(status).type('application/problem+json').json(problem(status, code, detail, errors));
}

/** Express error-handling middleware (four arguments is how Express recognises it). */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function problemErrorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) return;
  if (error instanceof ApiError) {
    sendProblem(res, error.status, error.code, error.detail, error.errors);
    return;
  }
  if (error instanceof ZodError) {
    const apiError = zodIssuesToProblem(error);
    sendProblem(res, apiError.status, apiError.code, apiError.detail, apiError.errors);
    return;
  }
  if (error instanceof DatabaseUnavailable) {
    res.set('Retry-After', '5');
    sendProblem(res, 503, 'database_unavailable', 'The service cannot reach its PostgreSQL database, so the request was not completed. Try again shortly.');
    return;
  }
  if (error instanceof SyntaxError && 'body' in (error as object)) {
    sendProblem(res, 400, 'invalid_json', 'The request body is not valid JSON.');
    return;
  }
  // eslint-disable-next-line no-console
  console.error('unhandled error', error);
  sendProblem(res, 500, 'internal_error', 'The service hit an unexpected error. It has been logged.');
}

export function notFoundHandler(req: Request, res: Response): void {
  sendProblem(res, 404, 'not_found', `No route for ${req.method} ${req.path}.`);
}
