import type { LabAction, LabActionType, ReplayStep, RuntimeControl } from './actions.ts';
import type { ApparatusDefinitionReader } from './apparatus.ts';
import type { JsonObject, ProblemDetails, RunStatus, UUID } from './common.ts';
import type { Capability, ExperimentScene } from './scene.ts';
import type { CumulativeTransfer, EquilibriumInput, ObservationRecord, TerminalRunResult } from './science.ts';

export type StationStatus = 'PREPARING' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'FAILED' | 'UNSUPPORTED';
export interface StationRuntimeState {
  readonly stationId: UUID;
  readonly epoch: number;
  readonly status: StationStatus;
  readonly simulationTimeS: number;
  readonly tick: number;
  readonly speed: number;
  readonly error?: ProblemDetails;
}
export interface ApparatusRuntimeState {
  readonly valveOpeningFraction?: number;
  readonly deliveredVolumeL?: number;
  readonly stirring?: { readonly enabled: boolean; readonly frequencyHz: number };
  readonly probe?: { readonly containerInstanceId: UUID | null };
}
export type ActionReceipt = {
  readonly actionId: UUID;
  readonly sequence: number;
  readonly runtimeRevision: number;
  readonly stationId: UUID;
  readonly epoch: number;
} & (
  | { readonly status: 'APPLIED' }
  | { readonly status: 'REJECTED'; readonly error: ProblemDetails }
);
export type ControlReceipt = {
  readonly controlId: UUID;
  readonly sequence: number;
  readonly runtimeRevision: number;
  readonly stationId: UUID;
  readonly epoch: number;
} & (
  | { readonly status: 'APPLIED' }
  | { readonly status: 'REJECTED'; readonly error: ProblemDetails }
);
export interface RuntimeSnapshot {
  readonly schemaVersion: 1;
  readonly runId: UUID;
  readonly revision: number;
  readonly scene: ExperimentScene;
  readonly stationStates: Readonly<Record<UUID, StationRuntimeState>>;
  readonly apparatusStates: Readonly<Record<UUID, ApparatusRuntimeState>>;
  readonly transferTotals: readonly CumulativeTransfer[];
  readonly observations: readonly ObservationRecord[];
  readonly lastSequence: number;
}
interface RuntimeEventBase {
  readonly runId: UUID;
  readonly sequence: number;
  readonly stationId: UUID;
  readonly epoch: number;
}
export type LabRuntimeEvent = RuntimeEventBase & (
  | { readonly type: 'ACTION'; readonly action: LabAction; readonly receipt: ActionReceipt }
  | { readonly type: 'CONTROL'; readonly control: RuntimeControl; readonly receipt: ControlReceipt }
  | { readonly type: 'ADVANCE'; readonly fromSimulationS: number; readonly toSimulationS: number; readonly ticks: number }
  | { readonly type: 'OBSERVATIONS'; readonly observations: readonly ObservationRecord[] }
  | { readonly type: 'STATUS'; readonly status: RunStatus; readonly error?: ProblemDetails }
);
export interface RuntimeCheckpoint {
  readonly schemaVersion: 1;
  readonly contractVersion: string;
  readonly runtimeVersion: string;
  readonly methodVersion: string;
  readonly inputHash: string;
  readonly initialScene: ExperimentScene;
  readonly snapshot: RuntimeSnapshot;
  readonly steps: readonly ReplayStep[];
  readonly completedStepCount: number;
  readonly limits?: RunLimits;
  /** Append-only across resets. Rebuild action/control idempotency indexes from these events. */
  readonly events: readonly LabRuntimeEvent[];
}
export interface RunLimits {
  readonly maxTicks: number;
  readonly maxActions: number;
  readonly maxObservations: number;
  readonly maxSimulationTimeS: number;
}
export interface NodeRunRequest {
  readonly schemaVersion: 1;
  readonly runId: UUID;
  readonly contractVersion: string;
  readonly runtimeVersion: string;
  readonly methodVersion: string;
  readonly initialScene: ExperimentScene;
  readonly steps: readonly ReplayStep[];
  readonly limits?: RunLimits;
}
export interface NodeRunResponse {
  readonly schemaVersion: 1;
  readonly result: TerminalRunResult;
  readonly checkpoint?: RuntimeCheckpoint;
}

export interface LabRuntimeReader {
  getSnapshot(): RuntimeSnapshot;
  subscribe(listener: (snapshot: RuntimeSnapshot, event: LabRuntimeEvent) => void): () => void;
}
export interface LabActionAdapter {
  dispatch(action: LabAction): Promise<ActionReceipt>;
  control(command: RuntimeControl): Promise<ControlReceipt>;
}
export interface LabRuntimeAdapter {
  readonly reader: LabRuntimeReader;
  readonly actions: LabActionAdapter;
}
export interface ModelSupport {
  readonly status: 'SUPPORTED' | 'UNSUPPORTED';
  readonly reasons: readonly string[];
  readonly methodId: string;
}
export interface ExperimentPlugin {
  readonly id: string;
  readonly version: string;
  readonly methodId: string;
  readonly requiredCapabilities: readonly Capability[];
  readonly supportedActionTypes: readonly LabActionType[];
  getSupport(scene: ExperimentScene, stationId: UUID, definitions: ApparatusDefinitionReader): ModelSupport;
  getSolverInputs(snapshot: RuntimeSnapshot, stationId: UUID): readonly EquilibriumInput[];
}
export interface ApparatusCapabilityPlugin {
  readonly id: string;
  readonly version: string;
  readonly capability: Capability;
  readonly actionTypes: readonly LabActionType[];
  validateAction(snapshot: RuntimeSnapshot, action: LabAction): ProblemDetails | null;
  /** Propose commands; only the authoritative reducer may apply them. */
  proposeActions(snapshot: RuntimeSnapshot, stationId: UUID, tick: number): readonly LabAction[];
  readonly metadata?: JsonObject;
}
export type NodeRunExecutor = (request: NodeRunRequest) => Promise<NodeRunResponse>;
