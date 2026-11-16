import { createRuntimeWorkerHost } from './worker-host';
import type { RuntimeWorkerRequest, RuntimeWorkerResponse } from './protocol';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<RuntimeWorkerRequest>) => void) | null;
  postMessage(value: RuntimeWorkerResponse): void;
};
const handle = createRuntimeWorkerHost((response) => scope.postMessage(response));
scope.onmessage = (event) => { void handle(event.data); };
