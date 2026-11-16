import type { ContainerContents, EquilibriumResult, PreparationInput, Quantity } from '@matterlab/contracts';
import { findReagent } from './catalog.js';
import { findIndicator } from './indicators.js';
import { DEFAULT_ASSUMPTIONS, MODEL_LIMITS, SCIENCE_METHOD_ID } from './model.js';
import { bisect, ROOT_PH_TOLERANCE } from './numerics.js';
import { prepareSolution } from './prepare.js';
import { failure, provenance, type ScienceFailure } from './provenance.js';
import { solveEquilibrium } from './solver.js';
import { hasOnlyKeys, isFiniteNumber, isRecord } from './validation.js';

export interface TitrationReferenceInput {
  readonly analyte: PreparationInput;
  readonly titrantReagentId: string;
  readonly titrantConcentrationMolL: number;
  readonly deliveredVolumeL: number;
  readonly indicatorId?: string;
  readonly endpointBaseFraction?: number;
}

export interface EndpointEstimate {
  readonly indicatorId: string;
  readonly criterion: 'EXPLICIT_BASE_FRACTION';
  readonly baseFraction: number;
  readonly targetPH: Quantity<'pH'>;
  readonly estimatedVolume: Quantity<'L'>;
  readonly offsetFromEquivalence: Quantity<'L'>;
  readonly volumeBracketL: readonly [number, number];
  readonly interpretation: string;
}

export type TitrationReferenceResult = ScienceFailure | (ReturnType<typeof provenance> & {
  readonly status: 'SUCCEEDED';
  readonly evidence: 'MODEL_CALCULATED';
  readonly direction: 'INCREASING_PH' | 'DECREASING_PH';
  readonly initialVolume: Quantity<'L'>;
  readonly initialConcentration: Quantity<'mol/L'>;
  readonly analyteAmount: Quantity<'mol'>;
  readonly titrantConcentration: Quantity<'mol/L'>;
  readonly deliveredVolume: Quantity<'L'>;
  readonly initialPH: Quantity<'pH'>;
  readonly equivalenceVolume: Quantity<'L'>;
  readonly equivalencePH: Quantity<'pH'>;
  readonly halfEquivalenceVolume?: Quantity<'L'>;
  readonly halfEquivalencePH?: Quantity<'pH'>;
  readonly endpoint?: EndpointEstimate;
});

