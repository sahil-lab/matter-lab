import type {
  ActionReceipt, ApparatusDefinition, ControlReceipt, ExperimentScene, LabAction, LabRuntimeEvent, ModelSupport,
  ProblemDetails, RunLimits, RuntimeCheckpoint, RuntimeControl, RuntimeSnapshot, UUID,
} from '@matterlab/contracts';

export interface BrowserRuntimeOptions {
  readonly initialScene: ExperimentScene;
  readonly runId: UUID;
  readonly definitions: readonly ApparatusDefinition[];
  readonly limits?: RunLimits;
  readonly checkpoint?: RuntimeCheckpoint;
}
export type RuntimeWorkerRequest = { readonly requestId: UUID } & (
  | { readonly type: 'INIT'; readonly options: BrowserRuntimeOptions }
  | { readonly type: 'ACTION'; readonly action: LabAction }
  | { readonly type: 'CONTROL'; readonly control: RuntimeControl }
  | { readonly type: 'BATCH'; readonly actions: readonly LabAction[] }
  | { readonly type: 'ADVANCE'; readonly stationId: UUID; readonly ticks: number }
  | { readonly type: 'CHECKPOINT' }
  | { readonly type: 'SUPPORT'; readonly stationId: UUID }
);
export type RuntimeWorkerValue = RuntimeSnapshot | RuntimeCheckpoint | ActionReceipt | ControlReceipt |
  readonly ActionReceipt[] | ModelSupport;
export type RuntimeWorkerResponse = {
  readonly requestId: UUID;
  readonly snapshot?: RuntimeSnapshot;
  readonly events: readonly LabRuntimeEvent[];
} & (
  | { readonly ok: true; readonly value: RuntimeWorkerValue }
  | { readonly ok: false; readonly error: ProblemDetails }
);
