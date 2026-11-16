import type {
  ApparatusDefinition, ApparatusRuntimeState, ContainerContents, Evidence, ObservationRecord,
  ObservationType, RuntimeSnapshot, UUID,
} from '@matterlab/contracts';
import { CLEAR_LIQUID_APPEARANCE } from './materials';
import type { LiquidAppearance } from './materials';
import { fluidScope } from './types';
import type { FluidScope } from './types';

export interface ObservationQuery {
  readonly observations: readonly ObservationRecord[];
  readonly scope: FluidScope;
  readonly apparatusId: UUID;
}

function inScope(record: ObservationRecord, query: ObservationQuery): boolean {
  const { scope, apparatusId } = query;
  const observation = record.observation;
  return record.runId === scope.runId && record.stationId === scope.stationId && record.epoch === scope.epoch &&
    record.sequence <= scope.lastSequence && Number.isSafeInteger(record.sequence) && record.sequence >= 0 &&
    observation.apparatusId === apparatusId &&
    (!observation.stationId || observation.stationId === scope.stationId) &&
    Number.isFinite(observation.timeS) && observation.timeS >= 0 && observation.timeS <= scope.simulationTimeS;
}

function newest(query: ObservationQuery, type: ObservationType): ObservationRecord | undefined {
  let result: ObservationRecord | undefined;
  for (const record of query.observations) {
    if (record.observation.type === type && inScope(record, query) &&
        (!result || record.sequence > result.sequence)) result = record;
  }
  return result;
}

function validEvidence(evidence: Evidence): boolean {
  return evidence !== 'UNSUPPORTED' && evidence !== 'UNVERIFIED';
}

function inventoryAfter(query: ObservationQuery, sequence: number): boolean {
  return query.observations.some((record) => inScope(record, query) && record.sequence > sequence &&
    (record.observation.type === 'VOLUME' || record.observation.type === 'TEMPERATURE' ||
      record.observation.type === 'CONCENTRATION'));
}

export interface InstrumentReading {
  readonly status: 'READY' | 'UNAVAILABLE' | 'UNSUPPORTED';
  readonly label: string;
  readonly reason?: string;
  readonly record?: ObservationRecord;
}

export function selectInstrumentReading(query: ObservationQuery, type: ObservationType): InstrumentReading {
  const label = { PH: 'pH', TEMPERATURE: 'Temperature', VOLUME: 'Volume', CONCENTRATION: 'Concentration', INDICATOR: 'Indicator', MASS: 'Mass' }[type];
  if (query.scope.status === 'FAILED' || query.scope.status === 'UNSUPPORTED') {
    return { status: 'UNSUPPORTED', label, reason: 'The current station has no supported result.' };
  }
  const record = newest(query, type);
  if (!record) return { status: 'UNAVAILABLE', label, reason: 'No observation exists in the current run, station and epoch.' };
  if (!validEvidence(record.observation.evidence) || !Number.isFinite(record.observation.quantity.value)) {
    return { status: 'UNSUPPORTED', label, reason: 'The latest observation is not a supported measurement or model result.' };
  }
  if ((type === 'PH' || type === 'INDICATOR') && inventoryAfter(query, record.sequence)) {
    return { status: 'UNAVAILABLE', label, reason: 'The inventory has changed since this result; waiting for a current solve.' };
  }
  return { status: 'READY', label, record };
}

export interface IndicatorAppearanceSelection {
  readonly appearance: LiquidAppearance;
  readonly record?: ObservationRecord;
  readonly reason?: string;
}

