/**
 * Provisional strong-acid/strong-base titration method.
 *
 * This is Agent 09's own stand-in, written only so the run-lifecycle/persistence layer this file
 * sits behind (lab_run, lab_observation, SSE progress, cancellation) has a real, deterministic,
 * documented calculation to exercise end to end while Agent 06 (authoritative chemistry solver)
 * and Agent 07 (authoritative apparatus reducer) are developed in their own worktrees. It must be
 * reconciled with Agent 06/07's implementation by the orchestrator; see the integration report.
 *
 * Method: exact charge-balance solution for a monoprotic strong acid titrated by a monoprotic
 * strong base (or vice versa), including water autoionization, which is the textbook model the
 * shared contract names explicitly ("calculate pH using strong acid/base equilibrium with water
 * dissociation and appropriate finite-volume assumptions"):
 *
 *   Cexcess(v) = (Ca*Va - Cb*v) / (Va + v)          [mol/L, positive = excess acid]
 *   [H+] - Kw/[H+] = Cexcess                         (charge balance + water equilibrium)
 *   [H+] = (Cexcess + sqrt(Cexcess^2 + 4*Kw)) / 2     (positive root of the resulting quadratic)
 *   pH = -log10([H+])
 *
 * Kw = 1.0e-14 is the standard introductory-analytical-chemistry value at 298.15 K (25 degC); it is
 * not re-derived from ionic strength or temperature here. This is an ideal-solution model: complete
 * dissociation, no activity coefficients, well-mixed, isothermal.
 */
import type { ApparatusInstance, ContainerContents, Observation } from '@matterlab/contracts-lab';

export const METHOD_ID = 'titration.strong_acid_strong_base.charge_balance.v1';
export const METHOD_VERSION = '1.0.0';
export const KW_298K = 1.0e-14;

/** charge = number of protons (acid) or hydroxide equivalents (base) per formula unit. */
const STRONG_ACIDS: Readonly<Record<string, number>> = { 'HCl(aq)': 1, 'HNO3(aq)': 1, 'HBr(aq)': 1, 'HI(aq)': 1, 'HClO4(aq)': 1 };
const STRONG_BASES: Readonly<Record<string, number>> = { 'NaOH(aq)': 1, 'KOH(aq)': 1, 'LiOH(aq)': 1 };
/** Species tolerated alongside the analyte/titrant without being modeled (they do not change pH in this ideal model). */
const SPECTATOR_SPECIES = new Set(['Phenolphthalein(aq)', 'H2O(l)', 'MethylOrange(aq)', 'BromothymolBlue(aq)']);

export interface ClassifiedContainer {
  readonly speciesId: string;
  readonly charge: number;
  readonly concentrationMolPerL: number;
  readonly volumeL: number;
  readonly temperatureK: number;
  readonly spectatorsExcluded: readonly string[];
}

export type ClassifyResult = { supported: true; container: ClassifiedContainer } | { supported: false; reason: string };

function classify(contents: ContainerContents, table: Readonly<Record<string, number>>, roleLabel: string): ClassifyResult {
  if (contents.volumeL <= 0) return { supported: false, reason: `The ${roleLabel} container has no volume.` };
  const recognized = contents.species.filter((s) => s.speciesId in table);
  const spectators = contents.species.filter((s) => SPECTATOR_SPECIES.has(s.speciesId));
  const unrecognized = contents.species.filter((s) => !(s.speciesId in table) && !SPECTATOR_SPECIES.has(s.speciesId));
  if (unrecognized.length > 0) {
    return {
      supported: false,
      reason: `The ${roleLabel} container has species this method does not model: ${unrecognized.map((s) => s.speciesId).join(', ')}.`,
    };
  }
  if (recognized.length !== 1) {
    return {
      supported: false,
      reason: `The ${roleLabel} container must contain exactly one recognised strong ${table === STRONG_ACIDS ? 'acid' : 'base'}; found ${recognized.length}.`,
    };
  }
  const species = recognized[0];
  return {
    supported: true,
    container: {
      speciesId: species.speciesId,
      charge: table[species.speciesId],
      concentrationMolPerL: species.moles / contents.volumeL,
      volumeL: contents.volumeL,
      temperatureK: contents.temperatureK,
      spectatorsExcluded: spectators.map((s) => s.speciesId),
    },
  };
}

export type AnalyteClassification = { supported: true; isAcid: boolean; container: ClassifiedContainer } | { supported: false; reason: string };

export function classifyAnalyte(contents: ContainerContents): AnalyteClassification {
  const asAcid = classify(contents, STRONG_ACIDS, 'analyte');
  if (asAcid.supported) return { supported: true, isAcid: true, container: asAcid.container };
  const asBase = classify(contents, STRONG_BASES, 'analyte');
  if (asBase.supported) return { supported: true, isAcid: false, container: asBase.container };
  // Prefer the acid-table reason: the contract's vertical slice (acid analyte, base titrant) is the common case.
  return asAcid;
}

