import type { EquilibriumInput, EquilibriumResult, PreparationInput, PreparationResult } from '@matterlab/contracts';
import { getAnalyticalComponentDefinitions, getReagentDefinitions } from './catalog.js';
import { getIndicatorDefinitions } from './indicators.js';
import { getScienceMethod, MODEL_LIMITS, SCIENCE_METHOD_ID, SCIENCE_METHOD_VERSION } from './model.js';
import { prepareSolution } from './prepare.js';
import { failure } from './provenance.js';
import { solveEquilibrium } from './solver.js';
import { getScienceSources } from './sources.js';
import { getTitrationReference, type TitrationReferenceInput, type TitrationReferenceResult } from './titration.js';
import { isRecord } from './validation.js';

export type ScienceRequest =
  | { readonly schemaVersion: 1; readonly operation: 'equilibrium'; readonly input: EquilibriumInput }
  | { readonly schemaVersion: 1; readonly operation: 'prepare'; readonly input: PreparationInput }
  | { readonly schemaVersion: 1; readonly operation: 'titration-reference'; readonly input: TitrationReferenceInput }
  | { readonly schemaVersion: 1; readonly operation: 'catalog' };

export type ScienceResponse = EquilibriumResult | PreparationResult | TitrationReferenceResult | ReturnType<typeof getScienceCatalog>;

export function getScienceCatalog() {
  return {
    schemaVersion: 1 as const,
    methodId: SCIENCE_METHOD_ID,
    methodVersion: SCIENCE_METHOD_VERSION,
    catalogStatus: 'CURATED' as const,
    method: getScienceMethod(),
    analyticalComponents: getAnalyticalComponentDefinitions(),
    reagents: getReagentDefinitions(),
    indicators: getIndicatorDefinitions(),
    sources: getScienceSources(),
  };
}

export function executeScienceRequest(request: unknown): ScienceResponse {
  if (!isRecord(request) || request.schemaVersion !== 1 || typeof request.operation !== 'string') {
    return failure('FAILED', 'INVALID_INPUT', 'Expected {schemaVersion:1, operation, input?}.');
  }
  const allowedKeys = request.operation === 'catalog' ? ['schemaVersion', 'operation'] : ['schemaVersion', 'operation', 'input'];
  if (Object.keys(request).some((key) => !allowedKeys.includes(key))) {
    return failure('FAILED', 'INVALID_INPUT', 'Unexpected science request field; no options or units are silently interpreted.');
  }
  switch (request.operation) {
    case 'equilibrium': return solveEquilibrium(request.input as EquilibriumInput);
    case 'prepare': return prepareSolution(request.input as PreparationInput);
    case 'titration-reference': return getTitrationReference(request.input as TitrationReferenceInput);
    case 'catalog': return getScienceCatalog();
    default: return failure('FAILED', 'INVALID_INPUT', `Unknown science operation '${request.operation}'.`);
  }
}

export function solveJson(inputJson: string): string {
  if (typeof inputJson !== 'string' || new TextEncoder().encode(inputJson).byteLength > MODEL_LIMITS.maximumJsonBytes) {
    return JSON.stringify(failure('FAILED', 'INVALID_INPUT', `Science JSON input must be at most ${MODEL_LIMITS.maximumJsonBytes} UTF-8 bytes.`));
  }
  let request: unknown;
  try {
    request = JSON.parse(inputJson);
  } catch {
    return JSON.stringify(failure('FAILED', 'INVALID_INPUT', 'Input is not valid JSON.'));
  }
  return JSON.stringify(executeScienceRequest(request));
}
