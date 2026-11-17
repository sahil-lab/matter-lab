/**
 * A small window onto the running lab editor for automated browser tests, mirroring
 * `apps/web/src/testApi.ts`'s `installTestApi` pattern exactly (same shape, same "only in
 * development" guard, same rationale: a normal production build exposes nothing).
 */
import type { Camera } from 'three';
import type { LabReducer } from '../../experiments/labReducer';
import { actionSink } from '../actionSink';
import * as commands from '../commands';
import { labEditor, pickIndex, useLabEditor } from '../editorStore';
import * as operationalActions from '../operationalActions';
import * as serialization from '../serialization';

export function installLabEditorTestApi(reducer: LabReducer, getCamera: () => Camera | null = () => null): () => void {
  if (!(import.meta.env.DEV || import.meta.env.VITE_TEST_API === '1')) return () => {};
  const api = {
    labEditor,
    useLabEditor,
    actionSink,
    reducer,
    commands,
    operationalActions,
    serialization,
    pickIndexSize: () => pickIndex.size,
    /** `[x, y, z]`, purely for diagnostics (e.g. "the camera never moves while dragging apparatus"). */
    cameraPosition: (): readonly [number, number, number] | null => {
      const camera = getCamera();
      return camera ? [camera.position.x, camera.position.y, camera.position.z] : null;
    },
  };
  (window as unknown as { __MATTERLAB_LAB_EDITOR__?: typeof api }).__MATTERLAB_LAB_EDITOR__ = api;
  return () => {
    delete (window as unknown as { __MATTERLAB_LAB_EDITOR__?: typeof api }).__MATTERLAB_LAB_EDITOR__;
  };
}
