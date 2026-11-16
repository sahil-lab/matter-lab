import type { EquilibriumResult, JsonObject } from '@matterlab/contracts';
import { DEFAULT_ASSUMPTIONS, MODEL_LIMITATIONS, SCIENCE_METHOD_ID, SCIENCE_METHOD_VERSION } from './model.js';

export type ScienceFailure = Exclude<EquilibriumResult, { readonly status: 'SUCCEEDED' }>;
export type ScienceErrorCode = 'INVALID_INPUT' | 'UNSUPPORTED_MODEL' | 'UNSUPPORTED_SPECIES'
  | 'UNSUPPORTED_CONDITIONS' | 'SOLVER_FAILED';

export function provenance(
  diagnostics: JsonObject = {},
  sourceIds: readonly string[] = ['openstax-chem2e-14-2'],
  warnings: readonly string[] = [],
) {
  return {
    methodId: SCIENCE_METHOD_ID,
    methodVersion: SCIENCE_METHOD_VERSION,
    sourceIds: [...new Set(sourceIds)].sort(),
    warnings: [...warnings],
    assumptions: [...DEFAULT_ASSUMPTIONS],
    limitations: [...MODEL_LIMITATIONS],
    diagnostics,
  };
}

export function failure(
  status: 'FAILED' | 'UNSUPPORTED',
  code: ScienceErrorCode,
  detail: string,
  diagnostics: JsonObject = {},
): ScienceFailure {
  const common = provenance(diagnostics);
  const error = {
    type: `urn:matterlab:science:${code.toLowerCase().replaceAll('_', '-')}`,
    title: status === 'UNSUPPORTED' ? 'Chemistry is outside the validated model' : 'Chemistry calculation failed',
    status: code === 'SOLVER_FAILED' ? 500 : status === 'FAILED' ? 400 : 422,
    code,
    detail,
  };
  return status === 'FAILED'
    ? { ...common, status: 'FAILED', evidence: 'UNVERIFIED', error }
    : { ...common, status: 'UNSUPPORTED', evidence: 'UNSUPPORTED', error };
}
