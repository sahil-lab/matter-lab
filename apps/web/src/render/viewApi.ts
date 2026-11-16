import type { AtomId, Vec3 } from '@matterlab/core';
import type { CameraPose } from '../state/store';

export type StandardView = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso';

/**
 * The angle that points the same way as `wanted` (it differs from it by whole turns) and lies
 * nearest to `current`. A camera that has been orbited several times round then turns to a given
 * direction by the short way instead of unwinding every turn it has made.
 */
export function nearestTurn(current: number, wanted: number): number {
  const turn = 2 * Math.PI;
  return wanted + turn * Math.round((current - wanted) / turn);
}

/**
 * Everything the rest of the app may ask of the 3D view. The camera rig installs the real
 * implementation when the canvas mounts; until then the calls are harmless no-ops, so UI code and
 * actions never have to check whether the view exists yet.
 */
export interface ViewApi {
  fitAll(animate?: boolean): void;
  focusAtoms(ids: Iterable<AtomId>, animate?: boolean): void;
  setStandardView(view: StandardView): void;
  /** Back to the view a scene opens with: the opening direction, with everything in view. */
  resetView(animate?: boolean): void;
  zoomBy(factor: number): void;
  getPose(): CameraPose | null;
  setPose(pose: CameraPose, animate?: boolean): void;
  /** Unit vectors of the camera frame in world space. */
  getBasis(): { right: Vec3; up: Vec3; forward: Vec3 } | null;
  /** The point the camera orbits around. */
  getTarget(): Vec3 | null;
  /** Renders the current view and returns it as a PNG data URL, at most `maxWidth` pixels wide. */
  capture(maxWidth?: number): Promise<string | null>;
  /** Asks for one more frame; needed because the view only renders when something changes. */
  redraw(): void;
  /** Where a world-space point appears in the view, in CSS pixels from its top-left corner; `null` if it is not in front of the camera. */
  project(point: Vec3): [x: number, y: number] | null;
}

const idle: ViewApi = {
  fitAll: () => {},
  focusAtoms: () => {},
  setStandardView: () => {},
  resetView: () => {},
  zoomBy: () => {},
  getPose: () => null,
  setPose: () => {},
  getBasis: () => null,
  getTarget: () => null,
  capture: async () => null,
  redraw: () => {},
  project: () => null,
};

let current: ViewApi = idle;

export const viewApi: ViewApi = {
  fitAll: (animate) => current.fitAll(animate),
  focusAtoms: (ids, animate) => current.focusAtoms(ids, animate),
  setStandardView: (view) => current.setStandardView(view),
  resetView: (animate) => current.resetView(animate),
  zoomBy: (factor) => current.zoomBy(factor),
  getPose: () => current.getPose(),
  setPose: (pose, animate) => current.setPose(pose, animate),
  getBasis: () => current.getBasis(),
  getTarget: () => current.getTarget(),
  capture: (maxWidth) => current.capture(maxWidth),
  redraw: () => current.redraw(),
  project: (point) => current.project(point),
};

export function installViewApi(impl: ViewApi): () => void {
  current = impl;
  return () => {
    if (current === impl) current = idle;
  };
}

/**
 * What a computed result may put on the stage without touching the document: positions for an
 * animation (an optimiser's path), a ghost of another geometry to compare with, and computed
 * fields as surfaces, dot clouds and a cutting plane.
 */
export interface StageApi {
  /** Shows atoms at other positions than the scene's; `null` returns to the scene. */
  setTransient(positions: ReadonlyMap<AtomId, Vec3> | null): void;
  /** Draws a thin outline of a second geometry (bonds as lines, atoms as points); `null` removes it. */
  setGhost(ghost: GhostGeometry | null): void;
  /** Replaces the surfaces on stage. A surface whose arrays are the same objects as before is not uploaded again. */
  setSurfaces(surfaces: readonly StageSurface[]): void;
  setSlice(slice: StageSlice | null): void;
  setCloud(cloud: StageCloud | null): void;
  /** Removes the part of every surface on the side the normal points to; `null` shows them whole. */
  setCut(cut: StageCut | null): void;
}

export interface GhostGeometry {
  /** xyz triples in angstrom. */
  readonly positions: Float32Array;
  /** Pairs of indices into `positions`. */
  readonly bonds: Uint32Array;
}

