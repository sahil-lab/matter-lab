import { executeScienceRequest, type ScienceResponse } from './json.js';

export interface ScienceWorkerScope {
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  postMessage(response: ScienceResponse): void;
}

export function installScienceWorker(scope: ScienceWorkerScope): () => void {
  const listener = (event: { readonly data: unknown }) => scope.postMessage(executeScienceRequest(event.data));
  scope.addEventListener('message', listener);
  return () => scope.removeEventListener('message', listener);
}