export function classifyTitrant(contents: ContainerContents, analyteIsAcid: boolean): ClassifyResult {
  // The titrant must be the opposite kind of the analyte (acid analyte -> base titrant, or vice versa).
  return classify(contents, analyteIsAcid ? STRONG_BASES : STRONG_ACIDS, 'titrant');
}

/** Positive sign = acid equivalents, negative = base equivalents, so the two sides of a titration combine by subtraction. */
function signedConcentration(container: ClassifiedContainer, isAcid: boolean): number {
  return (isAcid ? 1 : -1) * container.charge * container.concentrationMolPerL;
}

export function phAt(analyte: ClassifiedContainer, analyteIsAcid: boolean, titrant: ClassifiedContainer, deliveredVolumeL: number, kw: number = KW_298K): number {
  const totalVolumeL = analyte.volumeL + deliveredVolumeL;
  const analyteSigned = signedConcentration(analyte, analyteIsAcid) * analyte.volumeL;
  const titrantSigned = signedConcentration(titrant, !analyteIsAcid) * deliveredVolumeL;
  const excess = (analyteSigned + titrantSigned) / totalVolumeL;
  const hydrogenIon = (excess + Math.sqrt(excess * excess + 4 * kw)) / 2;
  return -Math.log10(hydrogenIon);
}

export interface TitrationStep {
  readonly atSimulationS: number;
  readonly cumulativeDeliveredVolumeL: number;
  readonly actionId: string;
}

export interface TitrationObservationSet {
  readonly observations: Observation[];
  readonly warnings: string[];
  readonly assumptions: readonly string[];
}

export const ASSUMPTIONS: readonly string[] = [
  `Ideal strong-acid/strong-base charge-balance equilibrium with water autoionization (Kw = ${KW_298K.toExponential(1)} at 298.15 K).`,
  'Complete dissociation of the strong acid and strong base; concentrations are used directly, not activities.',
  'Well-mixed, isothermal, negligible volume contraction on mixing (volumes add linearly).',
  'Only the single recognised strong-acid/strong-base pair is modeled; any other species present is excluded from the equilibrium (see warnings).',
];

export function computeTitrationObservations(
  analyte: ClassifiedContainer,
  analyteIsAcid: boolean,
  analyteApparatusId: string,
  titrant: ClassifiedContainer,
  titrantApparatusId: string,
  steps: readonly TitrationStep[],
): TitrationObservationSet {
  const warnings: string[] = [];
  for (const excluded of [...analyte.spectatorsExcluded, ...titrant.spectatorsExcluded]) {
    warnings.push(`${excluded} is present but is not part of the strong-acid/strong-base equilibrium model; it does not affect the computed pH.`);
  }
  const observations: Observation[] = [];
  const emit = (timeS: number, deliveredVolumeL: number) => {
    const ph = phAt(analyte, analyteIsAcid, titrant, deliveredVolumeL);
    observations.push({
      type: 'VOLUME',
      apparatusId: titrantApparatusId,
      timeS,
      quantity: { value: deliveredVolumeL, unit: 'L' },
      evidence: 'MODEL_CALCULATED',
      methodId: METHOD_ID,
      sourceIds: [METHOD_ID],
    });
    observations.push({
      type: 'PH',
      apparatusId: analyteApparatusId,
      timeS,
      quantity: { value: ph, unit: 'pH' },
      evidence: 'MODEL_CALCULATED',
      methodId: METHOD_ID,
      sourceIds: [METHOD_ID],
    });
  };
  emit(0, 0);
  for (const step of steps) {
    if (step.cumulativeDeliveredVolumeL > titrant.volumeL + 1e-12) {
      throw new TitrationVolumeExceededError(step.cumulativeDeliveredVolumeL, titrant.volumeL);
    }
    emit(step.atSimulationS, step.cumulativeDeliveredVolumeL);
  }
  return { observations, warnings, assumptions: ASSUMPTIONS };
}

export class TitrationVolumeExceededError extends Error {
  constructor(
    readonly requestedVolumeL: number,
    readonly availableVolumeL: number,
  ) {
    super(`Delivered volume ${(requestedVolumeL * 1000).toFixed(3)} mL exceeds the titrant's available ${(availableVolumeL * 1000).toFixed(3)} mL.`);
    this.name = 'TitrationVolumeExceededError';
  }
}

/** Finds the apparatus id of the single instance with both capabilities, or null if not exactly one. */
export function findSingleInstanceWithCapabilities(apparatus: readonly ApparatusInstance[], required: readonly ApparatusInstance['capabilities'][number][]): string | null {
  const matches = apparatus.filter((a) => required.every((cap) => a.capabilities.includes(cap)));
  return matches.length === 1 ? matches[0].id : null;
}
