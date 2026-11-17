/**
 * Typed, validated payload shapes for each `LabActionType` (brief item 3: "deterministic typed
 * `LabAction` processing"). `LabAction.payload` is `Record<string, unknown>` at the contract
 * boundary (so it serializes losslessly); everything in this file narrows one action's payload to
 * a concrete shape and rejects it with a reason instead of throwing when it does not match.
 */
import type { SpeciesAmount, Transform, UUID } from '@matterlab/contracts';
import { fail, ok, type Result } from './result';

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isTransform(value: unknown): value is Transform {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<Transform>;
  return (
    Array.isArray(v.positionM) &&
    v.positionM.length === 3 &&
    v.positionM.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    Array.isArray(v.quaternion) &&
    v.quaternion.length === 4 &&
    v.quaternion.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

function isSpeciesAmountArray(value: unknown): value is SpeciesAmount[] {
  return (
    Array.isArray(value) &&
    value.every(
      (s) =>
        typeof s === 'object' &&
        s !== null &&
        isString((s as SpeciesAmount).speciesId) &&
        isFiniteNumber((s as SpeciesAmount).moles),
    )
  );
}

export interface PlacePayload {
  readonly definitionId: string;
  readonly stationId: UUID;
  readonly transform: Transform;
  readonly config?: Record<string, unknown>;
}

export function parsePlacePayload(payload: Record<string, unknown>): Result<PlacePayload> {
  if (!isString(payload.definitionId)) return fail('PLACE requires a non-empty string "definitionId".');
  if (!isString(payload.stationId)) return fail('PLACE requires a non-empty string "stationId".');
  if (!isTransform(payload.transform)) return fail('PLACE requires a "transform" with a 3-vector positionM and a 4-component quaternion.');
  const config = payload.config;
  if (config !== undefined && (typeof config !== 'object' || config === null || Array.isArray(config))) {
    return fail('PLACE "config", if given, must be a plain object.');
  }
  return ok({
    definitionId: payload.definitionId,
    stationId: payload.stationId,
    transform: payload.transform,
    config: config as Record<string, unknown> | undefined,
  });
}

export interface MovePayload {
  readonly transform: Transform;
}

export function parseMovePayload(payload: Record<string, unknown>): Result<MovePayload> {
  if (!isTransform(payload.transform)) return fail('MOVE requires a "transform" with a 3-vector positionM and a 4-component quaternion.');
  return ok({ transform: payload.transform });
}

export interface AttachPayload {
  readonly socketId: string;
  readonly toInstanceId: UUID;
  readonly toSocketId: string;
}

export function parseAttachPayload(payload: Record<string, unknown>): Result<AttachPayload> {
  if (!isString(payload.socketId)) return fail('ATTACH requires a non-empty string "socketId" (on the target instance).');
  if (!isString(payload.toInstanceId)) return fail('ATTACH requires a non-empty string "toInstanceId".');
  if (!isString(payload.toSocketId)) return fail('ATTACH requires a non-empty string "toSocketId".');
  return ok({ socketId: payload.socketId, toInstanceId: payload.toInstanceId, toSocketId: payload.toSocketId });
}

export interface DetachPayload {
  readonly connectionId: UUID;
}

export function parseDetachPayload(payload: Record<string, unknown>): Result<DetachPayload> {
  if (!isString(payload.connectionId)) return fail('DETACH requires a non-empty string "connectionId".');
  return ok({ connectionId: payload.connectionId });
}

export interface FillPayload {
  readonly volumeL: number;
  readonly species: readonly SpeciesAmount[];
  readonly temperatureK: number;
  readonly modelId: string;
}

export function parseFillPayload(payload: Record<string, unknown>): Result<FillPayload> {
  if (!isFiniteNumber(payload.volumeL)) return fail('FILL requires a finite number "volumeL".');
  if (!isSpeciesAmountArray(payload.species)) return fail('FILL requires a "species" array of { speciesId, moles } entries.');
  if (!isFiniteNumber(payload.temperatureK)) return fail('FILL requires a finite number "temperatureK".');
  if (!isString(payload.modelId)) return fail('FILL requires a non-empty string "modelId".');
  return ok({ volumeL: payload.volumeL, species: payload.species, temperatureK: payload.temperatureK, modelId: payload.modelId });
}

export interface SetValvePayload {
  readonly valveOpening: number;
}

export function parseSetValvePayload(payload: Record<string, unknown>): Result<SetValvePayload> {
  if (!isFiniteNumber(payload.valveOpening)) return fail('SET_VALVE requires a finite number "valveOpening".');
  return ok({ valveOpening: payload.valveOpening });
}

export interface TransferPayload {
  readonly toInstanceId: UUID;
  readonly volumeL: number;
}

/** `targetInstanceId` on the `LabAction` itself is the transfer's *source*. */
export function parseTransferPayload(payload: Record<string, unknown>): Result<TransferPayload> {
  if (!isString(payload.toInstanceId)) return fail('TRANSFER requires a non-empty string "toInstanceId".');
  if (!isFiniteNumber(payload.volumeL)) return fail('TRANSFER requires a finite number "volumeL".');
  return ok({ toInstanceId: payload.toInstanceId, volumeL: payload.volumeL });
}

export interface StartStirrerPayload {
  readonly running: boolean;
  readonly rpm: number;
}

export function parseStartStirrerPayload(payload: Record<string, unknown>): Result<StartStirrerPayload> {
  if (!isFiniteNumber(payload.rpm)) return fail('START_STIRRER requires a finite number "rpm".');
  if (typeof payload.running !== 'boolean') return fail('START_STIRRER requires a boolean "running".');
  return ok({ running: payload.running, rpm: payload.rpm });
}

export interface SetProbePayload {
  readonly targetApparatusId: UUID;
  readonly depthM?: number;
}

export function parseSetProbePayload(payload: Record<string, unknown>): Result<SetProbePayload> {
  if (!isString(payload.targetApparatusId)) return fail('SET_PROBE requires a non-empty string "targetApparatusId".');
  if (payload.depthM !== undefined && !isFiniteNumber(payload.depthM)) return fail('SET_PROBE "depthM", if given, must be a finite number.');
  return ok({ targetApparatusId: payload.targetApparatusId, depthM: payload.depthM as number | undefined });
}

export interface ResetActionPayload {
  readonly scope: 'STATION' | 'SCENE';
  /** Required when `scope === 'STATION'`. Contracts' `ResetPayload` is a `Record<string, unknown>` so this is an additive, backward-compatible key. */
  readonly stationId?: UUID;
  readonly clearConnections: boolean;
}

export function parseResetPayload(payload: Record<string, unknown>): Result<ResetActionPayload> {
  if (payload.scope !== 'STATION' && payload.scope !== 'SCENE') return fail('RESET requires "scope" to be "STATION" or "SCENE".');
  if (payload.scope === 'STATION' && !isString(payload.stationId)) {
    return fail('RESET with scope "STATION" requires a non-empty string "stationId".');
  }
  if (payload.clearConnections !== undefined && typeof payload.clearConnections !== 'boolean') {
    return fail('RESET "clearConnections", if given, must be a boolean.');
  }
  return ok({
    scope: payload.scope,
    stationId: payload.stationId as UUID | undefined,
    clearConnections: payload.clearConnections === true,
  });
}

/** Payload for the `CUSTOM` action this reducer itself understands: creating a new station. Any other `kind` is logged but otherwise a no-op, reserved for future `ExperimentPlugin`s. */
export interface CreateStationPayload {
  readonly kind: 'CREATE_STATION';
  readonly name: string;
}

export function parseCreateStationPayload(payload: Record<string, unknown>): Result<CreateStationPayload> {
  if (payload.kind !== 'CREATE_STATION') return fail('Not a CREATE_STATION payload.');
  if (!isString(payload.name)) return fail('CREATE_STATION requires a non-empty string "name".');
  return ok({ kind: 'CREATE_STATION', name: payload.name });
}
