import { ContractValidationError } from '@matterlab/contracts';
import type { LabErrorCode, ProblemDetails } from '@matterlab/contracts';

export function problem(code: LabErrorCode, detail: string, status = 422): ProblemDetails {
  return Object.freeze({ type: `urn:matterlab:problem:${code.toLowerCase().replaceAll('_', '-')}`, title: code.replaceAll('_', ' '), status, detail, code });
}
export class LabRuntimeError extends Error {
  readonly problem: ProblemDetails;
  constructor(value: ProblemDetails) {
    super(value.detail);
    this.name = 'LabRuntimeError';
    this.problem = value;
  }
}
export function fail(code: LabErrorCode, detail: string, status = 422): never {
  throw new LabRuntimeError(problem(code, detail, status));
}
export function asProblem(error: unknown): ProblemDetails {
  if (error instanceof LabRuntimeError) return error.problem;
  if (error instanceof ContractValidationError) return error.problem;
  return problem('RUNTIME_ERROR', error instanceof Error ? error.message : 'Laboratory runtime failed.', 500);
}
