import type { ContainerContents, LabRuntimeEvent, ObservationRecord } from '@matterlab/contracts';
import { hasRoleConnection, roleInstance } from './graph.ts';
import { sameNumber } from './json.ts';
import type { AppliedActionEvent, ChallengeDefinition, TrialEvidence, TrialScope } from './types.ts';

export function sameScope(a: TrialScope, b: TrialScope): boolean {
  return a.runId === b.runId && a.stationId === b.stationId && a.epoch === b.epoch;
}

export function isAppliedEvent(event: LabRuntimeEvent, trial: TrialEvidence): event is AppliedActionEvent {
  return event.type === 'ACTION' && event.receipt.status === 'APPLIED' && event.action.type !== 'RESET' &&
    sameScope(event, trial.scope) && sameScope({ ...event.receipt, runId: event.runId }, trial.scope) &&
    event.action.actionId === event.receipt.actionId && event.sequence === event.receipt.sequence &&
    event.sequence > trial.startedAtSequence && event.sequence <= trial.cursorSequence &&
    event.receipt.runtimeRevision <= trial.frame.revision &&
    (event.action.expectedEpoch === undefined || event.action.expectedEpoch === trial.scope.epoch) &&
    trial.frame.scene.apparatus.some((instance) => instance.id === event.action.targetInstanceId && instance.stationId === trial.scope.stationId);
}

export function appliedActions(trial: TrialEvidence): readonly AppliedActionEvent[] {
  const ids = new Set<string>();
  const sequences = new Set<number>();
  return trial.appliedEvents.filter((event) => {
    if (!isAppliedEvent(event, trial) || ids.has(event.action.actionId) || sequences.has(event.sequence)) return false;
    ids.add(event.action.actionId);
    sequences.add(event.sequence);
    return true;
  });
}

export function supportedObservation(record: ObservationRecord, trial: TrialEvidence, definition: ChallengeDefinition): boolean {
  const { reference } = trial;
  const observation = record.observation;
  const expectedUnit = { PH: 'pH', INDICATOR: '1', VOLUME: 'L', TEMPERATURE: 'K', CONCENTRATION: 'mol/L', MASS: 'kg' }[observation.type];
  return reference.status === 'SUPPORTED' && trial.support.status === 'SUPPORTED' &&
    trial.support.methodId === reference.methodId && trial.frame.scene.simulationConfig.methodId === reference.methodId &&
    !['UNSUPPORTED', 'FAILED'].includes(trial.frame.stationStates[trial.scope.stationId]?.status ?? 'FAILED') &&
    sameScope(record, trial.scope) && record.sequence > trial.startedAtSequence && record.sequence <= trial.cursorSequence &&
    observation.apparatusId === trial.bindings[definition.receiverRole] &&
    (observation.stationId === undefined || observation.stationId === trial.scope.stationId) &&
    ['MODEL_CALCULATED', 'REFERENCE_MEASURED'].includes(observation.evidence) &&
    observation.sourceIds.length > 0 && observation.methodId === reference.methodId && observation.methodVersion === reference.methodVersion &&
    observation.quantity.unit === expectedUnit && Number.isFinite(observation.quantity.value) &&
    observation.timeS <= (trial.frame.stationStates[trial.scope.stationId]?.simulationTimeS ?? -1);
}

export function supportedObservations(trial: TrialEvidence, definition: ChallengeDefinition): readonly ObservationRecord[] {
  const ids = new Set<string>();
  return trial.observations.filter((record) => {
    if (ids.has(record.id)) return false;
    ids.add(record.id);
    return supportedObservation(record, trial, definition);
  });
}

function sameContents(left: ContainerContents, right: ContainerContents): boolean {
  const key = (entry: ContainerContents['species'][number]) => `${entry.speciesId}\0${entry.sourceId ?? ''}`;
  return left.modelId === right.modelId && left.mixing === right.mixing && sameNumber(left.volumeL, right.volumeL, 1e-12) &&
    sameNumber(left.temperatureK, right.temperatureK, 1e-8) && left.species.length === right.species.length &&
    left.species.every((species) => {
      const match = right.species.find((other) => key(other) === key(species));
      return match !== undefined && sameNumber(species.moles, match.moles, 1e-12);
    });
}

