import type { ObservationRecord, ObservationType, RuntimeSnapshot, UUID } from '@matterlab/contracts';
import { VOLUME_TOLERANCE_L } from './inventory.ts';

export function selectCurrentObservation(
  snapshot: RuntimeSnapshot, apparatusId: UUID, type: ObservationType,
): ObservationRecord | undefined {
  const instance = snapshot.scene.apparatus.find((item) => item.id === apparatusId);
  if (!instance) return undefined;
  const station = snapshot.stationStates[instance.stationId];
  if (!station) return undefined;
  if (['PH', 'CONCENTRATION', 'INDICATOR'].includes(type) &&
      (['FAILED', 'UNSUPPORTED'].includes(station.status) || (snapshot.scene.containerStates[apparatusId]?.volumeL ?? 0) <= VOLUME_TOLERANCE_L)) return undefined;
  for (let index = snapshot.observations.length - 1; index >= 0; index--) {
    const record = snapshot.observations[index]!;
    if (record.runId === snapshot.runId && record.stationId === instance.stationId &&
        record.epoch === station.epoch && record.observation.apparatusId === apparatusId &&
        record.observation.type === type) return record;
  }
  return undefined;
}
export function selectProbeObservation(snapshot: RuntimeSnapshot, probeId: UUID): ObservationRecord | undefined {
  const receiverId = snapshot.apparatusStates[probeId]?.probe?.containerInstanceId;
  if (!receiverId) return undefined;
  return selectCurrentObservation(snapshot, receiverId, 'PH');
}
export function selectTitrationObservations(
  snapshot: RuntimeSnapshot, stationId: UUID, sourceId: UUID, receiverId: UUID, epoch = snapshot.stationStates[stationId]?.epoch,
): readonly ObservationRecord[] {
  return Object.freeze(snapshot.observations.filter((record) => record.runId === snapshot.runId &&
    record.stationId === stationId && record.epoch === epoch && record.observation.type === 'PH' &&
    record.observation.titration?.sourceInstanceId === sourceId && record.observation.titration.receiverInstanceId === receiverId));
}
/** Display interpolation only: returned numbers must never be dispatched as inventory updates. */
export function interpolatedVolumeL(previous: RuntimeSnapshot, current: RuntimeSnapshot, apparatusId: UUID, alpha: number): number | undefined {
  const currentContents = current.scene.containerStates[apparatusId];
  if (!currentContents) return undefined;
  const priorContents = previous.scene.containerStates[apparatusId];
  const instance = current.scene.apparatus.find((item) => item.id === apparatusId);
  if (!priorContents || !instance || previous.runId !== current.runId ||
      previous.stationStates[instance.stationId]?.epoch !== current.stationStates[instance.stationId]?.epoch) return currentContents.volumeL;
  const fraction = Number.isFinite(alpha) ? Math.max(0, Math.min(1, alpha)) : 1;
  return priorContents.volumeL + (currentContents.volumeL - priorContents.volumeL) * fraction;
}
