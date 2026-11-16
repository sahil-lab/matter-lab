/**
 * Typed payload shapes for each `LabAction.type`. The shared contract leaves `payload` as
 * `Record<string, unknown>` at the wire boundary (so Agent 07's reducer can evolve it); these
 * interfaces are Agent 04's own documented convention for *producing* actions from gestures and are
 * mirrored by the stub reducer in `lab/experiments/` for now. If Agent 07 publishes a different
 * payload shape in `packages/contracts/lab/**`, only `operationalActions.ts`, `commands.ts` and the
 * stub reducer need updating — nothing in the gesture/pointer layer depends on these shapes directly.
 *
 * Convention for `LabAction.targetInstanceId`: the instance whose control is being operated (the
 * burette for `SET_VALVE`/`TRANSFER`, the container for `FILL`, the stirrer for `START_STIRRER`, the
 * probe for `SET_PROBE`, the moved/placed instance for `PLACE`/`MOVE`, the initiating instance for
 * `ATTACH`/`DETACH`).
 */
import type { ApparatusKind, Capability, ConnectionKind, SocketRef, Transform, UUID } from './contracts';

export interface PlacePayload {
  readonly kind: ApparatusKind;
  readonly definitionId: string;
  readonly transform: Transform;
  readonly capabilities: readonly Capability[];
  readonly stationId: UUID;
  readonly config: Readonly<Record<string, unknown>>;
}

export interface MovePayload {
  readonly transform: Transform;
}

export interface AttachPayload {
  readonly connectionId: UUID;
  readonly from: SocketRef;
  readonly to: SocketRef;
  readonly kind: ConnectionKind;
}

export interface DetachPayload {
  readonly connectionId: UUID;
}

export interface FillPayload {
  readonly speciesId: string;
  readonly concentrationMolPerL: number;
  readonly volumeL: number;
  readonly temperatureK: number;
}

export interface SetValvePayload {
  readonly openFraction: number;
}

export interface TransferPayload {
  readonly fromInstanceId: UUID;
  readonly toInstanceId: UUID;
  readonly volumeL: number;
}

export interface StartStirrerPayload {
  readonly speed: number;
}

export interface SetProbePayload {
  readonly immersionDepthM: number;
  readonly intoInstanceId?: UUID;
}

export interface ResetPayload {
  readonly scope: 'station' | 'all';
  readonly stationId?: UUID;
}

/**
 * The shared `LabActionType` enum has no dedicated "remove instance" member, so deletion is encoded
 * as `CUSTOM` with `op: 'REMOVE'`. This is a provisional convention: propose a first-class
 * `REMOVE`/`DELETE` member to Agent 07 + 09 when reconciling, and migrate off `CUSTOM` then.
 */
export interface RemoveCustomPayload {
  readonly op: 'REMOVE';
}

export type CustomPayload = RemoveCustomPayload;
