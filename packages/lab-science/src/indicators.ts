import type { IndicatorResult, JsonObject } from '@matterlab/contracts';
import { failure, type ScienceFailure } from './provenance.js';

export interface IndicatorDefinition {
  readonly id: string;
  readonly label: string;
  readonly effectivePKa: number;
  readonly transitionRangePH: readonly [number, number];
  readonly supportedPHRange: readonly [number, number];
  readonly acidColorName: string;
  readonly baseColorName: string;
  readonly acidColorSrgb: readonly [number, number, number];
  readonly midpointColorSrgb: readonly [number, number, number];
  readonly baseColorSrgb: readonly [number, number, number];
  readonly sourceIds: readonly string[];
  readonly limitations: string;
}

const definitions: readonly IndicatorDefinition[] = [
  {
    id: 'phenolphthalein', label: 'Phenolphthalein', effectivePKa: 9.5,
    transitionRangePH: [8.3, 10], supportedPHRange: [0, 12],
    acidColorName: 'colorless', baseColorName: 'pink',
    acidColorSrgb: [1, 1, 1], midpointColorSrgb: [0.96, 0.555, 0.75], baseColorSrgb: [0.92, 0.11, 0.5],
    sourceIds: ['libretexts-indicators-24301'],
    limitations: 'Effective two-state trace model, not full multiprotic phenolphthalein chemistry. Strongly alkaline fading above pH 12 is unsupported. White means no dye tint, not opaque white liquid.',
  },
  {
    id: 'methyl-orange', label: 'Methyl orange', effectivePKa: -Math.log10(4e-4),
    transitionRangePH: [3.1, 4.4], supportedPHRange: [0, 14],
    acidColorName: 'red', baseColorName: 'yellow',
    acidColorSrgb: [0.88, 0.12, 0.12], midpointColorSrgb: [1, 0.46, 0.02], baseColorSrgb: [1, 0.85, 0.06],
    sourceIds: ['openstax-chem2e-14-7'],
    limitations: 'Effective two-state trace model. sRGB colors are illustrative anchors, not measured spectra or absorbance.',
  },
  {
    id: 'bromothymol-blue', label: 'Bromothymol blue', effectivePKa: 7.2,
    transitionRangePH: [6, 7.6], supportedPHRange: [0, 14],
    acidColorName: 'yellow', baseColorName: 'blue',
    acidColorSrgb: [1, 0.8, 0.07], midpointColorSrgb: [0.2, 0.67, 0.23], baseColorSrgb: [0.04, 0.25, 0.9],
    sourceIds: ['harvard-bromothymol-blue-demo'],
    limitations: 'University demonstration effective pKa, not a temperature-calibrated thermodynamic constant. Other protonation states are not modeled; green midpoint and sRGB anchors are illustrative, not optical predictions.',
  },
];

export function getIndicatorDefinitions(): readonly IndicatorDefinition[] {
  return definitions.map((entry) => ({
    ...entry,
    transitionRangePH: [...entry.transitionRangePH],
    supportedPHRange: [...entry.supportedPHRange],
    acidColorSrgb: [...entry.acidColorSrgb],
    midpointColorSrgb: [...entry.midpointColorSrgb],
    baseColorSrgb: [...entry.baseColorSrgb],
    sourceIds: [...entry.sourceIds],
  }));
}

export function findIndicator(id: string): IndicatorDefinition | undefined {
  return getIndicatorDefinitions().find((entry) => entry.id === id);
}

export function validateIndicatorIds(value: unknown): readonly string[] | ScienceFailure {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 3 || value.some((id) => typeof id !== 'string')) {
    return failure('FAILED', 'INVALID_INPUT', 'indicatorIds must contain at most three supported indicator identifiers.');
  }
  for (const id of value) {
    if (!findIndicator(id)) return failure('UNSUPPORTED', 'UNSUPPORTED_SPECIES', `Unsupported indicator '${id}'.`);
  }
  return [...new Set(value as string[])].sort();
}

export function evaluateIndicators(
  ids: readonly string[],
  pH: number,
): { indicators: IndicatorResult[]; diagnostics: JsonObject[]; sourceIds: string[] } | ScienceFailure {
  const indicators: IndicatorResult[] = [];
  const diagnostics: JsonObject[] = [];
  const sourceIds: string[] = [];
  for (const indicatorId of ids) {
    const definition = findIndicator(indicatorId);
    if (!definition) return failure('UNSUPPORTED', 'UNSUPPORTED_SPECIES', `Unsupported indicator '${indicatorId}'.`);
    const [minimum, maximum] = definition.supportedPHRange;
    if (pH < minimum - 1e-10 || pH > maximum + 1e-10) {
      return failure('UNSUPPORTED', 'UNSUPPORTED_CONDITIONS',
        `The '${indicatorId}' display model is only supported from pH ${minimum} to ${maximum}; request equilibrium without this indicator rather than fabricating its color.`,
        { unsupportedIndicatorId: indicatorId, supportedPHRange: [minimum, maximum] });
    }
    const baseFraction = 1 / (1 + 10 ** (definition.effectivePKa - pH));
    const low = baseFraction <= 0.5 ? definition.acidColorSrgb : definition.midpointColorSrgb;
    const high = baseFraction <= 0.5 ? definition.midpointColorSrgb : definition.baseColorSrgb;
    const fraction = baseFraction <= 0.5 ? 2 * baseFraction : 2 * baseFraction - 1;
    const channel = (index: 0 | 1 | 2) => low[index] + (high[index] - low[index]) * fraction;
    const colorSrgb: readonly [number, number, number] = [channel(0), channel(1), channel(2)];
    indicators.push({
      indicatorId, baseFraction, colorSrgb, colorEvidence: 'ILLUSTRATIVE', sourceIds: [...definition.sourceIds],
    });
    sourceIds.push(...definition.sourceIds);
    diagnostics.push({
      indicatorId, effectivePKa: definition.effectivePKa, acidFraction: 1 - baseFraction, baseFraction,
      transitionRangePH: [...definition.transitionRangePH],
      supportedPHRange: [...definition.supportedPHRange],
      fractionEvidence: 'MODEL_CALCULATED',
      colorModel: 'Piecewise linear interpolation in display sRGB through original illustrative color anchors.',
      traceApproximation: 'Indicator amounts are negligible and excluded from bulk mass/charge balances.',
      endpointNote: 'A color threshold is an operational endpoint, not stoichiometric equivalence or an observed persistent endpoint.',
      limitations: definition.limitations,
    });
  }
  return { indicators, diagnostics, sourceIds };
}
