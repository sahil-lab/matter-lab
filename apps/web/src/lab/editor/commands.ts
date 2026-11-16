/**
 * Undoable editor commands (brief item 2: "multi-select, transform gizmos, rotate/move, delete,
 * duplicate, copy/paste, group/ungroup, lock/unlock, align and reset transforms, workstation
 * grouping"). Every command here:
 *  1. commits one `EditorPatch` against the local, undo-tracked `EditorSceneState`;
 *  2. translates that same patch into the equivalent `LabAction`(s) and dispatches them to
 *     `actionSink` (the authoritative reducer);
 *  3. rolls the local patch back if the reducer rejects it, so the two never drift apart.
 *
 * `undo()`/`redo()` reuse step 2/3 on the (already-inverted) patch `history.ts` hands back, so
 * undoing a placement also tells the reducer to forget it, and undoing a delete re-places the
 * exact instance that was removed — scene-graph undo/redo, never chemistry undo (see the role
 * brief: "treat undo/redo of a running experiment as reset/replay rather than magic inventory
 * reversal" — no command here ever touches `ContainerContents`).
 */
import { actionSink } from './actionSink';
import type { LabActionDispatchResult } from './actionSink';
import type { ApparatusInstance, ApparatusKind, Capability, Connection, ConnectionKind, LabAction, SocketRef, Transform, UUID } from './contracts';
import { newUUID } from './contracts';
import { labEditor, syncPickIndex } from './editorStore';
import { addVec3 } from './footprint';
import { recordEditorPatch, redoEditor, undoEditor } from './history';
import { applyEditorPatch, editEditorScene, invertEditorPatch } from './sceneEditor';
import type { EditorPatch, EditorSceneEditor } from './sceneEditor';
import type { Axis, Group, Vec3 } from './types';

function asActionPayload(payload: object): Record<string, unknown> {
  return payload as unknown as Record<string, unknown>;
}

function placeActionFor(instance: ApparatusInstance): LabAction {
  return {
    actionId: newUUID(),
    atSimulationS: 0,
    targetInstanceId: instance.id,
    type: 'PLACE',
    payload: asActionPayload({ kind: instance.kind, definitionId: instance.definitionId, transform: instance.transform, capabilities: instance.capabilities, stationId: instance.stationId, config: instance.config }),
  };
}

/** The `LabAction`s that keep the reducer in sync with one `EditorPatch` just applied to `EditorSceneState` (in either direction — undo hands back an already-inverted patch, so this one function covers do/undo/redo). Group/lock changes have no shared-contract equivalent and are intentionally not represented here. */
function labActionsForPatch(patch: EditorPatch): LabAction[] {
  const actions: LabAction[] = [];
  for (const instance of patch.apparatusRemoved) {
    actions.push({ actionId: newUUID(), atSimulationS: 0, targetInstanceId: instance.id, type: 'CUSTOM', payload: asActionPayload({ op: 'REMOVE' }) });
  }
  for (const instance of patch.apparatusAdded) {
    actions.push(placeActionFor(instance));
  }
  for (const change of patch.apparatusChanged) {
    actions.push({ actionId: newUUID(), atSimulationS: 0, targetInstanceId: change.after.id, type: 'MOVE', payload: asActionPayload({ transform: change.after.transform }) });
  }
  for (const connection of patch.connectionsRemoved) {
    actions.push({ actionId: newUUID(), atSimulationS: 0, targetInstanceId: connection.from.instanceId, type: 'DETACH', payload: asActionPayload({ connectionId: connection.id }) });
  }
  for (const connection of patch.connectionsAdded) {
    actions.push({ actionId: newUUID(), atSimulationS: 0, targetInstanceId: connection.from.instanceId, type: 'ATTACH', payload: asActionPayload({ connectionId: connection.id, from: connection.from, to: connection.to, kind: connection.kind }) });
  }
  return actions;
}

function dispatchAll(actions: readonly LabAction[]): LabActionDispatchResult[] {
  return actions.map((action) => actionSink.dispatch(action));
}

function rollback(patch: EditorPatch): void {
  const { scene, history } = labEditor.get();
  const last = history.past[history.past.length - 1];
  if (last === patch) {
    labEditor.set({ scene: applyEditorPatch(scene, invertEditorPatch(patch)), history: { past: history.past.slice(0, -1), future: history.future } });
  }
  syncPickIndex(invertEditorPatch(patch));
  // Best-effort: ask the reducer to undo whatever subset it had actually accepted before the
  // rejection. Entries it never saw are harmlessly rejected in turn (unknown instance/connection).
  dispatchAll(labActionsForPatch(invertEditorPatch(patch)));
}

/** Commits one local edit and mirrors it to the reducer; rolls back (locally and on the reducer) if any resulting action is rejected. */
function commit(label: string, edit: (editor: EditorSceneEditor) => void): LabActionDispatchResult[] {
  const { scene, history } = labEditor.get();
  const { state, patch } = editEditorScene(scene, label, edit);
  if (state === scene) return [];
  labEditor.set({ scene: state, history: recordEditorPatch(history, patch) });
  syncPickIndex(patch);
  const results = dispatchAll(labActionsForPatch(patch));
  if (results.some((r) => !r.accepted)) rollback(patch);
  return results;
}

