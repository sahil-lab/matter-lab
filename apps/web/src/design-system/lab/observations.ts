import type { Observation, ObservationRecord, UUID } from '@matterlab/contracts';
import { formatNumber } from '../../ui/charts';

export type ObservationScope = Pick<ObservationRecord, 'runId' | 'stationId' | 'epoch'> & { readonly apparatusId?: UUID };
export type ObservationAvailability = 'current' | 'stale' | 'loading' | 'empty' | 'unsupported' | 'error';

export function observationInScope(record: ObservationRecord, scope: ObservationScope): boolean {
  return record.runId === scope.runId && record.stationId === scope.stationId && record.epoch === scope.epoch &&
    (scope.apparatusId === undefined || record.observation.apparatusId === scope.apparatusId);
}

/** Select by the authoritative sequence, never by array position or resettable station time. */
export function latestObservation(
  records: readonly ObservationRecord[],
  scope: ObservationScope,
  type: Observation['type'],
): ObservationRecord | null {
  let latest: ObservationRecord | null = null;
  for (const record of records) {
    if (record.observation.type !== type || !observationInScope(record, scope)) continue;
    if (!latest || record.sequence > latest.sequence) latest = record;
  }
  return latest;
}

export function canDisplayObservation(observation: Observation | null | undefined, availability: ObservationAvailability): boolean {
  return (availability === 'current' || availability === 'stale') && Boolean(observation) &&
    observation!.evidence !== 'UNSUPPORTED' && Number.isFinite(observation!.quantity.value) &&
    observation!.quantity.unit.trim().length > 0;
}

export function observationDisplay(observation: Observation | null | undefined, availability: ObservationAvailability) {
  if (!observation || !canDisplayObservation(observation, availability)) {
    const message = availability === 'unsupported' || observation?.evidence === 'UNSUPPORTED' ? 'Unsupported' :
      availability === 'loading' ? 'Waiting for calculation' : availability === 'error' ? 'Calculation failed' :
        observation && availability !== 'empty' ? 'Invalid quantity withheld' : 'No observation';
    return { value: '—', unit: '', uncertainty: null, message, available: false } as const;
  }
  const uncertainty = observation.quantity.uncertainty;
  return {
    value: formatNumber(observation.quantity.value, 6),
    unit: observation.quantity.unit,
    uncertainty: uncertainty !== undefined && Number.isFinite(uncertainty) && uncertainty >= 0 ? formatNumber(uncertainty, 6) : null,
    message: availability === 'stale' ? 'Previously recorded · not a live reading' : `Recorded at ${formatNumber(observation.timeS, 6)} s`,
    available: true,
  } as const;
}

export interface TitrationPlotPoint {
  readonly record: ObservationRecord;
  readonly deliveredVolumeL: number;
  readonly pH: number;
}

export interface TitrationPlotSeries {
  readonly key: string;
  readonly apparatusId?: UUID;
  readonly sourceInstanceId: UUID;
  readonly receiverInstanceId: UUID;
  readonly methodId: string;
  readonly evidence: Observation['evidence'];
  readonly points: readonly (TitrationPlotPoint | null)[];
}

export interface TitrationPlotData {
  readonly series: readonly TitrationPlotSeries[];
  readonly omitted: number;
  readonly truncated: number;
  readonly sampleCount: number;
}

/** Projects exact runtime-stamped pH/transfer pairs. Nulls break lines across missing/unsupported samples. */
export function titrationPlotData(records: readonly ObservationRecord[], scope: ObservationScope, maxSamples = 2000): TitrationPlotData {
  const ordered = records.filter((record) => observationInScope(record, scope) && record.observation.type === 'PH').sort((a, b) => a.sequence - b.sequence);
  const limit = Number.isFinite(maxSamples) ? Math.max(1, Math.min(5000, Math.floor(maxSamples))) : 2000;
  const selected = ordered.slice(-limit);
  const groups = new Map<string, { metadata: Omit<TitrationPlotSeries, 'points'>; points: (TitrationPlotPoint | null)[]; lastX: number | null }>();
  let omitted = 0;
  let sampleCount = 0;
  for (const record of selected) {
    const observation = record.observation;
    const transfer = observation.titration;
    const valid = transfer && Number.isFinite(transfer.deliveredVolumeL) && transfer.deliveredVolumeL >= 0 &&
      canDisplayObservation(observation, 'current') && observation.quantity.unit === 'pH' &&
      (observation.evidence === 'REFERENCE_MEASURED' || observation.evidence === 'MODEL_CALCULATED') &&
      (observation.apparatusId === undefined || observation.apparatusId === transfer.receiverInstanceId);
    if (!valid || !transfer) {
      omitted++;
      for (const group of groups.values()) group.points.push(null);
      continue;
    }
    const key = JSON.stringify([observation.apparatusId, transfer.sourceInstanceId, transfer.receiverInstanceId, observation.methodId, observation.methodVersion, observation.evidence, observation.sourceIds]);
    let group = groups.get(key);
    if (!group) {
      group = { metadata: { key, apparatusId: observation.apparatusId, sourceInstanceId: transfer.sourceInstanceId, receiverInstanceId: transfer.receiverInstanceId, methodId: observation.methodId, evidence: observation.evidence }, points: [], lastX: null };
      groups.set(key, group);
    }
    for (const other of groups.values()) if (other !== group) other.points.push(null);
    if (group.lastX !== null && transfer.deliveredVolumeL < group.lastX) group.points.push(null);
    group.points.push({ record, deliveredVolumeL: transfer.deliveredVolumeL, pH: observation.quantity.value });
    group.lastX = transfer.deliveredVolumeL;
    sampleCount++;
  }
  return { series: [...groups.values()].map(({ metadata, points }) => ({ ...metadata, points })), omitted, truncated: ordered.length - selected.length, sampleCount };
}
