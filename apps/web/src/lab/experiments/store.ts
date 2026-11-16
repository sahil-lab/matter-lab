import { useSyncExternalStore } from 'react';
import { createStore } from 'zustand/vanilla';
import type { LabRuntimeReader, RuntimeSnapshot } from '@matterlab/contracts';

export function useLabRuntimeSnapshot(reader: LabRuntimeReader): RuntimeSnapshot {
  return useSyncExternalStore(reader.subscribe, reader.getSnapshot, reader.getSnapshot);
}
export function createLabRuntimeStore(reader: LabRuntimeReader) {
  const store = createStore<{ readonly snapshot: RuntimeSnapshot }>()(() => ({ snapshot: reader.getSnapshot() }));
  const unsubscribe = reader.subscribe((snapshot) => {
    if (snapshot !== store.getState().snapshot) store.setState({ snapshot });
  });
  return Object.freeze({
    getState: store.getState, getInitialState: store.getInitialState, subscribe: store.subscribe,
    dispose: unsubscribe,
  });
}
