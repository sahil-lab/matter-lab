/**
 * Mirrors Section 3 ("Shared domain model") and the `LabAction`/`Observation`/`RunResult` shapes of
 * `00_SHARED_INTEGRATION_CONTRACT.md`, verbatim where the contract gives a concrete shape.
 *
 * This is **not** the canonical source. The shared contract reserves `packages/contracts/lab/**`
 * for Agent 07 (experiment graph) jointly with Agent 09 (persistence); that package did not exist
 * yet when this branch was written. Agent 04 (interaction/editor) only *consumes* these types to
 * build typed `LabAction` events and read back authoritative state — it never redefines the
 * domain model. When `packages/contracts/lab/**` lands, every import of this file should be
 * repointed there and this file deleted; the shapes below are kept intentionally identical so that
 * swap is mechanical.
 */

export type UUID = string;

/** Evidence levels from Section 1 of the shared contract (distinct from `packages/core`'s `EvidenceLevel`, which uses lowercase ids). */
export type Evidence = 'REFERENCE_MEASURED' | 'MODEL_CALCULATED' | 'ILLUSTRATIVE' | 'UNVERIFIED' | 'UNSUPPORTED';

export interface Quantity {
  readonly value: number;
  readonly unit: string;
  readonly uncertainty?: number;
}

/** Scene coordinates are meters; rotation is a unit quaternion [x, y, z, w]. */
export interface Transform {
  readonly positionM: readonly [number, number, number];
  readonly quaternion: readonly [number, number, number, number];
}

export const IDENTITY_TRANSFORM: Transform = Object.freeze({
  positionM: [0, 0, 0] as const,
  quaternion: [0, 0, 0, 1] as const,
});

export type ApparatusKind =
  | 'BENCH'
  | 'STAND'
  | 'CLAMP'
  | 'BURETTE'
  | 'FLASK'
  | 'BEAKER'
  | 'PIPETTE'
  | 'STIRRER'
  | 'PH_PROBE'
  | 'BALANCE'
  | 'OTHER';

export type Capability =
  | 'CONTAINER'
  | 'FLOW_SOURCE'
  | 'FLOW_RECEIVER'
  | 'MOUNT'
  | 'MOUNTABLE'
  | 'HEATING'
  | 'STIRRING'
  | 'PH_SENSOR'
  | 'MEASUREMENT';

export interface ApparatusInstance {
  readonly id: UUID;
  readonly kind: ApparatusKind;
  readonly definitionId: string;
  readonly transform: Transform;
  /** Bumped by the authoritative reducer (Agent 07) on every accepted change; used for optimistic-concurrency checks. */
  readonly revision: number;
  /** Apparatus-specific settings validated by Agent 03's definition (valve openFraction, probe depth, ...). Never holds editor-only UI state. */
  readonly config: Readonly<Record<string, unknown>>;
  readonly capabilities: readonly Capability[];
  readonly stationId: UUID;
}

export type ConnectionKind = 'MECHANICAL' | 'FLUID' | 'SENSOR' | 'CONTROL';

export interface SocketRef {
  readonly instanceId: UUID;
  readonly socketId: string;
}

export interface Connection {
  readonly id: UUID;
  readonly from: SocketRef;
  readonly to: SocketRef;
  readonly kind: ConnectionKind;
  readonly enabled: boolean;
}

export interface SpeciesAmount {
  readonly speciesId: string;
  readonly moles: number;
  readonly sourceId?: string;
}

export interface ContainerContents {
  readonly volumeL: number;
  readonly species: readonly SpeciesAmount[];
  readonly temperatureK: number;
  readonly mixing: 'WELL_MIXED' | 'UNMIXED';
  readonly modelId: string;
}

export interface Station {
  readonly id: UUID;
  readonly name: string;
}

export interface SimulationConfig {
  readonly methodId: string;
  readonly timeStepS: number;
}

export interface ExperimentScene {
  readonly id: UUID;
  readonly revision: number;
  readonly schemaVersion: 1;
  readonly stations: readonly Station[];
  readonly apparatus: readonly ApparatusInstance[];
  readonly connections: readonly Connection[];
  /** Owned exclusively by Agent 07's authoritative reducer. The editor reads this; it never writes it. */
  readonly containerStates: Readonly<Record<UUID, ContainerContents>>;
  readonly simulationConfig: SimulationConfig;
  readonly viewport?: Readonly<Record<string, unknown>>;
}

export type LabActionType =
  | 'PLACE'
  | 'MOVE'
  | 'ATTACH'
  | 'DETACH'
  | 'FILL'
  | 'SET_VALVE'
  | 'TRANSFER'
  | 'START_STIRRER'
  | 'SET_PROBE'
  | 'RESET'
  | 'CUSTOM';

/**
 * A typed event the editor emits in response to a user gesture. `PLACE`/`MOVE`/`ATTACH`/`DETACH`
 * describe editor (scene-graph) commands; `FILL`/`SET_VALVE`/`TRANSFER`/`START_STIRRER`/`SET_PROBE`/
 * `RESET` describe experiment events. Both are dispatched the same way (see `actionSink.ts`), but
 * only the former participate in the editor's own undo/redo stack (`history.ts`).
 */
export interface LabAction {
  readonly actionId: UUID;
  readonly atSimulationS: number;
  readonly targetInstanceId: UUID;
  readonly type: LabActionType;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly actorId?: UUID;
}

export type ObservationType = 'PH' | 'TEMPERATURE' | 'VOLUME' | 'CONCENTRATION' | 'INDICATOR' | 'MASS';

export interface Observation {
  readonly type: ObservationType;
  readonly apparatusId?: UUID;
  readonly timeS: number;
  readonly quantity: Quantity;
  readonly evidence: Evidence;
  readonly methodId: string;
  readonly sourceIds: readonly string[];
}

export type RunStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'UNSUPPORTED';

export interface RunResult {
  readonly runId: UUID;
  readonly status: RunStatus;
  readonly methodId: string;
  readonly methodVersion: string;
  readonly inputHash: string;
  readonly observations: readonly Observation[];
  readonly warnings: readonly string[];
  readonly assumptions: readonly string[];
  readonly solverDiagnostics?: Readonly<Record<string, unknown>>;
}

/** RFC 9457-flavoured rejection reason for an action the authoritative reducer refused. */
export interface ActionRejection {
  readonly code: string;
  readonly message: string;
}

/** Generates a stable UUID string, falling back to a non-cryptographic id where `crypto` is unavailable (older test runners). */
export function newUUID(): UUID {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
