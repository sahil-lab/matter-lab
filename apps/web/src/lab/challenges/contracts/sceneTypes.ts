/**
 * STUB CONTRACT — pending `packages/contracts/lab` (owned jointly by Agent 07 + Agent 09).
 *
 * This file is a byte-faithful TypeScript rendering of the domain model in
 * `00_SHARED_INTEGRATION_CONTRACT.md` section 3 ("Shared domain model"). Agent 08 (this surface)
 * does not own, produce or mutate any of these types: Agent 07 is the authoritative writer of
 * `ExperimentScene`/`LabAction` state, Agent 06 is the authoritative source of `Observation`/
 * `RunResult` science, and Agent 09 persists all of it. We depend on these shapes only to *read*
 * them, so the goal evaluator, scoring rubric and notebook builder in `lab/challenges/**` can be
 * written and unit-tested now against fixture data, and swapped for the real package transparently
 * once Agent 07/09 publish `packages/contracts/lab`.
 *
 * Do not add fields here that are not in the shared contract. If a real field is missing, flag it
 * for the human orchestrator rather than inventing a shape unilaterally.
 */

export type UUID = string;

/** The project's five scientific evidence levels (shared contract section 1), not the v1 app's lowercase `EvidenceLevel`. */
export type Evidence = 'REFERENCE_MEASURED' | 'MODEL_CALCULATED' | 'ILLUSTRATIVE' | 'UNVERIFIED' | 'UNSUPPORTED';

export interface Quantity {
  readonly value: number;
  readonly unit: string;
  readonly uncertainty?: number;
}

export interface Transform {
  readonly positionM: readonly [number, number, number];
  readonly quaternion: readonly [number, number, number, number];
}

export type ApparatusKind = 'BENCH' | 'STAND' | 'CLAMP' | 'BURETTE' | 'FLASK' | 'BEAKER' | 'PIPETTE' | 'STIRRER' | 'PH_PROBE' | 'BALANCE' | 'OTHER';

export type Capability = 'CONTAINER' | 'FLOW_SOURCE' | 'FLOW_RECEIVER' | 'MOUNT' | 'MOUNTABLE' | 'HEATING' | 'STIRRING' | 'PH_SENSOR' | 'MEASUREMENT';

export interface ApparatusInstance {
  readonly id: UUID;
  readonly kind: ApparatusKind;
  readonly definitionId: string;
  readonly transform: Transform;
  readonly revision: number;
  readonly config: Readonly<Record<string, unknown>>;
  readonly capabilities: readonly Capability[];
  readonly stationId: UUID;
}

export type ConnectionKind = 'MECHANICAL' | 'FLUID' | 'SENSOR' | 'CONTROL';

export interface Connection {
  readonly id: UUID;
  readonly from: { readonly instanceId: UUID; readonly socketId: string };
  readonly to: { readonly instanceId: UUID; readonly socketId: string };
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

export interface ExperimentScene {
  readonly id: UUID;
  readonly revision: number;
  readonly schemaVersion: 1;
  readonly stations: ReadonlyArray<{ readonly id: UUID; readonly name: string }>;
  readonly apparatus: readonly ApparatusInstance[];
  readonly connections: readonly Connection[];
  readonly containerStates: Readonly<Record<UUID, ContainerContents>>;
  readonly simulationConfig: { readonly methodId: string; readonly timeStepS: number };
  readonly viewport?: Readonly<Record<string, unknown>>;
}

export type LabActionType = 'PLACE' | 'MOVE' | 'ATTACH' | 'DETACH' | 'FILL' | 'SET_VALVE' | 'TRANSFER' | 'START_STIRRER' | 'SET_PROBE' | 'RESET' | 'CUSTOM';

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
