import type {
  ActionReceipt, ApparatusCapabilityPlugin, ApparatusDefinitionReader, AsyncEquilibriumSolver, EquilibriumSolver, ExperimentPlugin,
  JsonObject, LabAction, LabRuntimeAdapter, ModelSupport, RunLimits, RuntimeCheckpoint, RuntimeSnapshot, UUID,
} from '@matterlab/contracts';

export interface RuntimeScience {
  readonly solve: EquilibriumSolver | AsyncEquilibriumSolver;
  readonly methodId: string;
  readonly methodVersion: string;
  readonly assumptions: readonly string[];
}
export interface RuntimeDependencies {
  readonly definitions: ApparatusDefinitionReader;
  readonly science: RuntimeScience;
  readonly experiments?: readonly ExperimentPlugin[];
  readonly capabilities?: readonly ApparatusCapabilityPlugin[];
}
export interface LabRuntimeOptions extends RuntimeDependencies {
  readonly initialScene: RuntimeSnapshot['scene'];
  readonly runId: UUID;
  readonly limits?: RunLimits;
}
export interface LabRuntime extends LabRuntimeAdapter {
  dispatchBatch(actions: readonly LabAction[]): Promise<readonly ActionReceipt[]>;
  advanceStation(stationId: UUID, ticks: number): Promise<RuntimeSnapshot>;
  getCheckpoint(): Promise<RuntimeCheckpoint>;
  getModelSupport(stationId: UUID): ModelSupport;
  getDiagnostics(): JsonObject;
  dispose(): void;
}
