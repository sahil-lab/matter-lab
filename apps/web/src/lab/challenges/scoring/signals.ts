/**
 * Real-event-stream signal extraction for the scoring rubric: reconstructs the chronological
 * sequence of titrant transfers and reads per-trial reference quantities, both strictly from
 * Agent 07's event log / Agent 06's run results — never from render or animation state.
 */

import type { LabEvent, UUID } from '../contracts';
import type { TrialRecord } from '../goals';

export interface TransferSample {
  readonly volumeL: number;
  readonly sequence: number;
  readonly atSimulationS: number;
}

/** Positive-volume `TRANSFER` actions, in event-log order, optionally filtered by source/receiver. */
export function orderedTransfers(events: readonly LabEvent[], filter: { readonly sourceId?: UUID; readonly receiverId?: UUID } = {}): TransferSample[] {
  const out: TransferSample[] = [];
  for (const event of events) {
    if (event.kind !== 'ACTION_APPLIED' || event.action.type !== 'TRANSFER') continue;
    const payload = event.action.payload as { sourceInstanceId?: UUID; receiverInstanceId?: UUID; volumeL?: number };
    if (filter.sourceId !== undefined && payload.sourceInstanceId !== filter.sourceId) continue;
    if (filter.receiverId !== undefined && payload.receiverInstanceId !== filter.receiverId) continue;
    if (typeof payload.volumeL !== 'number' || !Number.isFinite(payload.volumeL) || payload.volumeL <= 0) continue;
    out.push({ volumeL: payload.volumeL, sequence: event.sequence, atSimulationS: event.action.atSimulationS });
  }
  return out.sort((a, b) => a.sequence - b.sequence);
}

export interface TrialReferenceQuantities {
  readonly titrantMolarityMolPerL?: number;
  readonly analyteVolumeL?: number;
  readonly analyteMolarityMolPerL?: number;
}

/**
 * Reads reference quantities from `solverDiagnostics` of the trial's own (frozen) run results —
 * see the flagged keys next to `equivalenceVolumeL` in `goals/context.ts`. Using the trial's own
 * snapshot rather than the live scene keeps scoring reproducible after the scene moves on.
 */
export function trialReferenceQuantities(trial: TrialRecord): TrialReferenceQuantities {
  for (let i = trial.runResults.length - 1; i >= 0; i--) {
    const diag = trial.runResults[i]!.solverDiagnostics;
    if (!diag) continue;
    const titrant = diag['titrantMolarityMolPerL'];
    const volume = diag['analyteVolumeL'];
    const molarity = diag['analyteMolarityMolPerL'];
    if (typeof titrant === 'number' || typeof volume === 'number' || typeof molarity === 'number') {
      return {
        titrantMolarityMolPerL: typeof titrant === 'number' ? titrant : undefined,
        analyteVolumeL: typeof volume === 'number' ? volume : undefined,
        analyteMolarityMolPerL: typeof molarity === 'number' ? molarity : undefined,
      };
    }
  }
  return {};
}
