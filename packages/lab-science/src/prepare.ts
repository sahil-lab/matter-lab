import type { ContainerContents, PreparationInput, PreparationResult } from '@matterlab/contracts';
import { findReagent } from './catalog.js';
import { DEFAULT_ASSUMPTIONS, MODEL_LIMITS, SCIENCE_METHOD_ID } from './model.js';
import { failure, provenance } from './provenance.js';
import { solveEquilibrium } from './solver.js';
import { hasOnlyKeys, isFiniteNumber, isRecord, validatePhysicalConditions } from './validation.js';

export function prepareSolution(input: PreparationInput): PreparationResult {
  if (!isRecord(input) || typeof input.reagentId !== 'string') {
    return failure('FAILED', 'INVALID_INPUT', 'PreparationInput requires a reagentId.');
  }
  if (!hasOnlyKeys(input, ['reagentId', 'volumeL', 'concentrationMolL', 'temperatureK', 'mixing'])) {
    return failure('FAILED', 'INVALID_INPUT', 'Unexpected reagent preparation fields or unit aliases are not supported.');
  }
  const definition = findReagent(input.reagentId);
  if (!definition) return failure('UNSUPPORTED', 'UNSUPPORTED_SPECIES', `Unsupported reagent '${input.reagentId}'.`);
  const temperatureK = input.temperatureK === undefined ? MODEL_LIMITS.temperatureK : input.temperatureK;
  const mixing = input.mixing === undefined ? 'WELL_MIXED' : input.mixing;
  const physicalFailure = validatePhysicalConditions({ volumeL: input.volumeL, temperatureK, mixing }, true);
  if (physicalFailure) return physicalFailure;
  if (!isFiniteNumber(input.concentrationMolL) || input.concentrationMolL < 0) {
    return failure('FAILED', 'INVALID_INPUT', 'concentrationMolL must be finite, nonnegative, and expressed in mol/L.');
  }
  if (definition.role === 'SOLVENT' && input.concentrationMolL !== 0) {
    return failure('FAILED', 'INVALID_INPUT', 'Water has no tracked solute concentration; concentrationMolL must be zero.');
  }
  if (input.concentrationMolL > definition.maximumConcentrationMolL) {
    return failure('UNSUPPORTED', 'UNSUPPORTED_CONDITIONS',
      `Reagent concentration exceeds the ${definition.maximumConcentrationMolL} mol/L validated preparation ceiling.`);
  }
  const reagentMoles = input.volumeL * input.concentrationMolL;
  if (!Number.isFinite(reagentMoles) || (input.concentrationMolL > 0 && reagentMoles === 0)) {
    return failure('UNSUPPORTED', 'UNSUPPORTED_CONDITIONS', 'Requested amount is outside the finite numerical preparation domain.');
  }
  const contents: ContainerContents = {
    volumeL: input.volumeL,
    species: reagentMoles === 0 ? [] : definition.components.map((component) => ({
      speciesId: component.speciesId, moles: component.molesPerMole * reagentMoles,
    })),
    temperatureK,
    mixing,
    modelId: SCIENCE_METHOD_ID,
  };
  // Eligibility is checked by the same solver, but a prepared UNMIXED state does not receive or publish a pH.
  const eligibility = solveEquilibrium({
    contents: { ...contents, mixing: 'WELL_MIXED' },
    methodId: SCIENCE_METHOD_ID,
    assumptions: DEFAULT_ASSUMPTIONS,
  });
  if (eligibility.status !== 'SUCCEEDED') return eligibility;
  const warnings = [...eligibility.warnings];
  if (mixing === 'UNMIXED') warnings.push('UNMIXED: No bulk pH may be displayed until the runtime marks the contents well mixed.');
  return {
    ...provenance({
      reagentId: definition.id,
      reagentFormula: definition.formula,
      formulaBasis: definition.formulaBasis,
      analyticalReagentConcentrationMolL: input.concentrationMolL,
      reagentMoles,
      volumeL: input.volumeL,
      temperatureK,
      inventorySemantics: definition.semantics,
    }, definition.sourceIds, warnings),
    status: 'SUCCEEDED',
    evidence: 'MODEL_CALCULATED',
    contents,
  };
}