export function getTitrationReference(input: TitrationReferenceInput): TitrationReferenceResult {
  if (!isRecord(input)) return failure('FAILED', 'INVALID_INPUT', 'Expected a TitrationReferenceInput object.');
  if (!hasOnlyKeys(input, ['analyte', 'titrantReagentId', 'titrantConcentrationMolL', 'deliveredVolumeL', 'indicatorId', 'endpointBaseFraction'])) {
    return failure('FAILED', 'INVALID_INPUT', 'Unexpected titration reference options are not silently ignored.');
  }
  const analyte = prepareSolution(input.analyte);
  if (analyte.status !== 'SUCCEEDED') return analyte;
  if (analyte.contents.mixing !== 'WELL_MIXED') {
    return failure('UNSUPPORTED', 'UNSUPPORTED_CONDITIONS', 'A titration reference requires a well-mixed analyte.');
  }
  const titrant = prepareSolution({
    reagentId: input.titrantReagentId, volumeL: 1,
    concentrationMolL: input.titrantConcentrationMolL,
    temperatureK: analyte.contents.temperatureK, mixing: 'WELL_MIXED',
  });
  if (titrant.status !== 'SUCCEEDED') return titrant;
  if (!(input.analyte.concentrationMolL > 0) || !(input.titrantConcentrationMolL > 0)) {
    return failure('UNSUPPORTED', 'UNSUPPORTED_CONDITIONS', 'Positive analyte and titrant concentrations are needed for an equivalence estimate.');
  }
  if (!isFiniteNumber(input.deliveredVolumeL) || input.deliveredVolumeL < 0) {
    return failure('FAILED', 'INVALID_INPUT', 'deliveredVolumeL must be a finite, nonnegative accepted titrant volume in liters.');
  }
  if (analyte.contents.volumeL + input.deliveredVolumeL > MODEL_LIMITS.maximumVolumeL) {
    return failure('UNSUPPORTED', 'UNSUPPORTED_CONDITIONS', 'Delivered plus initial volume exceeds the supported domain.');
  }
  const analyteDefinition = findReagent(input.analyte.reagentId)!;
  const titrantDefinition = findReagent(input.titrantReagentId)!;
  const acidAnalyte = analyteDefinition.role === 'STRONG_ACID' || analyteDefinition.role === 'WEAK_ACID';
  const baseAnalyte = analyteDefinition.role === 'STRONG_BASE' || analyteDefinition.role === 'WEAK_BASE';
  if (!((acidAnalyte && titrantDefinition.role === 'STRONG_BASE')
    || (baseAnalyte && titrantDefinition.role === 'STRONG_ACID'))) {
    return failure('UNSUPPORTED', 'UNSUPPORTED_SPECIES',
      'Reference equivalence is supported for a single strong/weak monoprotic acid with NaOH or strong/weak base with HCl; arbitrary buffers/mixtures have no inferred equivalence.');
  }
  const analyteMoles = input.analyte.volumeL * input.analyte.concentrationMolL;
  const equivalenceVolumeL = analyteMoles / input.titrantConcentrationMolL;
  const maximumDeliveredVolumeL = MODEL_LIMITS.maximumVolumeL - analyte.contents.volumeL;
  if (!Number.isFinite(equivalenceVolumeL) || equivalenceVolumeL <= 0 || equivalenceVolumeL > maximumDeliveredVolumeL) {
    return failure('UNSUPPORTED', 'UNSUPPORTED_CONDITIONS', 'The theoretical equivalence volume lies outside the validated numerical volume domain.');
  }
  const atVolume = (volumeL: number): EquilibriumResult => {
    // These are private hypothetical reference mixtures, never apparatus inventory or runtime transfers.
    const contents: ContainerContents = {
      ...analyte.contents,
      volumeL: analyte.contents.volumeL + volumeL,
      species: [
        ...analyte.contents.species,
        ...titrant.contents.species.map((entry) => ({
          speciesId: entry.speciesId, moles: entry.moles * (volumeL / titrant.contents.volumeL),
        })),
      ],
    };
    return solveEquilibrium({ contents, methodId: SCIENCE_METHOD_ID, assumptions: DEFAULT_ASSUMPTIONS });
  };
  const initial = atVolume(0);
  if (initial.status !== 'SUCCEEDED') return initial;
  const equivalence = atVolume(equivalenceVolumeL);
  if (equivalence.status !== 'SUCCEEDED') return equivalence;
  const weak = analyteDefinition.role === 'WEAK_ACID' || analyteDefinition.role === 'WEAK_BASE';
  const half = weak ? atVolume(equivalenceVolumeL / 2) : undefined;
  if (half && half.status !== 'SUCCEEDED') return half;
  let endpoint: EndpointEstimate | undefined;
  const sourceIds = [...initial.sourceIds, ...equivalence.sourceIds, 'openstax-chem2e-14-7'];
  if (input.indicatorId !== undefined || input.endpointBaseFraction !== undefined) {
    if (typeof input.indicatorId !== 'string' || !isFiniteNumber(input.endpointBaseFraction)
      || input.endpointBaseFraction <= 0 || input.endpointBaseFraction >= 1) {
      return failure('FAILED', 'INVALID_INPUT', 'An endpoint estimate requires an indicatorId and explicit endpointBaseFraction strictly between zero and one.');
    }
    const indicator = findIndicator(input.indicatorId);
    if (!indicator) return failure('UNSUPPORTED', 'UNSUPPORTED_SPECIES', `Unsupported indicator '${input.indicatorId}'.`);
    const fraction = input.endpointBaseFraction;
    const targetPH = indicator.effectivePKa + Math.log10(fraction / (1 - fraction));
    if (targetPH < indicator.supportedPHRange[0] || targetPH > indicator.supportedPHRange[1]) {
      return failure('UNSUPPORTED', 'UNSUPPORTED_CONDITIONS', 'The requested endpoint threshold lies outside the supported indicator pH domain.');
    }
    const initialDifference = initial.pH.value - targetPH;
    const initialResidual = Math.abs(initialDifference) <= ROOT_PH_TOLERANCE ? 0 : initialDifference;
    let sampleFailure: ScienceFailure | undefined;
    const residual = (volumeL: number): number => {
      if (volumeL === 0) return initialResidual;
      const sample = atVolume(volumeL);
      if (sample.status !== 'SUCCEEDED') {
        sampleFailure = sample;
        return NaN;
      }
      return sample.pH.value - targetPH;
    };
    let upper = Math.min(maximumDeliveredVolumeL, 2 * equivalenceVolumeL);
    let upperResidual = residual(upper);
    for (let step = 0; step < 64 && upper < maximumDeliveredVolumeL
      && Math.sign(initialResidual) === Math.sign(upperResidual); step++) {
      upper = Math.min(maximumDeliveredVolumeL, upper * 2);
      upperResidual = residual(upper);
    }
    if (sampleFailure) return sampleFailure;
    if (initialResidual !== 0 && Math.sign(initialResidual) === Math.sign(upperResidual)) {
      return failure('UNSUPPORTED', 'UNSUPPORTED_CONDITIONS',
        'The selected indicator threshold is not crossed in the supported titration interval; no endpoint volume is fabricated.');
    }
    const endpointRoot = bisect(residual, 0, upper, 1e-13);
    if (sampleFailure) return sampleFailure;
    if (!endpointRoot.converged) return failure('FAILED', 'SOLVER_FAILED', 'The endpoint volume root did not converge.');
    endpoint = {
      indicatorId: indicator.id,
      criterion: 'EXPLICIT_BASE_FRACTION',
      baseFraction: fraction,
      targetPH: { value: targetPH, unit: 'pH' },
      estimatedVolume: { value: endpointRoot.value, unit: 'L' },
      offsetFromEquivalence: { value: endpointRoot.value - equivalenceVolumeL, unit: 'L' },
      volumeBracketL: [endpointRoot.lower, endpointRoot.upper],
      interpretation: 'Modeled crossing of an explicitly chosen trace-indicator fraction. This is not stoichiometric equivalence, a measured color, or a persistent endpoint observation.',
    };
    sourceIds.push(...indicator.sourceIds);
  }
  const warnings = [...new Set([...initial.warnings, ...equivalence.warnings])];
  if (endpoint) warnings.push('ENDPOINT_NOT_EQUIVALENCE: A chosen color-fraction threshold has a model-dependent offset from equivalence.');
  return {
    ...provenance({
      basis: 'One proton equivalent per mole for the supported single-reagent acid/base pair.',
      deliveredVolumeOrigin: 'Explicit caller input; must come from cumulative accepted runtime transfers, never total container volume.',
      equivalenceChargeResidualMolL: equivalence.diagnostics.chargeResidualMolL ?? null,
      equivalenceMassResidualMolL: equivalence.diagnostics.maximumMassResidualMolL ?? null,
      halfEquivalenceIsApproximatePKa: weak,
    }, sourceIds, warnings),
    status: 'SUCCEEDED',
    evidence: 'MODEL_CALCULATED',
    direction: acidAnalyte ? 'INCREASING_PH' : 'DECREASING_PH',
    initialVolume: { value: input.analyte.volumeL, unit: 'L' },
    initialConcentration: { value: input.analyte.concentrationMolL, unit: 'mol/L' },
    analyteAmount: { value: analyteMoles, unit: 'mol' },
    titrantConcentration: { value: input.titrantConcentrationMolL, unit: 'mol/L' },
    deliveredVolume: { value: input.deliveredVolumeL, unit: 'L' },
    initialPH: initial.pH,
    equivalenceVolume: { value: equivalenceVolumeL, unit: 'L' },
    equivalencePH: equivalence.pH,
    ...(half?.status === 'SUCCEEDED' ? {
      halfEquivalenceVolume: { value: equivalenceVolumeL / 2, unit: 'L' as const },
      halfEquivalencePH: half.pH,
    } : {}),
    ...(endpoint ? { endpoint } : {}),
  };
}