export function preparationEvents(trial: TrialEvidence, definition: ChallengeDefinition, role: string): readonly AppliedActionEvent[] {
  if (trial.reference.status !== 'SUPPORTED') return [];
  const target = trial.reference.preparations.find((preparation) => preparation.role === role);
  const instance = roleInstance(trial, role);
  if (!target || !instance || (trial.initialContainerStates[instance.id]?.volumeL ?? 0) > 0) return [];
  const events = appliedActions(trial);
  const fills = events.filter((event) => event.action.type === 'FILL' && event.action.targetInstanceId === instance.id);
  if (fills.length !== 1) return [];
  const fill = fills[0]!;
  if (fill.action.type !== 'FILL' || fill.action.payload.preparation.sourceId !== target.sourceId ||
    !sameContents(fill.action.payload.contents, target.contents)) return [];
  const sourceId = trial.bindings[definition.sourceRole];
  const receiverId = trial.bindings[definition.receiverRole];
  const transfers = events.filter((event) => event.action.type === 'TRANSFER' &&
    [event.action.payload.sourceInstanceId, event.action.payload.targetInstanceId].includes(instance.id));
  if (transfers.some((event) => event.action.type === 'TRANSFER' &&
    (event.sequence < fill.sequence || event.action.payload.sourceInstanceId !== sourceId || event.action.payload.targetInstanceId !== receiverId))) return [];
  return fills;
}

export function acceptedDelivery(
  trial: TrialEvidence, definition: ChallengeDefinition, record: ObservationRecord, requireCurrent = false,
): { readonly volumeL: number; readonly actionIds: readonly string[] } | null {
  if (!supportedObservation(record, trial, definition) || trial.initialTransferVolumeL !== 0) return null;
  const context = record.observation.titration;
  const sourceId = trial.bindings[definition.sourceRole];
  const receiverId = trial.bindings[definition.receiverRole];
  if (!context || context.sourceInstanceId !== sourceId || context.receiverInstanceId !== receiverId || context.deliveredVolumeL <= 0) return null;
  const transfers = appliedActions(trial).filter((event) => {
    const action = event.action;
    return action.type === 'TRANSFER' && action.payload.sourceInstanceId === sourceId &&
      action.payload.targetInstanceId === receiverId && event.sequence < record.sequence &&
      action.atSimulationS <= record.observation.timeS && action.payload.volumeL > 0 &&
      trial.frame.scene.connections.some((edge) => edge.id === action.payload.connectionId && edge.enabled &&
        edge.kind === 'FLUID' && edge.from.instanceId === sourceId && edge.to.instanceId === receiverId);
  });
  const sum = transfers.reduce((total, event) => total + (event.action.type === 'TRANSFER' ? event.action.payload.volumeL : 0), 0);
  if (transfers.length === 0 || !sameNumber(sum, context.deliveredVolumeL, 1e-10)) return null;
  if (requireCurrent) {
    const total = trial.frame.transferTotals.find((entry) => entry.sourceInstanceId === sourceId && entry.receiverInstanceId === receiverId);
    if (!total || !sameNumber(total.deliveredVolumeL, context.deliveredVolumeL, 1e-10)) return null;
    const laterTransfers = appliedActions(trial).some((event) => event.sequence > record.sequence && event.action.type === 'TRANSFER' &&
      (event.action.payload.sourceInstanceId === sourceId || event.action.payload.targetInstanceId === receiverId));
    if (laterTransfers) return null;
  }
  return { volumeL: context.deliveredVolumeL, actionIds: transfers.map((event) => event.action.actionId) };
}

export function sensorEvidence(trial: TrialEvidence, definition: ChallengeDefinition, sensorRole: string, receiverRole: string): {
  readonly observations: readonly ObservationRecord[];
  readonly actions: readonly AppliedActionEvent[];
} | null {
  const sensor = roleInstance(trial, sensorRole);
  const receiver = roleInstance(trial, receiverRole);
  const sensorDefinition = trial.definitions.find((entry) => entry.id === sensor?.definitionId);
  if (!sensor || !receiver || !sensorDefinition?.capabilities.includes('PH_SENSOR') ||
    !sensorDefinition.capabilities.includes('MEASUREMENT') ||
    trial.frame.apparatusStates[sensor.id]?.probe?.containerInstanceId !== receiver.id ||
    !hasRoleConnection(trial, sensorRole, receiverRole, 'SENSOR')) return null;
  const actions = appliedActions(trial).filter((event) => event.action.type === 'SET_PROBE' && event.action.targetInstanceId === sensor.id);
  const last = actions.at(-1);
  if (!last || last.action.type !== 'SET_PROBE' || last.action.payload.containerInstanceId !== receiver.id) return null;
  const observations = supportedObservations(trial, definition).filter((record) => record.observation.type === 'PH' &&
    record.sequence > last.sequence && record.observation.timeS >= last.action.atSimulationS);
  return observations.length ? { observations, actions: [last] } : null;
}

export function endpointCandidates(trial: TrialEvidence, definition: ChallengeDefinition): readonly ObservationRecord[] {
  const valid = supportedObservations(trial, definition).filter((record) =>
    (record.observation.type === 'PH' || record.observation.type === 'INDICATOR') && acceptedDelivery(trial, definition, record, true));
  const latest = Math.max(-1, ...valid.map((record) => record.sequence));
  return valid.filter((record) => record.sequence === latest);
}