/** A triangle mesh in scene coordinates (angstrom). */
export interface StageSurface {
  readonly id: string;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  /** CSS colour of the whole surface; not used where `colors` is given. */
  readonly color: string;
  /** One linear-light RGB triple per vertex. */
  readonly colors?: Float32Array;
  /** 0..1 */
  readonly opacity: number;
  /** `glass` for shells that should show what is inside; `matte` where the colour carries a value. */
  readonly finish: 'glass' | 'matte';
}

/** A rectangle in space showing a field through a colour scale. */
export interface StageSlice {
  readonly center: Vec3;
  /** Unit vectors along the rectangle's width and height. */
  readonly u: Vec3;
  readonly v: Vec3;
  readonly width: number;
  readonly height: number;
  /** Position on the colour scale (0..1) at each sample; sample (c, r) is `positions[c + columns * r]`. */
  readonly positions: Float32Array;
  readonly columns: number;
  readonly rows: number;
  /** The scale as 256 RGBA texels. */
  readonly scale: Uint8Array;
  /** Where on the scale the field is zero or negligible: 0.5 for a diverging scale, 0 for a sequential one. */
  readonly neutral: number;
  /** Contour lines between the neutral point and each end of the scale; 0 draws none. */
  readonly contours: number;
}

/** Dots in space, each standing for the same share of a density. */
export interface StageCloud {
  /** xyz triples in angstrom. */
  readonly positions: Float32Array;
  /** +1 or -1 per dot, selecting one of the two colours; all positive when omitted. */
  readonly signs?: Int8Array;
  readonly colorPositive: string;
  readonly colorNegative: string;
  /** Diameter of a dot in angstrom. */
  readonly size: number;
  readonly opacity: number;
}

export interface StageCut {
  /** Unit normal; the side it points to is removed. */
  readonly normal: Vec3;
  /** A point on the plane. */
  readonly point: Vec3;
}

const idleStage: StageApi = { setTransient: () => {}, setGhost: () => {}, setSurfaces: () => {}, setSlice: () => {}, setCloud: () => {}, setCut: () => {} };
let stage: StageApi = idleStage;

/** What was last asked for, so a view that mounts later (a new canvas after a quality change) shows it too. */
const requested: { surfaces: readonly StageSurface[]; slice: StageSlice | null; cloud: StageCloud | null; cut: StageCut | null; ghost: GhostGeometry | null } = {
  surfaces: [],
  slice: null,
  cloud: null,
  cut: null,
  ghost: null,
};

export const stageApi: StageApi = {
  setTransient: (positions) => stage.setTransient(positions),
  setGhost: (ghost) => {
    requested.ghost = ghost;
    stage.setGhost(ghost);
  },
  setSurfaces: (surfaces) => {
    requested.surfaces = surfaces;
    stage.setSurfaces(surfaces);
  },
  setSlice: (slice) => {
    requested.slice = slice;
    stage.setSlice(slice);
  },
  setCloud: (cloud) => {
    requested.cloud = cloud;
    stage.setCloud(cloud);
  },
  setCut: (cut) => {
    requested.cut = cut;
    stage.setCut(cut);
  },
};

export function installStageApi(impl: StageApi): () => void {
  stage = impl;
  impl.setGhost(requested.ghost);
  impl.setSurfaces(requested.surfaces);
  impl.setSlice(requested.slice);
  impl.setCloud(requested.cloud);
  impl.setCut(requested.cut);
  return () => {
    if (stage === impl) stage = idleStage;
  };
}

/** What is on stage besides the structure, for tests and diagnostics. */
export function stageContents(): { surfaces: readonly StageSurface[]; slice: StageSlice | null; cloud: StageCloud | null; cut: StageCut | null; ghost: GhostGeometry | null } {
  return { surfaces: requested.surfaces, slice: requested.slice, cloud: requested.cloud, cut: requested.cut, ghost: requested.ghost };
}

/** Per-frame view facts for DOM widgets that track the camera (axis gizmo, scale bar). */
export interface ViewFrame {
  /** Camera rotation as a row-major 3x3 world-to-view matrix. */
  readonly rotation: readonly number[];
  /** Angstrom per CSS pixel at the depth of the orbit target. */
  readonly angstromPerPixel: number;
  readonly orthographic: boolean;
}

type FrameListener = (frame: ViewFrame) => void;
const frameListeners = new Set<FrameListener>();
let lastFrame: ViewFrame | null = null;

export function publishViewFrame(frame: ViewFrame): void {
  lastFrame = frame;
  for (const listener of frameListeners) listener(frame);
}

export function subscribeViewFrame(listener: FrameListener): () => void {
  frameListeners.add(listener);
  if (lastFrame) listener(lastFrame);
  return () => frameListeners.delete(listener);
}
