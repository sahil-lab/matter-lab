/**
 * The seam between the editor (this directory, Agent 04) and the authoritative experiment reducer
 * (Agent 07's `lab/experiments/**`). The editor never mutates `ContainerContents` or species
 * inventory itself: every `LabAction` is sent here and only the sink's result is read back — see
 * `00_SHARED_INTEGRATION_CONTRACT.md` Section 4 ("No other agent may independently invent a pH
 * value or change species inventory").
 *
 * This mirrors the `installViewApi`/`installStageApi` pattern in `apps/web/src/render/viewApi.ts`:
 * a stable, always-defined reference (`actionSink`) that forwards to whatever implementation is
 * currently installed, so editor code never has to null-check or wait for wiring order.
 */
import type { ContainerContents, LabAction, Observation, UUID } from './contracts';

export interface ActionRejection {
  readonly code: string;
  readonly message: string;
}

export interface LabActionDispatchResult {
  readonly accepted: boolean;
  readonly rejection?: ActionRejection;
  readonly observations?: readonly Observation[];
  readonly warnings?: readonly string[];
}

export interface LabActionSink {
  dispatch(action: LabAction): LabActionDispatchResult;
  /** Read-only snapshot of authoritative container inventory, keyed by apparatus instance id. */
  getContainerStates(): Readonly<Record<UUID, ContainerContents>>;
  getObservations(apparatusId?: UUID): readonly Observation[];
  /** Replays from the start (or a saved snapshot). Used by the editor's "reset experiment" command — never by scene undo/redo. */
  reset(): void;
}

const idleSink: LabActionSink = {
  dispatch: (action) => ({
    accepted: false,
    rejection: { code: 'NO_SINK', message: `No action sink installed; "${action.type}" was not applied.` },
  }),
  getContainerStates: () => ({}),
  getObservations: () => [],
  reset: () => {},
};

let current: LabActionSink = idleSink;

export const actionSink: LabActionSink = {
  dispatch: (action) => current.dispatch(action),
  getContainerStates: () => current.getContainerStates(),
  getObservations: (apparatusId) => current.getObservations(apparatusId),
  reset: () => current.reset(),
};

/** Installed by `lab/experiments` (or its provisional stand-in) at app start; returns an uninstaller for tests. */
export function installLabActionSink(impl: LabActionSink): () => void {
  current = impl;
  return () => {
    if (current === impl) current = idleSink;
  };
}
