/**
 * Reconstructs `TrialRecord`s purely from the event log and the observation ledger — the one
 * mechanism used for both a live `ExperimentEngine` and fixture test data, so "what counts as a
 * trial" is defined in exactly one place. A trial ends at each successfully-applied `CUSTOM`
 * action whose payload has `kind: 'MARK_ENDPOINT'` (FLAGGED CONVENTION: Agent 04's editor should
 * dispatch exactly this `LabAction` when the learner marks an endpoint; reconcile the key names if
 * their real dispatch differs). Observations have no `runId` in the real contract (they are a flat,
 * continuously-growing ledger per apparatus), so they are sliced into a trial by *simulation time*
 * instead: everything recorded between the previous trial boundary and this one.
 */

import type { LabEventRecord, Observation, UUID } from '../contracts';
import type { EndpointMark, TrialRecord } from './types';

interface MarkEndpointPayload {
  readonly deliveredVolumeL?: number;
  readonly indicatorColorNote?: string;
}

function isAppliedMarkEndpoint(record: LabEventRecord): boolean {
  return record.outcome === 'APPLIED' && record.action.type === 'CUSTOM' && (record.action.payload as { kind?: string }).kind === 'MARK_ENDPOINT';
}

export function deriveTrialsFromLog(events: readonly LabEventRecord[], observations: readonly Observation[]): TrialRecord[] {
  const sortedEvents = [...events].sort((a, b) => a.sequence - b.sequence);
  const sortedObservations = [...observations].sort((a, b) => a.timeS - b.timeS);
  const trials: TrialRecord[] = [];
  let eventSliceStart = 0;
  let observationCursor = 0;
  let trialStartS = sortedEvents[0]?.action.atSimulationS ?? 0;
  let counter = 0;

  for (let i = 0; i < sortedEvents.length; i++) {
    const record = sortedEvents[i]!;
    if (!isAppliedMarkEndpoint(record)) continue;
    counter += 1;
    const payload = record.action.payload as MarkEndpointPayload;
    const endS = record.action.atSimulationS;
    const sliceEvents = sortedEvents.slice(eventSliceStart, i + 1);

    const sliceObservations: Observation[] = [];
    while (observationCursor < sortedObservations.length && sortedObservations[observationCursor]!.timeS <= endS) {
      sliceObservations.push(sortedObservations[observationCursor]!);
      observationCursor += 1;
    }

    const endpoint: EndpointMark | null = typeof payload.deliveredVolumeL === 'number' ? { deliveredVolumeL: payload.deliveredVolumeL, markedAtSimulationS: endS, indicatorColorNote: payload.indicatorColorNote } : null;
    trials.push({
      trialId: `trial-${counter}`,
      startedAtSimulationS: trialStartS,
      completedAtSimulationS: endS,
      events: sliceEvents,
      observations: sliceObservations,
      endpoint,
    });
    eventSliceStart = i + 1;
    trialStartS = endS;
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

