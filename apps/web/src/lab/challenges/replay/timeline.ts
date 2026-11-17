/**
 * Turns one trial's own (already-saved) event slice + observations into a scrubbable replay
 * timeline. Built strictly from the saved log — nothing here depends on the 3D scene or any
 * animation state, so a replay looks the same whether or not a renderer is even attached. Actions
 * and observations are two separate, real lists in the actual contract (no shared `runId`), so
 * this merges them back into one chronological timeline by simulation time.
 */

import type { LabEventRecord, Observation } from '../contracts';
import type { TrialRecord } from '../goals';
import type { ReplayStep, ReplayTimeline } from './types';

function describeAction(record: LabEventRecord): string {
  const { type, payload } = record.action;
  if (record.outcome === 'REJECTED') return `${type} rejected: ${record.rejectionReason ?? 'no reason given'}.`;
  if (record.outcome === 'DUPLICATE') return `${type} (duplicate, ignored).`;
  if (type === 'TRANSFER') {
    const volumeL = (payload as { volumeL?: number }).volumeL;
    return volumeL ? `Transferred ${(volumeL * 1000).toFixed(2)} mL.` : 'Transfer action.';
  }
  if (type === 'SET_VALVE') {
    const valveOpening = (payload as { valveOpening?: number }).valveOpening;
    return valveOpening !== undefined ? `Stopcock set to ${Math.round(valveOpening * 100)}% open.` : 'Stopcock adjusted.';
  }
  if (type === 'FILL') {
    const volumeL = (payload as { volumeL?: number }).volumeL;
    return volumeL ? `Filled with ${(volumeL * 1000).toFixed(2)} mL.` : 'Filled.';
  }
  if (type === 'CUSTOM' && (payload as { kind?: string }).kind === 'MARK_ENDPOINT') return 'Endpoint marked.';
  return `${type.charAt(0) + type.slice(1).toLowerCase().replace(/_/g, ' ')} action.`;
}

function describeObservation(observation: Observation): string {
  return `${observation.type} observation: ${observation.quantity.value} ${observation.quantity.unit}.`;
}

interface TimelineEvent {
  readonly atSimulationS: number;
  /** Tiebreaker for events sharing the same simulation time: an action's own sequence, or (offset well above any real sequence) an observation's order. */
  readonly sortKey: number;
  readonly description: string;
  readonly volumeDelta: number;
  readonly ph: number | null;
}

export function buildReplayTimeline(trial: TrialRecord): ReplayTimeline {
  const actionEvents: TimelineEvent[] = [...trial.events]
    .sort((a, b) => a.sequence - b.sequence)
    .map((record) => {
      let volumeDelta = 0;
      if (record.outcome === 'APPLIED' && record.action.type === 'TRANSFER') {
        const volumeL = (record.action.payload as { volumeL?: number }).volumeL;
        if (typeof volumeL === 'number' && Number.isFinite(volumeL) && volumeL > 0) volumeDelta = volumeL;
      }
      return { atSimulationS: record.action.atSimulationS, sortKey: record.sequence, description: describeAction(record), volumeDelta, ph: null };
    });
  const observationEvents: TimelineEvent[] = [...trial.observations]
    .sort((a, b) => a.timeS - b.timeS)
    .map((observation, i) => ({
      // An observation is a consequence of whatever action triggered it, so it sorts after any action at the same simulation time.
      atSimulationS: observation.timeS,
      sortKey: Number.MAX_SAFE_INTEGER / 2 + i,
      description: describeObservation(observation),
      volumeDelta: 0,
      ph: observation.type === 'PH' ? observation.quantity.value : null,
    }));
  const merged = [...actionEvents, ...observationEvents].sort((a, b) => a.atSimulationS - b.atSimulationS || a.sortKey - b.sortKey);

  let cumulativeVolumeL = 0;
  let latestPh: number | null = null;
  const steps: ReplayStep[] = merged.map((event, index) => {
    cumulativeVolumeL += event.volumeDelta;
    if (event.ph !== null) latestPh = event.ph;
    return { index, atSimulationS: event.atSimulationS, description: event.description, cumulativeVolumeL, latestPh };
  });
  return { trialId: trial.trialId, steps };
}

