/**
 * A small window onto the running lab editor for automated browser tests, mirroring
 * `apps/web/src/testApi.ts`'s `installTestApi` pattern exactly (same shape, same "only in
 * development" guard, same rationale: a normal production build exposes nothing).
 */
import { Vector3 } from 'three';
import type { Camera } from 'three';
import type { LabReducer } from '../../experiments/labReducer';
import { actionSink } from '../actionSink';
import * as commands from '../commands';
import { labEditor, pickIndex, useLabEditor } from '../editorStore';
import type { GestureController } from '../GestureController';
import * as operationalActions from '../operationalActions';
import * as serialization from '../serialization';

export function installLabEditorTestApi(reducer: LabReducer, getCamera: () => Camera | null = () => null, getGestures: () => GestureController | null = () => null): () => void {
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
    /**
     * Whether the gesture controller (and therefore the palette's drag/click-to-arm placement,
     * the viewport's pointer handling, and `worldToViewportFraction` below) is actually wired up
     * yet. `window.__MATTERLAB_LAB_EDITOR__` itself is installed as soon as the harness mounts,
     * *before* the R3F canvas and its gesture controller finish initializing — a test that clicks
     * the palette the instant the test hook appears, without waiting for this too, finds `onArm`
     * silently a no-op. Browser tests should wait for this before interacting.
     */
    ready: (): boolean => getGestures() !== null && getCamera() !== null,
    /** `[x, y, z]`, purely for diagnostics (e.g. "the camera never moves while dragging apparatus"). */
    cameraPosition: (): readonly [number, number, number] | null => {
      const camera = getCamera();
      return camera ? [camera.position.x, camera.position.y, camera.position.z] : null;
    },
    /**
     * Converts a world-space point to `[dxFraction, dyFraction]` from the viewport's centre (what
     * `LabEditorPage.clickViewport` in the e2e suite takes), the exact inverse of
     * `GestureController`'s own screen projection. Lets tests click precisely at a known socket
     * instead of guessing pixel offsets — test-only, never used by the editor itself.
     */
    worldToViewportFraction: (positionM: readonly [number, number, number]): [number, number] | null => {
      const camera = getCamera();
      const canvas = document.querySelector('canvas');
      if (!camera || !canvas) return null;
      const vector = new Vector3(positionM[0], positionM[1], positionM[2]).project(camera);
      if (vector.z > 1 || vector.z < -1) return null;
      return [vector.x / 2, -vector.y / 2];
    },
  };
  (window as unknown as { __MATTERLAB_LAB_EDITOR__?: typeof api }).__MATTERLAB_LAB_EDITOR__ = api;
  return () => {
    delete (window as unknown as { __MATTERLAB_LAB_EDITOR__?: typeof api }).__MATTERLAB_LAB_EDITOR__;
  };
}
