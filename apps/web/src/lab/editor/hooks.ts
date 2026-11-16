import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { RuntimeSnapshot } from '@matterlab/contracts/lab';
import { LabEditorController } from './LabEditorController';
import type { EditorOptions, EditorState } from './types';

export function useLabEditor(options: EditorOptions): LabEditorController {
  const editor = useMemo(() => new LabEditorController(options, false), [options.runtime, options.camera]);
  editor.updateOptions(options);
  useEffect(() => {
    editor.connectRuntime();
    return () => editor.disconnectRuntime();
  }, [editor]);
  return editor;
}
export function useLabEditorState(editor: LabEditorController): EditorState {
  return useSyncExternalStore(editor.subscribe, editor.getSnapshot, editor.getSnapshot);
}
export function useLabRuntimeSelector<T>(
  editor: LabEditorController, selector: (snapshot: RuntimeSnapshot) => T,
  equals: (left: T, right: T) => boolean = Object.is,
): T {
  const config = useRef({ selector, equals });
  config.current = { selector, equals };
  const cache = useMemo(() => ({ snapshot: undefined as RuntimeSnapshot | undefined, value: selector(editor.getRuntimeSnapshot()) }), [editor]);
  const read = useMemo(() => () => {
    const snapshot = editor.getRuntimeSnapshot();
    const next = config.current.selector(snapshot);
    if (!config.current.equals(cache.value, next)) cache.value = next;
    cache.snapshot = snapshot;
    return cache.value;
  }, [editor, cache]);
  const subscribe = useMemo(() => (listener: () => void) => editor.runtime.reader.subscribe(() => listener()), [editor]);
  return useSyncExternalStore(subscribe, read, read);
}
