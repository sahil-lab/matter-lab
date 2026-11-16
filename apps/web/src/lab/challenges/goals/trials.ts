/**
 * Reconstructs `TrialRecord`s purely from the event log and run results — the one mechanism used
 * for both a live Agent 07 stream and the fixture demo runtime, so "what counts as a trial" is
 * defined in exactly one place. A trial ends at each `CUSTOM` action whose payload has
 * `kind: 'MARK_ENDPOINT'` (FLAGGED CONVENTION: Agent 07/04 should emit exactly this shape when the
 * learner marks an endpoint; reconcile the key names once their real dispatch exists).
 */

import type { LabEvent, RunResult, UUID } from '../contracts';
import type { EndpointMark, TrialRecord } from './types';

interface MarkEndpointPayload {
  readonly deliveredVolumeL?: number;
  readonly runId?: UUID;
  readonly indicatorColorNote?: string;
}

function isMarkEndpoint(event: LabEvent): event is Extract<LabEvent, { kind: 'ACTION_APPLIED' }> {
  return event.kind === 'ACTION_APPLIED' && event.action.type === 'CUSTOM' && (event.action.payload as { kind?: string }).kind === 'MARK_ENDPOINT';
}

export function deriveTrialsFromLog(events: readonly LabEvent[], runResults: readonly RunResult[]): TrialRecord[] {
  const sorted = [...events].sort((a, b) => a.sequence - b.sequence);
  const trials: TrialRecord[] = [];
  let sliceStart = 0;
  let trialStartS = sorted[0] && sorted[0].kind === 'ACTION_APPLIED' ? sorted[0].action.atSimulationS : 0;
  let counter = 0;

  for (let i = 0; i < sorted.length; i++) {
    const event = sorted[i]!;
    if (!isMarkEndpoint(event)) continue;
    counter += 1;
    const payload = event.action.payload as MarkEndpointPayload;
    const sliceEvents = sorted.slice(sliceStart, i + 1);
    const runId = payload.runId ?? '';
    const matchingRunResults = runResults.filter((r) => r.runId === runId);
    const endpoint: EndpointMark | null = typeof payload.deliveredVolumeL === 'number' ? { runId, deliveredVolumeL: payload.deliveredVolumeL, markedAtSimulationS: event.action.atSimulationS, indicatorColorNote: payload.indicatorColorNote } : null;
    trials.push({
      trialId: `trial-${counter}`,
      startedAtSimulationS: trialStartS,
      completedAtSimulationS: event.action.atSimulationS,
      events: sliceEvents,
      runResults: matchingRunResults,
      endpoint,
    });
    sliceStart = i + 1;
    trialStartS = event.action.atSimulationS;
  }
  return trials;
}

/** Applies the learner's own interpretation answers on top of event-derived trials, without touching the log they came from. */
export function withInterpretations(trials: readonly TrialRecord[], answers: ReadonlyMap<UUID, { readonly reportedAnalyteMolarity?: number; readonly interpretation?: string }>): TrialRecord[] {
  return trials.map((trial) => {
    const answer = answers.get(trial.trialId);
    return answer ? { ...trial, ...answer } : trial;
  });
}
