import { describe, expect, it, vi } from 'vitest';
import { OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';
import { createLabCameraController } from './CameraController';
import type { CameraDriver } from './CameraController';
import {
  cameraViewForMode, copyCameraView, DEFAULT_CAMERA_VIEW, fitCameraToBounds, interpolateCameraView,
} from './cameraMath';
import { ROOM_PRESETS } from './RoomConfig';
import type { LabBoundsM, LabCameraView } from './types';

function driverFixture() {
  let view = copyCameraView(DEFAULT_CAMERA_VIEW);
  let pending: { view: LabCameraView; complete?: () => void } | null = null;
  const requests: { view: LabCameraView; durationS: number }[] = [];
  const driver: CameraDriver = {
    getView: () => view,
    moveTo(next, durationS, complete) {
      requests.push({ view: copyCameraView(next), durationS });
      if (durationS === 0) { view = copyCameraView(next); complete?.(); }
      else pending = { view: copyCameraView(next), complete };
    },
    cancelMotion: vi.fn(() => { pending = null; }),
    setEnabled: vi.fn(),
    getWorldRay: () => null,
    projectPoint: () => ({ clientX: 0, clientY: 0, visible: true }),
  };
  return {
    driver, requests,
    setLive(next: LabCameraView) { view = copyCameraView(next); },
    getPending() { return pending; },
    finish() {
      const next = pending;
      pending = null;
      if (next) { view = next.view; next.complete?.(); }
    },
  };
}

describe('camera fit math', () => {
  const bounds: LabBoundsM = { minM: [-1.2, 0.9, -0.525], maxM: [1.2, 1.8, 0.525] };
  it.each([0.5, 1, 2.6])('fits every apparatus bound corner at aspect %s without modifying world coordinates', (aspect) => {
    const before = JSON.stringify(bounds);
    const view = fitCameraToBounds(bounds, { aspect });
    const camera = new PerspectiveCamera(view.fovDeg, aspect, 0.005, 150);
    camera.position.set(...view.positionM);
    camera.lookAt(new Vector3(...view.targetM));
    camera.updateMatrixWorld();
    for (const x of [bounds.minM[0], bounds.maxM[0]]) {
      for (const y of [bounds.minM[1], bounds.maxM[1]]) {
        for (const z of [bounds.minM[2], bounds.maxM[2]]) {
          const ndc = new Vector3(x, y, z).project(camera);
          expect(Math.abs(ndc.x)).toBeLessThan(1);
          expect(Math.abs(ndc.y)).toBeLessThan(1);
        }
      }
    }
    expect(JSON.stringify(bounds)).toBe(before);
  });

  it('fits an orthographic top-down layout with a nondegenerate north-up axis', () => {
    const aspect = 0.6;
    const view = fitCameraToBounds(bounds, { mode: 'top-down', aspect });
    const half = view.orthographicHeightM / 2;
    const camera = new OrthographicCamera(-half * aspect, half * aspect, half, -half, 0.005, 150);
    camera.up.set(0, 0, -1);
    camera.position.set(...view.positionM);
    camera.lookAt(new Vector3(...view.targetM));
    camera.updateMatrixWorld();
    const left = new Vector3(...bounds.minM).project(camera);
    const right = new Vector3(...bounds.maxM).project(camera);
    expect(left.x).toBeLessThan(right.x);
    expect(Math.max(Math.abs(left.x), Math.abs(right.x), Math.abs(left.y), Math.abs(right.y))).toBeLessThan(1);
    expect(cameraViewForMode(view, 'inspection').mode).toBe('inspection');
  });

  it('uses bounded deterministic easing and rejects invalid fit parameters', () => {
    const to = fitCameraToBounds(bounds);
    expect(interpolateCameraView(DEFAULT_CAMERA_VIEW, to, 0)).toEqual({ ...DEFAULT_CAMERA_VIEW, mode: to.mode });
    expect(interpolateCameraView(DEFAULT_CAMERA_VIEW, to, 1)).toEqual(to);
    expect(interpolateCameraView(DEFAULT_CAMERA_VIEW, to, 0.5).positionM[0]).toBeCloseTo((DEFAULT_CAMERA_VIEW.positionM[0] + to.positionM[0]) / 2);
    expect(() => fitCameraToBounds(bounds, { aspect: 0 })).toThrow();
  });
});

describe('single-owner camera controller', () => {
  it('freezes at the actual in-flight pose; overlapping editor locks reject navigation and never resume the old transition', () => {
    const controller = createLabCameraController();
    const fixture = driverFixture();
    controller.connectDriver(fixture.driver);
    const destination = { ...DEFAULT_CAMERA_VIEW, positionM: [1, 1.8, 2] as const };
    controller.setView(destination);
    const actual = interpolateCameraView(DEFAULT_CAMERA_VIEW, destination, 0.4);
    fixture.setLive(actual);
    const releaseDrag = controller.acquireControlLock('apparatus-drag');
    const releaseDialog = controller.acquireControlLock('placement-dialog');
    const requestCount = fixture.requests.length;
    expect(controller.setMode('top-down')).toBe(false);
    expect(controller.focusBounds({ minM: [0, 0, 0], maxM: [1, 1, 1] })).toBe(false);
    expect(controller.getSnapshot().view).toEqual(actual);
    expect(fixture.getPending()).toBeNull();
    releaseDrag();
    releaseDrag();
    expect(controller.getSnapshot().controlsLocked).toBe(true);
    releaseDialog();
    expect(controller.getSnapshot().controlsLocked).toBe(false);
    expect(fixture.requests.length).toBe(requestCount);
    expect(fixture.driver.setEnabled).toHaveBeenLastCalledWith(true);
  });

  it('isolates station focus and bookmarks from caller-owned apparatus coordinates', () => {
    const controller = createLabCameraController({ makeBookmarkId: () => 'bookmark-1' });
    const stations = [
      { id: 'a', label: 'A', boundsM: { minM: [-2, 0, -1] as const, maxM: [0, 2, 1] as const } },
      { id: 'b', label: 'B', boundsM: { minM: [2, 0, -1] as const, maxM: [4, 2, 1] as const } },
    ];
    const before = JSON.stringify(stations);
    controller.setStations(stations);
    controller.focusStation('a');
    const bookmark = controller.saveBookmark('Station A')!;
    const saved = controller.getView();
    controller.focusStation('b');
    expect(controller.getView().targetM[0]).toBe(3);
    expect(controller.restoreBookmark(bookmark)).toBe(true);
    expect(controller.getView()).toEqual(saved);
    expect(controller.getSnapshot().activeStationId).toBe('a');
    expect(controller.focusStation('missing')).toBe(false);
    expect(JSON.stringify(stations)).toBe(before);
  });

  it('allows only one director and publishes completed views, not per-frame live updates', () => {
    const controller = createLabCameraController();
    const fixture = driverFixture();
    const disconnect = controller.connectDriver(fixture.driver);
    expect(() => controller.connectDriver(driverFixture().driver)).toThrow(/two canvases/);
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    for (let frame = 0; frame < 60; frame += 1) fixture.setLive({ ...DEFAULT_CAMERA_VIEW, positionM: [2 + frame / 100, 2, 3] });
    expect(listener).not.toHaveBeenCalled();
    controller.commitView(fixture.driver.getView());
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    disconnect();
    expect(() => controller.connectDriver(fixture.driver)).not.toThrow();
  });

  it('walk mode settles inside the current room without changing the viewing direction', () => {
    const controller = createLabCameraController();
    controller.setNavigationBounds(ROOM_PRESETS.compact.navigationBoundsM);
    const before = controller.getView();
    controller.setMode('first-person');
    const after = controller.getView();
    expect(after.positionM[0]).toBeLessThanOrEqual(ROOM_PRESETS.compact.navigationBoundsM.maxM[0]);
    expect(after.positionM[2]).toBeLessThanOrEqual(ROOM_PRESETS.compact.navigationBoundsM.maxM[2]);
    const headingBefore = new Vector3(...before.targetM).sub(new Vector3(...before.positionM)).normalize();
    const headingAfter = new Vector3(...after.targetM).sub(new Vector3(...after.positionM)).normalize();
    expect(headingAfter.distanceTo(headingBefore)).toBeLessThan(1e-10);
  });

  it('hands one canvas to its fallback renderer without allowing stale teardown to replace the new camera', () => {
    const controller = createLabCameraController();
    const owner = Symbol('one-canvas');
    const original = driverFixture();
    const replacement = driverFixture();
    const disconnectOriginal = controller.connectDriver(original.driver, owner);
    controller.startCinematic([DEFAULT_CAMERA_VIEW, { ...DEFAULT_CAMERA_VIEW, positionM: [2, 2, 3] }]);
    const oldCinematicCallback = original.getPending()?.complete;
    const moved = { ...DEFAULT_CAMERA_VIEW, positionM: [1.2, 1.7, 2.3] as const };
    original.setLive(moved);
    controller.connectDriver(replacement.driver, owner);
    expect(original.driver.setEnabled).toHaveBeenLastCalledWith(false);
    expect(controller.getView()).toEqual(moved);
    const replacementRequests = replacement.requests.length;
    oldCinematicCallback?.();
    expect(replacement.requests.length).toBe(replacementRequests);
    expect(controller.getSnapshot().cinematic).toBe('skipped');
    replacement.setLive(DEFAULT_CAMERA_VIEW);
    disconnectOriginal();
    expect(controller.getView()).toEqual(DEFAULT_CAMERA_VIEW);
    expect(() => controller.connectDriver(driverFixture().driver, Symbol('other-canvas'))).toThrow(/two canvases/);
  });
});

describe('skippable accessible camera entry', () => {
  const end = { ...DEFAULT_CAMERA_VIEW, positionM: [1.5, 1.8, 2] as const };
  it('skips animation for reduced motion and does not replay a stale cinematic callback after editor capture', () => {
    const controller = createLabCameraController({ reducedMotion: true });
    const fixture = driverFixture();
    controller.connectDriver(fixture.driver);
    controller.startCinematic([DEFAULT_CAMERA_VIEW, end]);
    expect(controller.getSnapshot().cinematic).toBe('skipped');
    expect(fixture.requests.at(-1)?.durationS).toBe(0);
    expect(controller.getView()).toEqual(end);
    controller.setReducedMotion(false);
    controller.startCinematic([DEFAULT_CAMERA_VIEW, end]);
    const oldCallback = fixture.getPending()?.complete;
    const release = controller.acquireControlLock('drag');
    const count = fixture.requests.length;
    oldCallback?.();
    release();
    expect(fixture.requests.length).toBe(count);
    expect(controller.getSnapshot().cinematic).toBe('skipped');
  });

  it('finishes all explicit waypoints, and the skip action lands exactly on the final view', () => {
    const controller = createLabCameraController();
    const fixture = driverFixture();
    controller.connectDriver(fixture.driver);
    controller.startCinematic([DEFAULT_CAMERA_VIEW, end]);
    fixture.finish();
    fixture.finish();
    expect(controller.getSnapshot().cinematic).toBe('finished');
    controller.startCinematic([DEFAULT_CAMERA_VIEW, end]);
    controller.skipCinematic();
    expect(controller.getView()).toEqual(end);
    expect(controller.getSnapshot().cinematic).toBe('skipped');
  });
});