// ---------- placement / transform ----------

export interface PlaceParams {
  readonly definitionId: string;
  readonly kind: ApparatusKind;
  readonly transform: Transform;
  readonly capabilities: readonly Capability[];
  readonly stationId: UUID;
  readonly config?: Record<string, unknown>;
}

export function placeApparatus(params: PlaceParams): { instanceId: UUID; result: LabActionDispatchResult } {
  const instanceId = newUUID();
  const instance: ApparatusInstance = {
    id: instanceId,
    kind: params.kind,
    definitionId: params.definitionId,
    transform: params.transform,
    revision: 1,
    config: params.config ?? {},
    capabilities: params.capabilities,
    stationId: params.stationId,
  };
  const results = commit(`Place ${params.kind.toLowerCase()}`, (editor) => editor.placeApparatus(instance));
  return { instanceId, result: results[0] ?? { accepted: false, rejection: { code: 'NOTHING_CHANGED', message: 'Placement produced no change.' } } };
}

/** Moves one or more (unlocked) instances as a single undo step; dispatches one MOVE per instance. */
export function moveInstances(moves: readonly { id: UUID; transform: Transform }[], label = 'Move'): LabActionDispatchResult[] {
  const locked = labEditor.get().scene.locked;
  const movable = moves.filter((m) => !locked.has(m.id));
  if (movable.length === 0) return [];
  return commit(label, (editor) => {
    for (const move of movable) editor.updateApparatus(move.id, { transform: move.transform });
  });
}

export function moveApparatus(id: UUID, transform: Transform, label = 'Move'): LabActionDispatchResult {
  return moveInstances([{ id, transform }], label)[0] ?? { accepted: true };
}

export function resetRotation(ids: readonly UUID[]): LabActionDispatchResult[] {
  const scene = labEditor.get().scene;
  const moves = ids
    .filter((id) => !scene.locked.has(id))
    .map((id) => scene.apparatus.get(id))
    .filter((i): i is ApparatusInstance => !!i)
    .map((i) => ({ id: i.id, transform: { positionM: i.transform.positionM, quaternion: [0, 0, 0, 1] as const } }));
  return moveInstances(moves, 'Reset rotation');
}

export function alignInstances(ids: readonly UUID[], axis: Axis, mode: 'min' | 'center' | 'max' = 'center'): LabActionDispatchResult[] {
  const scene = labEditor.get().scene;
  const axisIndex = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  const instances = ids.map((id) => scene.apparatus.get(id)).filter((i): i is ApparatusInstance => !!i && !scene.locked.has(i.id));
  if (instances.length < 2) return [];
  const values = instances.map((i) => i.transform.positionM[axisIndex]);
  const target = mode === 'min' ? Math.min(...values) : mode === 'max' ? Math.max(...values) : values.reduce((a, b) => a + b, 0) / values.length;
  const moves = instances.map((i) => {
    const positionM = [...i.transform.positionM] as [number, number, number];
    positionM[axisIndex] = target;
    return { id: i.id, transform: { positionM, quaternion: i.transform.quaternion } };
  });
  return moveInstances(moves, `Align ${axis.toUpperCase()}`);
}

// ---------- connections ----------

export function attachConnection(from: SocketRef, to: SocketRef, kind: ConnectionKind): { connectionId: UUID; result: LabActionDispatchResult } {
  const connectionId = newUUID();
  const connection: Connection = { id: connectionId, from, to, kind, enabled: true };
  const results = commit('Connect', (editor) => editor.addConnection(connection));
  return { connectionId, result: results[0] ?? { accepted: false, rejection: { code: 'NOTHING_CHANGED', message: 'Connection produced no change.' } } };
}

export function detachConnection(connectionId: UUID): LabActionDispatchResult {
  const results = commit('Disconnect', (editor) => editor.removeConnection(connectionId));
  return results[0] ?? { accepted: true };
}

// ---------- delete / duplicate / copy / paste ----------

export function removeInstances(ids: readonly UUID[]): LabActionDispatchResult[] {
  const locked = labEditor.get().scene.locked;
  const removable = ids.filter((id) => !locked.has(id) && labEditor.get().scene.apparatus.has(id));
  if (removable.length === 0) return [];
  return commit(removable.length > 1 ? `Delete ${removable.length} instruments` : 'Delete', (editor) => {
    for (const id of removable) editor.removeApparatus(id);
  });
}

const DEFAULT_DUPLICATE_OFFSET: Vec3 = [0.08, 0, 0.08];

function cloneWithOffset(instance: ApparatusInstance, offset: Vec3, stationId = instance.stationId): ApparatusInstance {
  return {
    ...instance,
    id: newUUID(),
    transform: { positionM: addVec3(instance.transform.positionM, offset), quaternion: instance.transform.quaternion },
    revision: 1,
    stationId,
  };
}

