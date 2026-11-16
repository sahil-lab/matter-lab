import type { ContainerContents, EquilibriumInput, EquilibriumResult, PreparationInput } from '@matterlab/contracts';
import { DEFAULT_ASSUMPTIONS, prepareSolution, SCIENCE_METHOD_ID, solveEquilibrium } from '../src/index.js';

export function prepared(reagentId: string, volumeL = 0.025, concentrationMolL = 0.1): ContainerContents {
  const result = prepareSolution({ reagentId, volumeL, concentrationMolL });
  if (result.status !== 'SUCCEEDED') throw new Error(result.error.detail);
  return result.contents;
}

export function inputFor(contents: ContainerContents, indicatorIds?: readonly string[]): EquilibriumInput {
  return { contents, methodId: SCIENCE_METHOD_ID, assumptions: DEFAULT_ASSUMPTIONS, ...(indicatorIds ? { indicatorIds } : {}) };
}

export function succeeded(result: EquilibriumResult): Extract<EquilibriumResult, { status: 'SUCCEEDED' }> {
  if (result.status !== 'SUCCEEDED') throw new Error(result.error.detail);
  return result;
}

export function mixture(preparations: readonly PreparationInput[], indicatorIds?: readonly string[]) {
  const contents = preparations.map((input) => {
    const result = prepareSolution(input);
    if (result.status !== 'SUCCEEDED') throw new Error(result.error.detail);
    return result.contents;
  });
  return succeeded(solveEquilibrium(inputFor({
    volumeL: contents.reduce((sum, item) => sum + item.volumeL, 0),
    species: contents.flatMap((item) => item.species),
    temperatureK: 298.15, mixing: 'WELL_MIXED', modelId: SCIENCE_METHOD_ID,
  }, indicatorIds)));
}

export function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDeep(child);
  }
  return value;
}