export function selectIndicatorAppearance(
  query: ObservationQuery & { readonly indicatorId?: string },
): IndicatorAppearanceSelection {
  const absent = (reason: string): IndicatorAppearanceSelection => ({ appearance: CLEAR_LIQUID_APPEARANCE, reason });
  const ph = selectInstrumentReading(query, 'PH');
  if (ph.status !== 'READY' || !ph.record) return absent(ph.reason ?? 'A current pH solve is unavailable.');
  if (ph.record.observation.evidence === 'ILLUSTRATIVE') return absent('Illustrative pH is not scientific indicator authority.');
  const matches = query.observations.filter((record) =>
    inScope(record, query) && record.observation.type === 'INDICATOR' &&
    record.sequence === ph.record!.sequence && record.observation.timeS === ph.record!.observation.timeS &&
    (!query.indicatorId || record.observation.indicatorId === query.indicatorId));
  if (matches.length !== 1) return absent('Select exactly one indicator from the current scientific observation batch.');
  const record = matches[0]!;
  const observation = record.observation;
  if (observation.type !== 'INDICATOR' || !validEvidence(observation.evidence)) {
    return absent('The current indicator is unsupported or unverified.');
  }
  const indicator = observation.indicatorState;
  if (!indicator || indicator.colorEvidence !== 'ILLUSTRATIVE' ||
      indicator.indicatorId !== observation.indicatorId ||
      indicator.baseFraction !== observation.quantity.value ||
      !Number.isFinite(indicator.baseFraction) || indicator.baseFraction < 0 || indicator.baseFraction > 1 ||
      indicator.colorSrgb.length !== 3 || indicator.colorSrgb.some((channel) => !Number.isFinite(channel) || channel < 0 || channel > 1) ||
      indicator.sourceIds.length !== observation.sourceIds.length ||
      indicator.sourceIds.some((source, i) => source !== observation.sourceIds[i])) {
    return absent('No exact, internally consistent indicatorState is present; color is not inferred from pH.');
  }
  return {
    record,
    appearance: {
      colorSrgb: indicator.colorSrgb,
      // Optical emphasis, not absorbance, concentration, path-length, or a measured color.
      opacity: 0.24 + 0.38 * indicator.baseFraction,
      evidence: 'ILLUSTRATIVE', indicatorRecordId: record.id,
    },
  };
}

export function selectProbeReading(snapshot: RuntimeSnapshot, probeId: UUID): InstrumentReading {
  const probe = snapshot.scene.apparatus.find((instance) => instance.id === probeId);
  const receiverId = snapshot.apparatusStates[probeId]?.probe?.containerInstanceId;
  const receiver = snapshot.scene.apparatus.find((instance) => instance.id === receiverId);
  const scope = probe && fluidScope(snapshot, probe.stationId);
  if (!probe?.capabilities.includes('PH_SENSOR') || !receiver ||
      receiver.stationId !== probe.stationId || !scope) {
    return { status: 'UNAVAILABLE', label: 'pH', reason: 'The probe is not bound to a container in this station.' };
  }
  return selectInstrumentReading({ observations: snapshot.observations, scope, apparatusId: receiver.id }, 'PH');
}

export interface VesselReadings {
  readonly remainingL?: number;
  readonly deliveredL?: number;
  /** A nominal graduation reading, not necessarily the total delivered since run start. */
  readonly nominalScaleL?: number;
  readonly scaleReading?: 'CONTAINED' | 'DELIVERED';
}

export function vesselReadings(
  definition: ApparatusDefinition, contents?: ContainerContents, runtime?: ApparatusRuntimeState,
): VesselReadings {
  const remainingL = contents?.volumeL;
  const validRemaining = remainingL !== undefined && Number.isFinite(remainingL) && remainingL >= 0 &&
    definition.capacityL !== undefined && remainingL <= definition.capacityL;
  const deliveredL = runtime?.deliveredVolumeL;
  const validDelivered = deliveredL !== undefined && Number.isFinite(deliveredL) && deliveredL >= 0;
  const reading = definition.vesselCalibration?.graduations?.reading;
  return {
    ...(validRemaining ? { remainingL } : {}),
    ...(validDelivered ? { deliveredL } : {}),
    ...(validRemaining && reading ? {
      nominalScaleL: reading === 'DELIVERED' ? definition.capacityL! - remainingL : remainingL,
      scaleReading: reading,
    } : {}),
  };
}

export function formatInstrumentReading(reading: InstrumentReading): string {
  if (reading.status !== 'READY' || !reading.record) return '—';
  const { value, unit } = reading.record.observation.quantity;
  if (unit === 'L') return `${(value * 1000).toFixed(2)} mL`;
  if (unit === 'pH') return `${value.toFixed(2)} pH`;
  return `${Number(value.toPrecision(6))} ${unit}`;
}
