import type { PreparationResult, Quantity, ScientificProvenance } from '@matterlab/contracts';
import { copyJson } from './json.ts';
import type { LearningReference, PreparationTarget } from './types.ts';

/** Structural subset of Agent06's TitrationReferenceResult; no chemistry implementation or import side effects. */
export type TitrationReferenceOutput = ScientificProvenance & (
  | {
    readonly status: 'SUCCEEDED';
    readonly evidence: 'MODEL_CALCULATED';
    readonly equivalenceVolume: Quantity<'L'>;
    readonly equivalencePH: Quantity<'pH'>;
    readonly initialConcentration: Quantity<'mol/L'>;
    readonly endpoint?: {
      readonly indicatorId: string;
      readonly estimatedVolume: Quantity<'L'>;
      readonly criterion: string;
      readonly baseFraction: number;
      readonly interpretation: string;
    };
  }
  | {
    readonly status: 'UNSUPPORTED' | 'FAILED';
    readonly evidence: 'UNSUPPORTED' | 'UNVERIFIED';
    readonly error: { readonly detail: string };
  }
);

export function createLearningReference(input: {
  readonly id: string;
  readonly result: TitrationReferenceOutput;
  readonly preparations: readonly {
    readonly role: string;
    readonly label: string;
    readonly sourceId: string;
    readonly result: PreparationResult;
  }[];
}): LearningReference {
  const { result } = input;
  const base = {
    id: input.id, methodId: result.methodId, methodVersion: result.methodVersion, sourceIds: result.sourceIds,
    warnings: result.warnings, assumptions: result.assumptions, limitations: result.limitations,
  };
  if (result.status !== 'SUCCEEDED') {
    return copyJson({ ...base, status: result.status, evidence: result.evidence, reasons: [result.error.detail] });
  }
  const preparations: PreparationTarget[] = [];
  for (const preparation of input.preparations) {
    if (preparation.result.status !== 'SUCCEEDED') {
      return copyJson({ ...base, status: 'UNSUPPORTED', evidence: 'UNSUPPORTED', reasons: [`${preparation.label}: ${preparation.result.error.detail}`] });
    }
    if (preparation.result.methodId !== result.methodId || preparation.result.methodVersion !== result.methodVersion) {
      return copyJson({ ...base, status: 'UNSUPPORTED', evidence: 'UNSUPPORTED', reasons: ['Preparation and reference method versions do not match.'] });
    }
    preparations.push({
      role: preparation.role, label: preparation.label, sourceId: preparation.sourceId, contents: preparation.result.contents,
    });
  }
  return copyJson({
    ...base, status: 'SUPPORTED', evidence: result.evidence, preparations,
    equivalenceVolume: result.equivalenceVolume, equivalencePH: result.equivalencePH,
    initialConcentration: result.initialConcentration,
    ...(result.endpoint ? {
      indicatorEndpoint: {
        indicatorId: result.endpoint.indicatorId, volume: result.endpoint.estimatedVolume,
        criterion: `${result.endpoint.criterion}: ${result.endpoint.baseFraction}`,
        interpretation: result.endpoint.interpretation,
      },
    } : {}),
  });
}

export function endpointTarget(reference: LearningReference): Quantity<'L'> | null {
  return reference.status === 'SUPPORTED' ? reference.indicatorEndpoint?.volume ?? reference.equivalenceVolume : null;
}

export function referenceExplanation(reference: LearningReference): readonly string[] {
  if (reference.status !== 'SUPPORTED') return [...reference.reasons, 'No equivalence or endpoint target is asserted for an unsupported method.'];
  return [
    `Equivalence is the supplied model's stoichiometric reference (${(reference.equivalenceVolume.value * 1000).toFixed(3)} mL), not a button press or a universal pH threshold.`,
    ...(reference.equivalencePH ? [`This method predicts pH ${reference.equivalencePH.value.toFixed(3)} at equivalence under its stated conditions; this is not a universal neutral-pH rule.`] : []),
    reference.indicatorEndpoint
      ? `The indicator model target is ${(reference.indicatorEndpoint.volume.value * 1000).toFixed(3)} mL using ${reference.indicatorEndpoint.criterion}. ${reference.indicatorEndpoint.interpretation}`
      : 'A captured endpoint is the learner-selected current instrument reading. No automatic color threshold or persistent indicator change is inferred.',
    'An indicator color is illustrative; accepted observations and their provenance, not rendered colors, provide evidence.',
    'Scoring tolerances are pedagogical. Across-trial spread describes simulated repeatability, not established experimental uncertainty.',
  ];
}
