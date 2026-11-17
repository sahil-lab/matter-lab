import { EMPTY_HISTORY, EMPTY_SCENE, exampleScene, findExample } from '@matterlab/core';
import type { AtomId, BondId, BondOrder, History, Scene, ScenePatch, Vec3 } from '@matterlab/core';
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

export type ToolId = 'select' | 'build' | 'erase' | 'measure';
/**
 * The part of the lab on screen. Architect is the editor; the others put their own, read-only
 * structures on the same 3D stage while the Architect's document waits untouched.
 */
export type Workspace = 'architect' | 'reactions' | 'vault';
export type RenderMode = 'ball-stick' | 'space-fill' | 'sticks' | 'wire' | 'skeletal';
export type QualityId = 'efficient' | 'balanced' | 'quality';
export type Projection = 'perspective' | 'orthographic';
export type LabelMode = 'none' | 'hetero' | 'all';
export type MeasureKind = 'distance' | 'angle' | 'dihedral';
/** Creative: build freely, caveats stay quiet. Physics: every structural problem is surfaced in the viewport. */
export type EditMode = 'creative' | 'physics';
export type InspectorTab = 'inspect' | 'explain' | 'measure' | 'compute';
export type DialogId = 'periodic-table' | 'library' | 'shortcuts' | 'export' | 'nucleus' | 'quantum-comparison' | null;
export type ExplainLevel = 'beginner' | 'advanced';
/** What the Explain tab is about: whatever is selected, or one of the calculations done on the structure. */
export type ExplainSubject = 'selection' | 'optimisation' | 'electrons';

export const MEASURE_ATOM_COUNT: Readonly<Record<MeasureKind, number>> = { distance: 2, angle: 3, dihedral: 4 };

export interface MeasurementDef {
  readonly id: string;
  readonly atoms: readonly AtomId[];
}

export interface CameraPose {
  readonly position: Vec3;
  readonly target: Vec3;
  /** Orthographic zoom (pixels per angstrom); ignored in perspective. */
  readonly zoom: number;
  readonly projection: Projection;
}

export interface CameraBookmark extends CameraPose {
  readonly id: string;
  readonly name: string;
}

export interface Toast {
  readonly id: number;
  readonly kind: 'info' | 'success' | 'warning' | 'error';
  readonly title: string;
  readonly detail?: string;
}

export interface ClipboardData {
  readonly atoms: ReadonlyArray<{ protons: number; neutrons: number | null; electrons: number; position: Vec3 }>;
  /** Indices into `atoms`. */
  readonly bonds: ReadonlyArray<{ a: number; b: number; order: BondOrder }>;
}

/** Everything that belongs to one document and its editing session. */
export interface DocumentSlice {
  projectId: string;
  projectName: string;
  scene: Scene;
  history: History;
  revision: number;
  savedRevision: number;
  lastPatch: ScenePatch | null;
  selectedAtoms: ReadonlySet<AtomId>;
  selectedBonds: ReadonlySet<BondId>;
  hoveredAtom: AtomId | null;
  hoveredBond: BondId | null;
  tool: ToolId;
  measurePicks: readonly AtomId[];
  measurements: readonly MeasurementDef[];
  bookmarks: readonly CameraBookmark[];
}

/** The Architect's document and camera, set aside while another workspace is on stage. */
export interface ParkedDocument {
  readonly document: DocumentSlice;
  readonly camera: CameraPose | null;
}

export interface LabState extends DocumentSlice {
  // Workspace
  workspace: Workspace;
  parked: ParkedDocument | null;

  // Document
  /** Increases with every scene change, including undo and redo. */
  revision: number;
  /** Revision at the last save, to tell whether there are unsaved changes. */
  savedRevision: number;
  /** The patch that produced the current scene, so the renderer can update incrementally; `null` after a wholesale replacement. */
  lastPatch: ScenePatch | null;

  // Tools
  buildElement: number;
  bondOrder: BondOrder;
  autoHydrogens: boolean;
  measureKind: MeasureKind;
  editMode: EditMode;

  // View
  renderMode: RenderMode;
  quality: QualityId;
  projection: Projection;
  labelMode: LabelMode;
  ambientMotion: boolean;
  showPerf: boolean;

  // Interface
  inspectorOpen: boolean;
  /** The left panel that the Reactions and Vault workspaces use for their set-up. */
  sidePanelOpen: boolean;
  inspectorTab: InspectorTab;
  explainLevel: ExplainLevel;
  explainSubject: ExplainSubject;
  dialog: DialogId;
  /** What choosing an element in the periodic table does: set the build element, or change the selected atoms. */
  elementPickerTarget: 'build' | 'selection';
  toasts: readonly Toast[];
  /** Status line of an in-progress keyboard transform (grab or rotate), or `null`. */
  transformHud: string | null;
  clipboard: ClipboardData | null;
}

export function pickDocument(s: DocumentSlice): DocumentSlice {
  return {
    projectId: s.projectId,
    projectName: s.projectName,
    scene: s.scene,
    history: s.history,
    revision: s.revision,
    savedRevision: s.savedRevision,
    lastPatch: s.lastPatch,
    selectedAtoms: s.selectedAtoms,
    selectedBonds: s.selectedBonds,
    hoveredAtom: s.hoveredAtom,
    hoveredBond: s.hoveredBond,
    tool: s.tool,
    measurePicks: s.measurePicks,
    measurements: s.measurements,
    bookmarks: s.bookmarks,
  };
}

/** The Architect's document, whichever workspace is on screen. */
export function architectDocument(s: LabState): DocumentSlice {
  return s.parked ? s.parked.document : s;
}

/** True when the structure on stage belongs to a workspace that only displays it. */
export function isReadOnly(s: LabState): boolean {
  return s.workspace !== 'architect';
}

export function newProjectId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const STARTER = findExample('caffeine');

export const DEFAULT_VIEW = {
  renderMode: 'ball-stick' as RenderMode,
  projection: 'perspective' as Projection,
  labelMode: 'none' as LabelMode,
};

export function initialState(): LabState {
  return {
    workspace: 'architect',
    parked: null,

    projectId: newProjectId(),
    projectName: STARTER ? STARTER.name : 'Untitled',
    scene: STARTER ? exampleScene(STARTER) : EMPTY_SCENE,
    history: EMPTY_HISTORY,
    revision: 0,
    savedRevision: 0,
    lastPatch: null,

    selectedAtoms: new Set(),
    selectedBonds: new Set(),
    hoveredAtom: null,
    hoveredBond: null,

    tool: 'select',
    buildElement: 6,
    bondOrder: 1,
    autoHydrogens: true,
    measureKind: 'distance',
    measurePicks: [],
    editMode: 'creative',

    ...DEFAULT_VIEW,
    quality: 'balanced',
    ambientMotion: false,
    showPerf: false,

    measurements: [],
    bookmarks: [],

    inspectorOpen: true,
    sidePanelOpen: true,
    inspectorTab: 'inspect',
    explainLevel: 'beginner',
    explainSubject: 'selection',
    dialog: null,
    elementPickerTarget: 'build',
    toasts: [],
    transformHud: null,
    clipboard: null,
  };
}

export const useLab = create<LabState>()(subscribeWithSelector(initialState));

/** Imperative access for code outside React (interaction controller, render sync, workers). */
export const lab = {
  get: useLab.getState,
  set: useLab.setState,
  subscribe: useLab.subscribe,
};

/** Set by the persistence layer: writes the Architect's session to storage straight away. */
export const sessionHooks: { flush: () => void } = { flush: () => {} };
