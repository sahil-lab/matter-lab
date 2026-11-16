import { Vector3 } from 'three';
import { assertBoundsM } from './coordinates';
import {
  cameraViewForMode, clampFirstPersonPosition, copyCameraView, DEFAULT_CAMERA_VIEW, fitCameraToBounds, validateCameraView,
} from './cameraMath';
import { STUDIO_NAVIGATION_BOUNDS } from './RoomConfig';
import type {
  CameraBookmark, LabBoundsM, LabCameraMode, LabCameraView, LabStation, ProjectedPoint, WorldPointM, WorldRayM,
} from './types';

export interface CameraSnapshot {
  readonly view: LabCameraView;
  readonly controlsLocked: boolean;
  readonly lockReasons: readonly string[];
  readonly reducedMotion: boolean;
  readonly cinematic: 'idle' | 'playing' | 'finished' | 'skipped';
  readonly bookmarks: readonly CameraBookmark[];
  readonly stations: readonly LabStation[];
  readonly activeStationId?: string;
}

/** Driver is implemented only by CameraDirector. Other components issue controller commands. */
export interface CameraDriver {
  getView(): LabCameraView;
  moveTo(view: LabCameraView, durationS: number, onComplete?: () => void): void;
  cancelMotion(): void;
  setEnabled(enabled: boolean): void;
  getWorldRay(clientX: number, clientY: number): WorldRayM | null;
  projectPoint(pointM: WorldPointM): ProjectedPoint;
}

export class LabCameraController {
  private snapshot: CameraSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly locks = new Map<symbol, string>();
  private driver: CameraDriver | null = null;
  private driverOwner: symbol | undefined;
  private aspect = 1;
  private navigationBounds: LabBoundsM = STUDIO_NAVIGATION_BOUNDS;
  private cinematicGeneration = 0;
  private cinematicEnd: LabCameraView | null = null;
  private readonly makeBookmarkId: () => string;

  constructor(options: {
    initialView?: LabCameraView;
    reducedMotion?: boolean;
    bookmarks?: readonly CameraBookmark[];
    makeBookmarkId?: () => string;
  } = {}) {
    const view = options.initialView ?? DEFAULT_CAMERA_VIEW;
    validateCameraView(view);
    if ((options.bookmarks?.length ?? 0) > 32) throw new RangeError('At most 32 camera bookmarks are supported.');
    this.snapshot = {
      view: copyCameraView(view), controlsLocked: false, lockReasons: [],
      reducedMotion: options.reducedMotion ?? false, cinematic: 'idle', stations: [],
      bookmarks: (options.bookmarks ?? []).map((bookmark) => {
        validateCameraView(bookmark.view);
        return { ...bookmark, view: copyCameraView(bookmark.view) };
      }),
    };
    this.makeBookmarkId = options.makeBookmarkId ?? (() => globalThis.crypto.randomUUID());
  }

  getSnapshot = (): CameraSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  getView = (): LabCameraView => copyCameraView(this.driver?.getView() ?? this.snapshot.view);
  getWorldRay = (clientX: number, clientY: number): WorldRayM | null =>
    this.driver?.getWorldRay(clientX, clientY) ?? null;
  projectPoint = (pointM: WorldPointM): ProjectedPoint | null => this.driver?.projectPoint(pointM) ?? null;

