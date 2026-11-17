/**
 * Real-event-stream signal extraction for the scoring rubric: reconstructs the chronological
 * sequence of titrant transfers and reads per-trial reference quantities, both strictly from
 * Agent 07's real event log — never from render or animation state.
 */

import type { LabEventRecord, UUID } from '../contracts';
import { firstAppliedFill } from '../goals/context';
import type { TrialRecord } from '../goals';

export interface TransferSample {
  readonly volumeL: number;
  readonly sequence: number;
  readonly atSimulationS: number;
}

/**
 * Positive-volume, successfully-applied `TRANSFER` actions, in event-log order, optionally
 * filtered by source/receiver. Matches `buildTransferAction`: `targetInstanceId` is the source;
 * `payload = { toInstanceId, volumeL }`.
 */
export function orderedTransfers(events: readonly LabEventRecord[], filter: { readonly sourceId?: UUID; readonly receiverId?: UUID } = {}): TransferSample[] {
  const out: TransferSample[] = [];
  for (const record of events) {
    if (record.outcome !== 'APPLIED' || record.action.type !== 'TRANSFER') continue;
    if (filter.sourceId !== undefined && record.action.targetInstanceId !== filter.sourceId) continue;
    const payload = record.action.payload as { toInstanceId?: UUID; volumeL?: number };
    if (filter.receiverId !== undefined && payload.toInstanceId !== filter.receiverId) continue;
    if (typeof payload.volumeL !== 'number' || !Number.isFinite(payload.volumeL) || payload.volumeL <= 0) continue;
    out.push({ volumeL: payload.volumeL, sequence: record.sequence, atSimulationS: record.action.atSimulationS });
  }
  return out.sort((a, b) => a.sequence - b.sequence);
}

export interface TrialReferenceQuantities {
  readonly titrantMolarityMolPerL?: number;
  readonly analyteVolumeL?: number;
  readonly analyteMolarityMolPerL?: number;
}

/**
 * Reference quantities read straight from the trial's own (frozen) `FILL` actions on the analyte
 * and titrant vessels — the same conserved-inventory stoichiometry `equivalenceVolumeFromFills`
 * uses. Using the trial's own saved event slice, not the live/current scene, keeps scoring
 * reproducible after the scene moves on.
 */
export function trialReferenceQuantities(trial: TrialRecord, analyteInstanceId: UUID | undefined, titrantInstanceId: UUID | undefined): TrialReferenceQuantities {
  const analyte = analyteInstanceId ? firstAppliedFill(trial.events, analyteInstanceId) : undefined;
  const titrant = titrantInstanceId ? firstAppliedFill(trial.events, titrantInstanceId) : undefined;
  const titrantMolarityMolPerL = titrant && titrant.volumeL > 0 ? titrant.totalMoles / titrant.volumeL : undefined;
  const analyteMolarityMolPerL = analyte && analyte.volumeL > 0 ? analyte.totalMoles / analyte.volumeL : undefined;
  return { titrantMolarityMolPerL, analyteVolumeL: analyte?.volumeL, analyteMolarityMolPerL };
}