/** Duplicates the named instances (same station), offsetting the copies so they do not land exactly on the originals. Chemical inventory is never copied — a duplicate starts empty, like a freshly placed instrument. */
export function duplicateInstances(ids: readonly UUID[], offset: Vec3 = DEFAULT_DUPLICATE_OFFSET): UUID[] {
  const scene = labEditor.get().scene;
  const originals = ids.map((id) => scene.apparatus.get(id)).filter((i): i is ApparatusInstance => !!i);
  if (originals.length === 0) return [];
  const copies = originals.map((i) => cloneWithOffset(i, offset));
  commit(originals.length > 1 ? `Duplicate ${originals.length} instruments` : 'Duplicate', (editor) => {
    for (const copy of copies) editor.placeApparatus(copy);
  });
  return copies.map((c) => c.id);
}

export function copyInstances(ids: readonly UUID[]): void {
  const scene = labEditor.get().scene;
  const instances = ids.map((id) => scene.apparatus.get(id)).filter((i): i is ApparatusInstance => !!i);
  labEditor.set({ clipboard: instances });
}

export function pasteClipboard(offset: Vec3 = DEFAULT_DUPLICATE_OFFSET): UUID[] {
  const clipboard = labEditor.get().clipboard;
  if (clipboard.length === 0) return [];
  const copies = clipboard.map((i) => cloneWithOffset(i, offset));
  commit(copies.length > 1 ? `Paste ${copies.length} instruments` : 'Paste', (editor) => {
    for (const copy of copies) editor.placeApparatus(copy);
  });
  return copies.map((c) => c.id);
}

/** Duplicates an entire station as a new, independently editable and independently runnable station (apparatus + connection graph only — see `duplicateInstances`). */
export function duplicateStation(stationId: UUID, newName: string, offset: Vec3 = [1, 0, 0]): UUID {
  const scene = labEditor.get().scene;
  const originals = [...scene.apparatus.values()].filter((i) => i.stationId === stationId);
  const newStationId = newUUID();
  labEditor.set((s) => ({ stations: [...s.stations, { id: newStationId, name: newName }] }));
  if (originals.length === 0) return newStationId;

  const idMap = new Map<UUID, UUID>();
  const copies = originals.map((i) => {
    const copy = cloneWithOffset(i, offset, newStationId);
    idMap.set(i.id, copy.id);
    return copy;
  });
  const originalIds = new Set(originals.map((i) => i.id));
  const connections = [...scene.connections.values()].filter((c) => originalIds.has(c.from.instanceId) && originalIds.has(c.to.instanceId));

  commit(`Duplicate station "${newName}"`, (editor) => {
    for (const copy of copies) editor.placeApparatus(copy);
    for (const connection of connections) {
      editor.addConnection({
        id: newUUID(),
        from: { instanceId: idMap.get(connection.from.instanceId)!, socketId: connection.from.socketId },
        to: { instanceId: idMap.get(connection.to.instanceId)!, socketId: connection.to.socketId },
        kind: connection.kind,
        enabled: connection.enabled,
      });
    }
  });
  return newStationId;
}

// ---------- groups / locks ----------

export function groupInstances(ids: readonly UUID[], name = 'Group'): UUID | null {
  if (ids.length < 2) return null;
  const groupId = newUUID();
  const group: Group = { id: groupId, name, memberIds: ids };
  labEditor.set((s) => ({ scene: { ...s.scene, groups: new Map(s.scene.groups).set(groupId, group) } }));
  return groupId;
}

export function ungroup(groupId: UUID): void {
  labEditor.set((s) => {
    const groups = new Map(s.scene.groups);
    groups.delete(groupId);
    return { scene: { ...s.scene, groups } };
  });
}

export function setLocked(ids: readonly UUID[], locked: boolean): void {
  labEditor.set((s) => {
    const next = new Set(s.scene.locked);
    for (const id of ids) {
      if (locked) next.add(id);
      else next.delete(id);
    }
    return { scene: { ...s.scene, locked: next } };
  });
}

// ---------- undo / redo ----------

export function undo(): void {
  const { scene, history } = labEditor.get();
  const step = undoEditor(scene, history);
  if (!step) return;
  labEditor.set({ scene: step.state, history: step.history });
  syncPickIndex(step.applied);
  const results = dispatchAll(labActionsForPatch(step.applied));
  for (const r of results) if (!r.accepted) console.warn('[lab editor] undo did not fully sync to the reducer:', r.rejection); // eslint-disable-line no-console
}

export function redo(): void {
  const { scene, history } = labEditor.get();
  const step = redoEditor(scene, history);
  if (!step) return;
  labEditor.set({ scene: step.state, history: step.history });
  syncPickIndex(step.applied);
  const results = dispatchAll(labActionsForPatch(step.applied));
  for (const r of results) if (!r.accepted) console.warn('[lab editor] redo did not fully sync to the reducer:', r.rejection); // eslint-disable-line no-console
}

export function canUndo(): boolean {
  return labEditor.get().history.past.length > 0;
}

export function canRedo(): boolean {
  return labEditor.get().history.future.length > 0;
}