  private publish(patch: Partial<CameraSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** One isolated canvas owns a controller; a second simultaneous director is a programming error. */
  connectDriver(driver: CameraDriver, canvasOwner?: symbol): () => void {
    if (this.driver) {
      if (!canvasOwner || this.driverOwner !== canvasOwner) throw new Error('A LabCameraController cannot own two canvases.');
      // Renderer fallback roots can overlap during async teardown. Hand off only within one LabCanvas.
      const view = copyCameraView(this.driver.getView());
      this.driver.cancelMotion();
      this.driver.setEnabled(false);
      this.cinematicGeneration += 1;
      this.snapshot = { ...this.snapshot, view, cinematic: this.snapshot.cinematic === 'playing' ? 'skipped' : this.snapshot.cinematic };
    }
    this.driver = driver;
    this.driverOwner = canvasOwner;
    driver.moveTo(this.snapshot.view, 0);
    driver.setEnabled(!this.snapshot.controlsLocked);
    return () => {
      if (this.driver !== driver) return;
      const view = copyCameraView(driver.getView());
      driver.cancelMotion();
      this.driver = null;
      this.driverOwner = undefined;
      this.cinematicGeneration += 1;
      this.publish({ view, cinematic: this.snapshot.cinematic === 'playing' ? 'skipped' : this.snapshot.cinematic });
    };
  }

  setAspect(aspect: number): void {
    if (Number.isFinite(aspect) && aspect > 0) this.aspect = aspect;
  }

  getNavigationBounds = (): LabBoundsM => this.navigationBounds;
  setNavigationBounds(bounds: LabBoundsM): void {
    assertBoundsM(bounds);
    this.navigationBounds = { minM: [...bounds.minM], maxM: [...bounds.maxM] };
  }

  /** Called at the end of user motion, not on every animation frame. */
  commitView(view: LabCameraView): void {
    validateCameraView(view);
    this.publish({ view: copyCameraView(view) });
  }

  interruptMotion(): void {
    this.cinematicGeneration += 1;
    this.driver?.cancelMotion();
    this.publish({
      view: this.getView(),
      cinematic: this.snapshot.cinematic === 'playing' ? 'skipped' : this.snapshot.cinematic,
    });
  }

  setView(view: LabCameraView, options: { animate?: boolean; durationS?: number } = {}): boolean {
    if (this.snapshot.controlsLocked) return false;
    validateCameraView(view);
    const duration = options.durationS ?? 0.65;
    if (!Number.isFinite(duration) || duration < 0 || duration > 10) throw new RangeError('Invalid camera transition duration.');
    this.cinematicGeneration += 1;
    this.driver?.cancelMotion();
    const copy = copyCameraView(view);
    this.publish({
      view: copy,
      cinematic: this.snapshot.cinematic === 'playing' ? 'skipped' : this.snapshot.cinematic,
    });
    this.driver?.moveTo(copy, options.animate === false || this.snapshot.reducedMotion ? 0 : duration);
    return true;
  }

  setMode(mode: LabCameraMode): boolean {
    if (this.snapshot.controlsLocked) return false;
    const view = cameraViewForMode(this.getView(), mode);
    if (mode === 'first-person') {
      const positionM = clampFirstPersonPosition(view.positionM, this.navigationBounds);
      const offset = new Vector3(...positionM).sub(new Vector3(...view.positionM));
      return this.setView({ ...view, positionM, targetM: new Vector3(...view.targetM).add(offset).toArray() }, { durationS: 0.45 });
    }
    // Projection switches are immediate; an oblique intermediate orthographic frame is not a top view.
    return this.setView(view, { animate: false });
  }

  focusBounds(
    bounds: LabBoundsM,
    options: { mode?: LabCameraMode; padding?: number; animate?: boolean } = {},
  ): boolean {
    if (this.snapshot.controlsLocked) return false;
    return this.setView(fitCameraToBounds(bounds, {
      mode: options.mode, padding: options.padding, from: this.getView(), aspect: this.aspect,
    }), { animate: options.animate });
  }

  setStations(stations: readonly LabStation[]): void {
    if (stations.length > 32 || new Set(stations.map((station) => station.id)).size !== stations.length) {
      throw new RangeError('Stations must have unique IDs, with at most 32 visible station descriptors.');
    }
    for (const station of stations) assertBoundsM(station.boundsM);
    this.publish({
      stations: stations.map((station) => ({
        ...station, boundsM: { minM: [...station.boundsM.minM], maxM: [...station.boundsM.maxM] },
      })),
      activeStationId: stations.some((station) => station.id === this.snapshot.activeStationId)
        ? this.snapshot.activeStationId : undefined,
    });
  }

  focusStation(id: string): boolean {
    const station = this.snapshot.stations.find((entry) => entry.id === id);
    if (!station || !this.focusBounds(station.boundsM)) return false;
    this.publish({ activeStationId: id });
    return true;
  }

  saveBookmark(name: string): string | null {
    const label = name.trim();
    if (!label || label.length > 64 || this.snapshot.bookmarks.length >= 32) return null;
    const bookmark: CameraBookmark = {
      id: this.makeBookmarkId(), name: label, view: this.getView(), stationId: this.snapshot.activeStationId,
    };
    this.publish({ bookmarks: [...this.snapshot.bookmarks, bookmark] });
    return bookmark.id;
  }

  restoreBookmark(id: string): boolean {
    const bookmark = this.snapshot.bookmarks.find((entry) => entry.id === id);
    if (!bookmark || !this.setView(bookmark.view)) return false;
    this.publish({ activeStationId: bookmark.stationId });
    return true;
  }

  removeBookmark(id: string): void {
    this.publish({ bookmarks: this.snapshot.bookmarks.filter((entry) => entry.id !== id) });
  }

  /** Acquire before editor drag capture; release in pointerup, pointercancel and unmount/finally. */
  acquireControlLock(reason: string): () => void {
    const token = Symbol(reason);
    this.locks.set(token, reason || 'editor');
    if (this.locks.size === 1) {
      this.cinematicGeneration += 1;
      this.driver?.cancelMotion();
      this.driver?.setEnabled(false);
    }
    this.publish({
      view: this.getView(), controlsLocked: true, lockReasons: [...this.locks.values()],
      cinematic: this.snapshot.cinematic === 'playing' ? 'skipped' : this.snapshot.cinematic,
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.locks.delete(token);
      if (this.locks.size === 0) this.driver?.setEnabled(true);
      this.publish({ controlsLocked: this.locks.size > 0, lockReasons: [...this.locks.values()] });
    };
  }

  setReducedMotion(reducedMotion: boolean): void {
    if (this.snapshot.reducedMotion === reducedMotion) return;
    this.publish({ reducedMotion });
    if (reducedMotion && this.snapshot.cinematic === 'playing') this.skipCinematic();
    else if (reducedMotion) this.interruptMotion();
  }

  startCinematic(waypoints: readonly LabCameraView[], durationPerLegS = 1.4): boolean {
    if (this.snapshot.controlsLocked || waypoints.length === 0 || waypoints.length > 8) return false;
    if (!Number.isFinite(durationPerLegS) || durationPerLegS < 0.1 || durationPerLegS > 5) {
      throw new RangeError('Cinematic legs must last 0.1–5 seconds.');
    }
    waypoints.forEach(validateCameraView);
    this.cinematicEnd = copyCameraView(waypoints[waypoints.length - 1]);
    if (this.snapshot.reducedMotion || !this.driver) {
      this.setView(this.cinematicEnd, { animate: false });
      this.publish({ cinematic: 'skipped' });
      return true;
    }
    this.driver.cancelMotion();
    const generation = ++this.cinematicGeneration;
    this.publish({ cinematic: 'playing' });
    const next = (index: number): void => {
      if (generation !== this.cinematicGeneration || this.snapshot.controlsLocked) return;
      if (index === waypoints.length) {
        this.publish({ view: this.getView(), cinematic: 'finished' });
        return;
      }
      const view = copyCameraView(waypoints[index]);
      this.publish({ view });
      this.driver?.moveTo(view, durationPerLegS, () => next(index + 1));
    };
    next(0);
    return true;
  }

  skipCinematic(): void {
    if (this.snapshot.cinematic !== 'playing') return;
    this.cinematicGeneration += 1;
    this.driver?.cancelMotion();
    if (!this.snapshot.controlsLocked && this.cinematicEnd) {
      this.driver?.moveTo(this.cinematicEnd, 0);
      this.publish({ view: copyCameraView(this.cinematicEnd), cinematic: 'skipped' });
    } else this.publish({ cinematic: 'skipped' });
  }
}

export function createLabCameraController(
  options?: ConstructorParameters<typeof LabCameraController>[0],
): LabCameraController {
  return new LabCameraController(options);
}
