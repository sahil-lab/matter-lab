/**
 * Builds the mini-lab notebook — trial table, pH-vs-volume curves and a short conclusion — purely
 * from `EvaluationContext`'s trials (Agent 07's event log + Agent 06's run results). Every number
 * shown either comes from a real observation/run result or is explicitly `null` with no sentence
 * written about it: nothing here is invented to fill a gap.
 */

import type { Evidence, Observation } from '../contracts';
import { equivalenceVolumeL, observationsOfType } from '../goals';
import type { EvaluationContext, Objective, TrialRecord } from '../goals';
import { mean, rsdPercent, sampleStdDev } from '../scoring/math';
import { orderedTransfers, trialReferenceQuantities } from '../scoring/signals';
import type { TransferSample } from '../scoring/signals';
import type { NotebookConclusion, NotebookCurve, NotebookData, NotebookTrialRow } from './types';

function trialEvidence(trial: TrialRecord): Evidence {
  const last = trial.runResults[trial.runResults.length - 1];
  if (!last) return 'UNSUPPORTED';
  if (last.status === 'SUCCEEDED') return 'MODEL_CALCULATED';
  if (last.status === 'UNSUPPORTED') return 'UNSUPPORTED';
  return 'UNVERIFIED';
}

function cumulativeVolumeAtTime(transfers: readonly TransferSample[], timeS: number): number {
  let total = 0;
  for (const t of transfers) if (t.atSimulationS <= timeS) total += t.volumeL;
  return total;
}

function buildRow(trial: TrialRecord, index: number): NotebookTrialRow {
  const deliveredVolumeL = trial.endpoint?.deliveredVolumeL ?? null;
  const equivalence = equivalenceVolumeL(trial.runResults) ?? null;
  const deviationL = deliveredVolumeL !== null && equivalence !== null ? Math.abs(deliveredVolumeL - equivalence) : null;
  const ref = trialReferenceQuantities(trial);
  const expectedAnalyteMolarity =
    deliveredVolumeL !== null && ref.titrantMolarityMolPerL !== undefined && ref.analyteVolumeL ? (ref.titrantMolarityMolPerL * deliveredVolumeL) / ref.analyteVolumeL : null;
  return {
    trialId: trial.trialId,
    index,
    deliveredVolumeL,
    equivalenceVolumeL: equivalence,
    deviationL,
    reportedAnalyteMolarity: trial.reportedAnalyteMolarity ?? null,
    expectedAnalyteMolarity,
    evidence: trialEvidence(trial),
  };
}

function buildCurve(trial: TrialRecord, index: number): NotebookCurve {
  const phObservations: Observation[] = [...observationsOfType(trial.runResults, 'PH')].sort((a, b) => a.timeS - b.timeS);
  const transfers = orderedTransfers(trial.events);
  const points = phObservations.map((obs) => ({ volumeL: cumulativeVolumeAtTime(transfers, obs.timeS), ph: obs.quantity.value }));
  const evidence = phObservations.length > 0 ? (phObservations.every((o) => o.evidence === 'REFERENCE_MEASURED') ? 'REFERENCE_MEASURED' : phObservations[0]!.evidence) : 'UNSUPPORTED';
  return { trialId: trial.trialId, trialIndex: index, points, evidence };
}

function buildConclusion(objective: Objective, rows: readonly NotebookTrialRow[], meanVolumeL: number | null, rsd: number | null): NotebookConclusion {
  const completed = rows.filter((r) => r.deliveredVolumeL !== null);
  if (completed.length === 0) {
    return { headline: 'No completed trial yet.', paragraphs: ['Finish a titration and mark the endpoint to generate a conclusion.'], evidence: 'UNSUPPORTED' };
  }
  const paragraphs: string[] = [];
  if (meanVolumeL !== null) paragraphs.push(`Mean measured endpoint volume across ${completed.length} trial(s): ${(meanVolumeL * 1000).toFixed(2)} mL.`);
  if (rsd !== null) paragraphs.push(`Relative standard deviation of the endpoint volume: ${rsd.toFixed(2)}%.`);

  const withEquivalence = completed.filter((r) => r.equivalenceVolumeL !== null && r.deviationL !== null);
  let evidence: Evidence = 'UNVERIFIED';
  if (withEquivalence.length > 0) {
    const avgDeviation = mean(withEquivalence.map((r) => r.deviationL!));
    paragraphs.push(`Average deviation from the solver's computed equivalence point: ${(avgDeviation * 1000).toFixed(2)} mL.`);
    evidence = 'MODEL_CALCULATED';
  }
  const withExpected = completed.filter((r) => r.expectedAnalyteMolarity !== null);
  if (withExpected.length > 0) {
    const avgExpected = mean(withExpected.map((r) => r.expectedAnalyteMolarity!));
    paragraphs.push(`Analyte molarity implied by the measured endpoint volume: ${avgExpected.toFixed(4)} mol/L.`);
  }
  return { headline: `${completed.length} of ${objective.requiredTrials} required trial(s) recorded for "${objective.title}".`, paragraphs, evidence };
}

export function buildNotebook(objective: Objective, ctx: EvaluationContext): NotebookData {
  const rows = ctx.trials.map((trial, i) => buildRow(trial, i + 1));
  const curves = ctx.trials.map((trial, i) => buildCurve(trial, i + 1));
  const volumes = rows.map((r) => r.deliveredVolumeL).filter((v): v is number => v !== null);
  const meanVolumeL = volumes.length > 0 ? mean(volumes) : null;
  const stdDevVolumeL = volumes.length >= 2 ? sampleStdDev(volumes) : null;
  const rsd = volumes.length >= 2 ? rsdPercent(volumes) : null;
  return {
    objectiveTitle: objective.title,
    rows,
    curves,
    meanVolumeL,
    stdDevVolumeL,
    rsdPercent: rsd,
    conclusion: buildConclusion(objective, rows, meanVolumeL, rsd),
    generatedAtSimulationS: ctx.nowSimulationS,
  };
}
