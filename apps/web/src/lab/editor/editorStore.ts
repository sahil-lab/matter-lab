/**
 * The editor's own zustand store — mirrors `state/store.ts`'s shape (`useLab`/`lab`) so the two
 * editors feel the same to work on: one store holds the document (here, `EditorSceneState` +
 * undo history + selection), code outside React uses the imperative `labEditor` handle, and
 * everything else (render sync, gesture controller) subscribes to just the slice it needs.
 *
 * What this store does **not** hold: `ContainerContents` / species inventory (that is read through
 * `actionSink.getContainerStates()`, never copied in here) and GPU/render objects (those live in
 * the R3F components under `components/`, keyed off `scene.apparatus` the same way `SceneView`
 * keys instanced buffers off the molecule editor's `Scene`).
 */
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { footprintFor, getApparatusDefinition } from '../apparatus/catalog';
import type { ApparatusInstance, Station, UUID } from './contracts';
import { newUUID } from './contracts';
import { EMPTY_EDITOR_HISTORY } from './history';
import type { EditorHistory } from './history';
import type { EditorPatch } from './sceneEditor';
import { rebuildPickIndex, updatePickIndex } from './picking';
import type { PickCandidateSource } from './picking';
import { SpatialIndex } from './spatialIndex';
import { CAMERA_GESTURE, IDLE_GESTURE, emptyEditorScene } from './types';
import type { EditorSceneState, GestureMode, PlacementPreview } from './types';

export interface LabEditorState {
  scene: EditorSceneState;
  history: EditorHistory;
  /** The scene revision at the last successful save, for the same dirty-check pattern as `state/store.ts`'s `savedRevision`. */
  savedRevision: number;
  selection: ReadonlySet<UUID>;
  hoveredInstanceId: UUID | null;
  gesture: GestureMode;
  /** Live preview while placing from the palette or dragging an existing instance; `null` otherwise. */
  placementPreview: PlacementPreview | null;
  /** Editor-local copy/paste buffer: full instances with their transforms, pasted as fresh ids. */
  clipboard: readonly ApparatusInstance[];
  stations: readonly Station[];
  activeStationId: UUID;
}

/** Resolves footprints from the (provisional) apparatus catalog, for the spatial index and picking. */
export const catalogPickSource: PickCandidateSource = {
  getApparatus: () => undefined,
  getFootprint: (instance) => {
    const definition = getApparatusDefinition(instance.definitionId);
    return definition ? footprintFor(definition) : undefined;
  },
};

/** Kept outside the store (it is a mutable performance structure, not serializable document state) and updated incrementally from each committed patch — see `syncPickIndex`. */
export const pickIndex = new SpatialIndex<UUID>(0.5);

export function initialEditorState(): LabEditorState {
  const defaultStation: Station = { id: newUUID(), name: 'Station 1' };
  return {
    scene: emptyEditorScene(),
    history: EMPTY_EDITOR_HISTORY,
    savedRevision: 0,
    selection: new Set(),
    hoveredInstanceId: null,
    gesture: IDLE_GESTURE,
    placementPreview: null,
    clipboard: [],
    stations: [defaultStation],
    activeStationId: defaultStation.id,
  };
}

export const useLabEditor = create<LabEditorState>()(subscribeWithSelector(initialEditorState));

/** Imperative access for code outside React (gesture controller, render sync, keyboard handler). */
export const labEditor = {
  get: useLabEditor.getState,
  set: useLabEditor.setState,
  subscribe: useLabEditor.subscribe,
};

/** Updates `pickIndex` for exactly the instances a patch touched, instead of rebuilding it every frame. */
export function syncPickIndex(patch: EditorPatch): void {
  for (const instance of patch.apparatusRemoved) pickIndex.remove(instance.id);
  for (const instance of patch.apparatusAdded) updatePickIndex(pickIndex, instance, catalogPickSource);
  for (const change of patch.apparatusChanged) updatePickIndex(pickIndex, change.after, catalogPickSource);
}

/** Rebuilds the whole index, e.g. after loading a saved scene. */
export function rebuildPickIndexFromScene(scene: EditorSceneState): void {
  rebuildPickIndex(pickIndex, scene.apparatus.values(), catalogPickSource);
}

// ---------- small, non-undoable UI setters (selection, hover, gesture) ----------
// Scene-editing operations (place/move/duplicate/delete/group/...) live in commands.ts, since they
// go through the undo history and the action sink; these never do.

export function setSelection(ids: Iterable<UUID>): void {
  labEditor.set({ selection: new Set(ids) });
}

export function addToSelection(ids: Iterable<UUID>): void {
  labEditor.set((s) => {
    const next = new Set(s.selection);
    for (const id of ids) next.add(id);
    return { selection: next };
  });
}

export function toggleSelection(id: UUID): void {
  labEditor.set((s) => {
    const next = new Set(s.selection);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return { selection: next };
  });
}

export function clearSelection(): void {
  labEditor.set({ selection: new Set() });
}

export function setHovered(id: UUID | null): void {
  if (labEditor.get().hoveredInstanceId !== id) labEditor.set({ hoveredInstanceId: id });
}

export function setGesture(mode: GestureMode): void {
  labEditor.set({ gesture: mode });
}

export function setPlacementPreview(preview: PlacementPreview | null): void {
  labEditor.set({ placementPreview: preview });
}

/** True while an editing gesture (placing/dragging/gizmo/marquee/connecting/operating) owns the pointer, so the camera must not also react to it. */
export function isEditorGestureActive(): boolean {
  const gesture = labEditor.get().gesture;
  return gesture.kind !== 'idle' && gesture.kind !== 'camera';
}

export function endGesture(): void {
  labEditor.set({ gesture: labEditor.get().gesture.kind === 'camera' ? CAMERA_GESTURE : IDLE_GESTURE, placementPreview: null });
}

export function addStation(name: string): UUID {
  const station: Station = { id: newUUID(), name };
  labEditor.set((s) => ({ stations: [...s.stations, station] }));
  return station.id;
}

export function setActiveStation(id: UUID): void {
  if (labEditor.get().stations.some((s) => s.id === id)) labEditor.set({ activeStationId: id });
}

export function instanceAt(id: UUID): ApparatusInstance | undefined {
  return labEditor.get().scene.apparatus.get(id);
}
