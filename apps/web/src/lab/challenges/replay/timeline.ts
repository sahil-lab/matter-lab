/**
 * Turns one trial's own (already-saved) event slice into a scrubbable replay timeline. Built
 * strictly from the saved `LabEvent` log — nothing here depends on the 3D scene or any animation
 * state, so a replay looks the same whether or not a renderer is even attached.
 */

import type { LabEvent } from '../contracts';
import type { TrialRecord } from '../goals';
import type { ReplayStep, ReplayTimeline } from './types';

function describeEvent(event: LabEvent): string {
  switch (event.kind) {
    case 'ACTION_APPLIED': {
      const { type, payload } = event.action;
      if (type === 'TRANSFER') {
        const volumeL = (payload as { volumeL?: number }).volumeL;
        return volumeL ? `Transferred ${(volumeL * 1000).toFixed(2)} mL.` : 'Transfer action.';
      }
      if (type === 'SET_VALVE') {
        const opening = (payload as { opening?: number }).opening;
        return opening !== undefined ? `Stopcock set to ${Math.round(opening * 100)}% open.` : 'Stopcock adjusted.';
      }
      if (type === 'CUSTOM' && (payload as { kind?: string }).kind === 'MARK_ENDPOINT') return 'Endpoint marked.';
      return `${type.charAt(0) + type.slice(1).toLowerCase().replace(/_/g, ' ')} action.`;
    }
    case 'OBSERVATION_RECORDED':
      return `${event.observation.type} observation: ${event.observation.quantity.value} ${event.observation.quantity.unit}.`;
    case 'RUN_RESULT':
      return `Run ${event.result.status.toLowerCase()}.`;
    case 'SCENE_RESET':
      return 'Scene reset.';
    default: {
      const exhaustive: never = event;
      return JSON.stringify(exhaustive);
    }
  }
}

export function buildReplayTimeline(trial: TrialRecord): ReplayTimeline {
  let cumulativeVolumeL = 0;
  let latestPh: number | null = null;
  const steps: ReplayStep[] = [...trial.events]
    .sort((a, b) => a.sequence - b.sequence)
    .map((event, index) => {
      if (event.kind === 'ACTION_APPLIED' && event.action.type === 'TRANSFER') {
        const volumeL = (event.action.payload as { volumeL?: number }).volumeL;
        if (typeof volumeL === 'number' && Number.isFinite(volumeL) && volumeL > 0) cumulativeVolumeL += volumeL;
      }
      if (event.kind === 'OBSERVATION_RECORDED' && event.observation.type === 'PH') latestPh = event.observation.quantity.value;
      const atSimulationS = event.kind === 'ACTION_APPLIED' ? event.action.atSimulationS : event.kind === 'OBSERVATION_RECORDED' ? event.observation.timeS : trial.startedAtSimulationS;
      return { index, atSimulationS, description: describeEvent(event), cumulativeVolumeL, latestPh };
    });
  return { trialId: trial.trialId, steps };
}
