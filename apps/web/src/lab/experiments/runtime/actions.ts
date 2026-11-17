/**
 * Pure `LabAction` builders. These exist so a caller (a test, Agent 04's editor dispatching user
 * gestures, or a future REST layer replaying a request body) never hand-assembles a raw
 * `payload: Record<string, unknown>` and risks a typo the reducer would reject at runtime instead
 * of at the call site. Every builder returns a ready `LabAction`; nothing here touches engine
 * state or an `ExperimentScene` — these are the same shape `dispatch` accepts, nothing more.
 */
import type { LabAction, SpeciesAmount, Transform, UUID } from '@matterlab/contracts';
import { generateUUID } from './ids';

interface CommonOptions {
  readonly actionId?: UUID;
  readonly atSimulationS?: number;
  readonly actorId?: UUID;
}

function base(targetInstanceId: UUID, type: LabAction['type'], payload: Record<string, unknown>, options?: CommonOptions): LabAction {
  return {
    actionId: options?.actionId ?? generateUUID(),
    atSimulationS: options?.atSimulationS ?? 0,
    targetInstanceId,
    type,
    payload,
    ...(options?.actorId ? { actorId: options.actorId } : {}),
  };
}

export function buildCreateStationAction(stationId: UUID, name: string, options?: CommonOptions): LabAction {
  return base(stationId, 'CUSTOM', { kind: 'CREATE_STATION', name }, options);
}

export function buildPlaceAction(
  instanceId: UUID,
  definitionId: string,
  stationId: UUID,
  transform: Transform,
  config?: Record<string, unknown>,
  options?: CommonOptions,
): LabAction {
  return base(instanceId, 'PLACE', { definitionId, stationId, transform, config }, options);
}

export function buildMoveAction(instanceId: UUID, transform: Transform, options?: CommonOptions): LabAction {
  return base(instanceId, 'MOVE', { transform }, options);
}

export function buildAttachAction(
  fromInstanceId: UUID,
  socketId: string,
  toInstanceId: UUID,
  toSocketId: string,
  options?: CommonOptions,
): LabAction {
  return base(fromInstanceId, 'ATTACH', { socketId, toInstanceId, toSocketId }, options);
}

export function buildDetachAction(instanceId: UUID, connectionId: UUID, options?: CommonOptions): LabAction {
  return base(instanceId, 'DETACH', { connectionId }, options);
}

export function buildFillAction(
  instanceId: UUID,
  fill: { volumeL: number; species: readonly SpeciesAmount[]; temperatureK: number; modelId: string },
  options?: CommonOptions,
): LabAction {
  return base(instanceId, 'FILL', { ...fill }, options);
}

export function buildSetValveAction(instanceId: UUID, valveOpening: number, options?: CommonOptions): LabAction {
  return base(instanceId, 'SET_VALVE', { valveOpening }, options);
}

export function buildTransferAction(fromInstanceId: UUID, toInstanceId: UUID, volumeL: number, options?: CommonOptions): LabAction {
  return base(fromInstanceId, 'TRANSFER', { toInstanceId, volumeL }, options);
}

export function buildStartStirrerAction(instanceId: UUID, running: boolean, rpm: number, options?: CommonOptions): LabAction {
  return base(instanceId, 'START_STIRRER', { running, rpm }, options);
}

export function buildSetProbeAction(instanceId: UUID, targetApparatusId: UUID, depthM?: number, options?: CommonOptions): LabAction {
  return base(instanceId, 'SET_PROBE', { targetApparatusId, depthM }, options);
}

export function buildResetStationAction(stationId: UUID, clearConnections = false, options?: CommonOptions): LabAction {
  return base(stationId, 'RESET', { scope: 'STATION', stationId, clearConnections }, options);
}

export function buildResetSceneAction(options?: CommonOptions): LabAction {
  return base('', 'RESET', { scope: 'SCENE' }, options);
}
