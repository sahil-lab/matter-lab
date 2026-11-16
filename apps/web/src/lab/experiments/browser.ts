import type {
  ActionReceipt, ControlReceipt, LabAction, LabActionAdapter, LabRuntimeReader, ModelSupport,
  RuntimeCheckpoint, RuntimeControl, RuntimeSnapshot, UUID,
} from '@matterlab/contracts';
import { LabRuntimeError, problem } from '@matterlab/lab-runtime';
import type { BrowserRuntimeOptions, RuntimeWorkerRequest, RuntimeWorkerResponse, RuntimeWorkerValue } from './protocol';

type MessageBody<Request = RuntimeWorkerRequest> = Request extends RuntimeWorkerRequest ? Omit<Request, 'requestId'> : never;
type Subscriber = Parameters<LabRuntimeReader['subscribe']>[0];
export interface BrowserLabRuntime {
  readonly reader: LabRuntimeReader;
  readonly actions: LabActionAdapter;
  dispatchBatch(actions: readonly LabAction[]): Promise<readonly ActionReceipt[]>;
  advanceStation(stationId: UUID, ticks: number): Promise<RuntimeSnapshot>;
  getCheckpoint(): Promise<RuntimeCheckpoint>;
  getModelSupport(stationId: UUID): Promise<ModelSupport>;
  dispose(): void;
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach((child: unknown) => freeze(child));
    Object.freeze(value);
  }
  return value;
}
export async function createBrowserLabRuntime(
  options: BrowserRuntimeOptions,
  workerFactory: () => Worker = () => new Worker(new URL('./runtime.worker.ts', import.meta.url), { type: 'module' }),
): Promise<BrowserLabRuntime> {
  const worker = workerFactory();
  const pending = new Map<UUID, { resolve(value: RuntimeWorkerValue): void; reject(error: unknown): void }>();
  const listeners = new Set<Subscriber>();
  let snapshot: RuntimeSnapshot;
  let disposed = false;
  const request = <T extends RuntimeWorkerValue>(body: MessageBody): Promise<T> => {
    if (disposed) return Promise.reject(new LabRuntimeError(problem('CANCELLED', 'Laboratory worker is disposed.')));
    return new Promise<T>((resolve, reject) => {
      const requestId = crypto.randomUUID();
      pending.set(requestId, { resolve: (value) => resolve(value as T), reject });
      try { worker.postMessage({ ...body, requestId }); }
      catch (error) { pending.delete(requestId); reject(error); }
    });
  };
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    worker.terminate();
    const error = new LabRuntimeError(problem('CANCELLED', 'Laboratory worker was terminated.'));
    for (const promise of pending.values()) promise.reject(error);
    pending.clear();
    listeners.clear();
  };
  worker.onmessage = (event: MessageEvent<RuntimeWorkerResponse>) => {
    const response = event.data;
    const promise = pending.get(response.requestId);
    if (!promise) return;
    pending.delete(response.requestId);
    if (response.snapshot) snapshot = freeze(response.snapshot);
    if (response.ok) promise.resolve(freeze(response.value));
    else promise.reject(new LabRuntimeError(response.error));
    for (const runtimeEvent of response.events) {
      for (const listener of listeners) {
        try { listener(snapshot, freeze(runtimeEvent)); } catch { /* A renderer cannot reject committed runtime commands. */ }
      }
    }
  };
  worker.onerror = (event) => {
    const error = new LabRuntimeError(problem('RUNTIME_ERROR', event.message || 'Laboratory worker failed.', 500));
    for (const promise of pending.values()) promise.reject(error);
    pending.clear();
    dispose();
  };
  try { snapshot = freeze(await request<RuntimeSnapshot>({ type: 'INIT', options })); }
  catch (error) { dispose(); throw error; }
  return Object.freeze({
    reader: Object.freeze({
      getSnapshot: () => snapshot,
      subscribe: (listener: Subscriber) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    }),
    actions: Object.freeze({
      dispatch: (action: LabAction) => request<ActionReceipt>({ type: 'ACTION', action }),
      control: (control: RuntimeControl) => request<ControlReceipt>({ type: 'CONTROL', control }),
    }),
    dispatchBatch: (actions: readonly LabAction[]) => request<readonly ActionReceipt[]>({ type: 'BATCH', actions }),
    advanceStation: (stationId: UUID, ticks: number) => request<RuntimeSnapshot>({ type: 'ADVANCE', stationId, ticks }),
    getCheckpoint: () => request<RuntimeCheckpoint>({ type: 'CHECKPOINT' }),
    getModelSupport: (stationId: UUID) => request<ModelSupport>({ type: 'SUPPORT', stationId }),
    dispose,
  });
}
