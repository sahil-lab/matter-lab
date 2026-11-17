/**
 * Canonical domain model for the MATTER LAB Astra laboratory extension.
 *
 * This reproduces `00_SHARED_INTEGRATION_CONTRACT.md` Section 3 verbatim (the ten agents agreed
 * this is the starting point). Do not rename or narrow a field here without updating that document
 * and telling every agent that reads it — Agent 09 persists exactly this shape, Agent 05 reads
 * `ContainerContents` to render fluid, Agent 08 reads `Observation`/`LabAction` for scoring.
 *
 * Units (Section 3): scene coordinates in **meters**; chemical volume in **liters**; concentration
 * in **mol/L**; temperature in **kelvin**; time in **seconds**. Never reuse a pixel or world-unit
 * measurement as a chemical unit.
 */

export type UUID = string;

/**
 * How much a displayed number is worth trusting. Distinct from `@matterlab/core`'s `EvidenceLevel`
 * (lowercase, six-way) by design: the lab domain's contract (Section 1) specifies this exact
 * SCREAMING_SNAKE_CASE five-way set, and Agent 09's API/export layer is written against it.
 */
export type Evidence = 'REFERENCE_MEASURED' | 'MODEL_CALCULATED' | 'ILLUSTRATIVE' | 'UNVERIFIED' | 'UNSUPPORTED';

export const EVIDENCE_LEVELS: readonly Evidence[] = [
  'REFERENCE_MEASURED',
  'MODEL_CALCULATED',
  'ILLUSTRATIVE',
  'UNVERIFIED',
  'UNSUPPORTED',
];

export interface Quantity {
  readonly value: number;
  readonly unit: string;
  readonly uncertainty?: number;
}

export interface Transform {
  readonly positionM: readonly [number, number, number];
  readonly quaternion: readonly [number, number, number, number];
}

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

export const APPARATUS_KINDS: readonly ApparatusKind[] = [
  'BENCH',
  'STAND',
  'CLAMP',
  'BURETTE',
  'FLASK',
  'BEAKER',
  'PIPETTE',
  'STIRRER',
  'PH_PROBE',
  'BALANCE',
  'OTHER',
];

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

export const CAPABILITIES: readonly Capability[] = [
  'CONTAINER',
  'FLOW_SOURCE',
  'FLOW_RECEIVER',
  'MOUNT',
  'MOUNTABLE',
  'HEATING',
  'STIRRING',
  'PH_SENSOR',
  'MEASUREMENT',
];

export interface ApparatusInstance {
  readonly id: UUID;
  readonly kind: ApparatusKind;
  /** Identifier of the `ApparatusDefinition` (Agent 03 registry) this instance was placed from. */
  readonly definitionId: string;
  readonly transform: Transform;
  /** Increases every time this instance's own fields change; lets consumers diff cheaply. */
  readonly revision: number;
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

export type MixingModel = 'WELL_MIXED' | 'UNMIXED';

export interface ContainerContents {
  readonly volumeL: number;
  readonly species: readonly SpeciesAmount[];
  readonly temperatureK: number;
  readonly mixing: MixingModel;
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

export const LAB_ACTION_TYPES: readonly LabActionType[] = [
  'PLACE',
  'MOVE',
  'ATTACH',
  'DETACH',
  'FILL',
  'SET_VALVE',
  'TRANSFER',
  'START_STIRRER',
  'SET_PROBE',
  'RESET',
  'CUSTOM',
];

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

// --- Agent 07 additive runtime types -----------------------------------------------------------
//
// Everything below this line is *not* in the shared contract's Section 3 listing. It is additive
// vocabulary Agent 07's reducer needs and that does not change any field above, so it cannot break
// another agent reading the canonical shapes. Flagged here rather than hidden in the web app so
// Agent 09 (persistence) and Agent 10 (integration) can see it while reviewing this package.

/** Lifecycle of a station's simulation clock; drives pause/resume (Section 6 step 7). */
export type ClockStatus = 'IDLE' | 'RUNNING' | 'PAUSED';

export function isApparatusKind(value: unknown): value is ApparatusKind {
  return typeof value === 'string' && (APPARATUS_KINDS as readonly string[]).includes(value);
}

export function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && (CAPABILITIES as readonly string[]).includes(value);
}

export function isEvidence(value: unknown): value is Evidence {
  return typeof value === 'string' && (EVIDENCE_LEVELS as readonly string[]).includes(value);
}

export function isLabActionType(value: unknown): value is LabActionType {
  return typeof value === 'string' && (LAB_ACTION_TYPES as readonly string[]).includes(value);
}
