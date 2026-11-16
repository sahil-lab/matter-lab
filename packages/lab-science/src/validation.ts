import type { ContainerContents } from '@matterlab/contracts';
import { isAnalyticalComponentId, type AnalyticalComponentId } from './catalog.js';
import { DEFAULT_ASSUMPTIONS, MODEL_LIMITS, SCIENCE_METHOD_ID } from './model.js';
import { stableSum } from './numerics.js';
import { failure, type ScienceFailure } from './provenance.js';

export interface ValidatedComposition {
  readonly contents: ContainerContents;
  readonly concentrations: Readonly<Record<AnalyticalComponentId, number>>;
  readonly moles: Readonly<Record<AnalyticalComponentId, number>>;
  readonly strongChargeMolL: number;
  readonly acidOffsetMolL: number;
  readonly baseOffsetMolL: number;
  readonly totalAnalyticalConcentrationMolL: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

export function exceedsLimit(value: number, limit: number): boolean {
  return value > limit + Math.max(1e-12, limit * 1e-12);
}

export function validateAssumptions(value: unknown): ScienceFailure | undefined {
  if (!Array.isArray(value) || value.length > 16 || value.some((item) => typeof item !== 'string')) {
    return failure('FAILED', 'INVALID_INPUT', 'assumptions must be an array of explicit model assumption identifiers.');
  }
  if (DEFAULT_ASSUMPTIONS.some((assumption) => !value.includes(assumption))
    || value.some((assumption) => !DEFAULT_ASSUMPTIONS.includes(assumption))) {
    return failure('UNSUPPORTED', 'UNSUPPORTED_CONDITIONS',
      `This model requires exactly the supported assumptions: ${DEFAULT_ASSUMPTIONS.join(', ')}.`);
  }
  return undefined;
}

export function validatePhysicalConditions(value: Record<string, unknown>, allowUnmixed = false): ScienceFailure | undefined {
  if (!isFiniteNumber(value.volumeL) || value.volumeL <= 0) {
    return failure('FAILED', 'INVALID_INPUT', 'volumeL must be finite and strictly positive, in liters.');
  }
  if (value.volumeL < MODEL_LIMITS.minimumVolumeL || value.volumeL > MODEL_LIMITS.maximumVolumeL) {
    return failure('UNSUPPORTED', 'UNSUPPORTED_CONDITIONS',
      `Supported volumes are ${MODEL_LIMITS.minimumVolumeL} through ${MODEL_LIMITS.maximumVolumeL} L.`);
  }
  if (!isFiniteNumber(value.temperatureK) || value.temperatureK <= 0) {
    return failure('FAILED', 'INVALID_INPUT', 'temperatureK must be a finite, positive absolute temperature.');
  }
  if (value.temperatureK !== MODEL_LIMITS.temperatureK) {
    return failure('UNSUPPORTED', 'UNSUPPORTED_CONDITIONS',
      'Only 298.15 K (25 deg C) is validated; temperature-dependent Kw/Ka/Kb are not extrapolated.',
      { requestedTemperatureK: value.temperatureK, supportedTemperatureK: MODEL_LIMITS.temperatureK });
  }
  if (value.mixing !== 'WELL_MIXED' && value.mixing !== 'UNMIXED') {
    return failure('FAILED', 'INVALID_INPUT', 'mixing must explicitly be WELL_MIXED or UNMIXED.');
  }
  if (value.mixing === 'UNMIXED' && !allowUnmixed) {
    return failure('UNSUPPORTED', 'UNSUPPORTED_CONDITIONS',
      'A spatially unmixed inventory has no single bulk equilibrium pH. Mix before requesting this model.');
  }
  return undefined;
}

export function validateContents(value: unknown, allowUnmixed = false): ValidatedComposition | ScienceFailure {
  if (!isRecord(value)) return failure('FAILED', 'INVALID_INPUT', 'contents must be a ContainerContents object.');
  if (!hasOnlyKeys(value, ['volumeL', 'species', 'temperatureK', 'mixing', 'modelId'])) {
    return failure('FAILED', 'INVALID_INPUT', 'Unknown contents fields are not supported; solvent or condition modifiers are never ignored.');
  }
  const conditionsFailure = validatePhysicalConditions(value, allowUnmixed);
  if (conditionsFailure) return conditionsFailure;
  if (typeof value.modelId !== 'string') {
    return failure('FAILED', 'INVALID_INPUT', 'contents.modelId is required.');
  }
  if (value.modelId !== SCIENCE_METHOD_ID) {
    return failure('UNSUPPORTED', 'UNSUPPORTED_MODEL', `Unsupported contents.modelId: ${value.modelId}.`);
  }
  if (!Array.isArray(value.species) || value.species.length > MODEL_LIMITS.maximumInventoryEntries) {
    return failure('FAILED', 'INVALID_INPUT',
      `species must be an analytical-inventory array of at most ${MODEL_LIMITS.maximumInventoryEntries} entries.`);
  }
  const buckets: Record<AnalyticalComponentId, number[]> = {
    'ion:sodium': [], 'ion:chloride': [], 'family:acetate': [], 'family:ammonia': [],
  };
  for (let index = 0; index < value.species.length; index++) {
    const entry: unknown = value.species[index];
    if (!isRecord(entry) || typeof entry.speciesId !== 'string'
      || !isFiniteNumber(entry.moles) || entry.moles < 0
      || !hasOnlyKeys(entry, ['speciesId', 'moles', 'sourceId'])
      || (entry.sourceId !== undefined && (typeof entry.sourceId !== 'string' || entry.sourceId.length > 512))) {
      return failure('FAILED', 'INVALID_INPUT',
        `species[${index}] requires a speciesId and finite, nonnegative moles; sourceId, when present, is a string.`);
    }
    if (!isAnalyticalComponentId(entry.speciesId)) {
      return failure('UNSUPPORTED', 'UNSUPPORTED_SPECIES',
        `Unresolved or unsupported analytical component '${entry.speciesId}'. Use prepareSolution; do not provide intact HCl, free H3O+/OH-, polyprotic species, or equilibrium-family members.`,
        { unsupportedSpeciesId: entry.speciesId, inventoryIndex: index });
    }
    buckets[entry.speciesId].push(entry.moles);
  }
  const volumeL = value.volumeL as number;
  const moles: Record<AnalyticalComponentId, number> = {
    'ion:sodium': stableSum(buckets['ion:sodium']),
    'ion:chloride': stableSum(buckets['ion:chloride']),
    'family:acetate': stableSum(buckets['family:acetate']),
    'family:ammonia': stableSum(buckets['family:ammonia']),
  };
  const concentrations: Record<AnalyticalComponentId, number> = {
    'ion:sodium': moles['ion:sodium'] / volumeL,
    'ion:chloride': moles['ion:chloride'] / volumeL,
    'family:acetate': moles['family:acetate'] / volumeL,
    'family:ammonia': moles['family:ammonia'] / volumeL,
  };
  for (const [speciesId, concentration] of Object.entries(concentrations)) {
    if (concentration === 0 && moles[speciesId as AnalyticalComponentId] > 0) {
      return failure('UNSUPPORTED', 'UNSUPPORTED_CONDITIONS', 'Positive analytical amount underflows the finite concentration domain.');
    }
    if (!Number.isFinite(concentration) || exceedsLimit(concentration, MODEL_LIMITS.maximumComponentConcentrationMolL)) {
      return failure('UNSUPPORTED', 'UNSUPPORTED_CONDITIONS',
        `Analytical component '${speciesId}' exceeds the ${MODEL_LIMITS.maximumComponentConcentrationMolL} mol/L model ceiling.`);
    }
  }
  const totalAnalyticalConcentrationMolL = stableSum(Object.values(concentrations));
  if (exceedsLimit(totalAnalyticalConcentrationMolL, MODEL_LIMITS.maximumTotalAnalyticalConcentrationMolL)) {
    return failure('UNSUPPORTED', 'UNSUPPORTED_CONDITIONS',
      `Total analytical-component concentration exceeds ${MODEL_LIMITS.maximumTotalAnalyticalConcentrationMolL} mol/L.`);
  }
  if (moles['family:acetate'] > 0 && moles['family:ammonia'] > 0) {
    return failure('UNSUPPORTED', 'UNSUPPORTED_SPECIES',
      'Mixed acetate and ammonia families are outside the validated v1 scope, even though a more general model could solve them.');
  }
  return {
    contents: value as unknown as ContainerContents,
    concentrations, moles, totalAnalyticalConcentrationMolL,
    strongChargeMolL: stableSum([moles['ion:sodium'], -moles['ion:chloride']]) / volumeL,
    acidOffsetMolL: stableSum([moles['ion:sodium'], -moles['ion:chloride'], -moles['family:acetate']]) / volumeL,
    baseOffsetMolL: stableSum([moles['ion:sodium'], -moles['ion:chloride'], moles['family:ammonia']]) / volumeL,
  };
}
