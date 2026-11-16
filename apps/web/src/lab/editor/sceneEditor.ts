/**
 * The editor's own invertible-patch editing model for `EditorSceneState` (apparatus placement,
 * connections, groups, locks) — deliberately mirroring `packages/core/src/scene/editor.ts`
 * (`SceneEditor`/`editScene`/`ScenePatch`) so the lab editor's undo/redo behaves exactly like the
 * molecule editor's: every change is collected against a scratch copy and committed as one
 * reversible `EditorPatch`, never a whole-state snapshot.
 *
 * This is **editor-local** state only (see `00_SHARED_INTEGRATION_CONTRACT.md` Section 4 and the
 * brief's non-negotiable): it never holds `ContainerContents` / species inventory. Placement and
 * connection commands apply here *and* are mirrored to the authoritative reducer through
 * `actionSink`; if the reducer rejects an action, the caller undoes the local patch it just made
 * (see `commands.ts`).
 */
import type { ApparatusInstance, Connection, UUID } from './contracts';
import type { EditorSceneState, Group } from './types';

export interface EditorPatch {
  readonly label: string;
  readonly apparatusAdded: readonly ApparatusInstance[];
  readonly apparatusRemoved: readonly ApparatusInstance[];
  readonly apparatusChanged: readonly { readonly before: ApparatusInstance; readonly after: ApparatusInstance }[];
  readonly connectionsAdded: readonly Connection[];
  readonly connectionsRemoved: readonly Connection[];
  readonly groupsAdded: readonly Group[];
  readonly groupsRemoved: readonly Group[];
  readonly groupsChanged: readonly { readonly before: Group; readonly after: Group }[];
  readonly lockedAdded: readonly UUID[];
  readonly lockedRemoved: readonly UUID[];
}

function sameApparatus(a: ApparatusInstance, b: ApparatusInstance): boolean {
  return (
    a.revision === b.revision &&
    a.transform.positionM[0] === b.transform.positionM[0] &&
    a.transform.positionM[1] === b.transform.positionM[1] &&
    a.transform.positionM[2] === b.transform.positionM[2] &&
    a.transform.quaternion[0] === b.transform.quaternion[0] &&
    a.transform.quaternion[1] === b.transform.quaternion[1] &&
    a.transform.quaternion[2] === b.transform.quaternion[2] &&
    a.transform.quaternion[3] === b.transform.quaternion[3] &&
    a.stationId === b.stationId &&
    JSON.stringify(a.config) === JSON.stringify(b.config)
  );
}

function sameGroup(a: Group, b: Group): boolean {
  return a.name === b.name && a.memberIds.length === b.memberIds.length && a.memberIds.every((id, i) => id === b.memberIds[i]);
}

/** True when a patch changes nothing at all; such a patch is never recorded in history. */
export function isEmptyEditorPatch(patch: EditorPatch): boolean {
  return (
    patch.apparatusAdded.length === 0 &&
    patch.apparatusRemoved.length === 0 &&
    patch.apparatusChanged.length === 0 &&
    patch.connectionsAdded.length === 0 &&
    patch.connectionsRemoved.length === 0 &&
    patch.groupsAdded.length === 0 &&
    patch.groupsRemoved.length === 0 &&
    patch.groupsChanged.length === 0 &&
    patch.lockedAdded.length === 0 &&
    patch.lockedRemoved.length === 0
  );
}

/**
 * Collects any number of changes against an `EditorSceneState` and turns them into one new state
 * plus one reversible patch. Nothing is visible to callers until `commit` runs.
 */
export class EditorSceneEditor {
  private apparatus: ReadonlyMap<UUID, ApparatusInstance>;
  private connections: ReadonlyMap<UUID, Connection>;
  private groups: ReadonlyMap<UUID, Group>;
  private locked: ReadonlySet<UUID>;
  private ownApparatus: Map<UUID, ApparatusInstance> | null = null;
  private ownConnections: Map<UUID, Connection> | null = null;
  private ownGroups: Map<UUID, Group> | null = null;
  private ownLocked: Set<UUID> | null = null;
  private readonly touchedApparatus = new Set<UUID>();
  private readonly touchedConnections = new Set<UUID>();
  private readonly touchedGroups = new Set<UUID>();
  private readonly touchedLocks = new Set<UUID>();

  constructor(private readonly base: EditorSceneState) {
    this.apparatus = base.apparatus;
    this.connections = base.connections;
    this.groups = base.groups;
    this.locked = base.locked;
  }

  private writableApparatus(): Map<UUID, ApparatusInstance> {
    if (!this.ownApparatus) {
      this.ownApparatus = new Map(this.base.apparatus);
      this.apparatus = this.ownApparatus;
    }
    return this.ownApparatus;
  }

  private writableConnections(): Map<UUID, Connection> {
    if (!this.ownConnections) {
      this.ownConnections = new Map(this.base.connections);
      this.connections = this.ownConnections;
    }
    return this.ownConnections;
  }

  private writableGroups(): Map<UUID, Group> {
    if (!this.ownGroups) {
      this.ownGroups = new Map(this.base.groups);
      this.groups = this.ownGroups;
    }
    return this.ownGroups;
  }

  private writableLocked(): Set<UUID> {
    if (!this.ownLocked) {
      this.ownLocked = new Set(this.base.locked);
      this.locked = this.ownLocked;
    }
    return this.ownLocked;
  }

  hasApparatus(id: UUID): boolean {
    return this.apparatus.has(id);
  }

  getApparatus(id: UUID): ApparatusInstance {
    const instance = this.apparatus.get(id);
    if (!instance) throw new Error(`Apparatus ${id} does not exist.`);
    return instance;
  }

  allApparatus(): IterableIterator<ApparatusInstance> {
    return this.apparatus.values();
  }

  allConnections(): IterableIterator<Connection> {
    return this.connections.values();
  }

  isLocked(id: UUID): boolean {
    return this.locked.has(id);
  }

  placeApparatus(instance: ApparatusInstance): void {
    if (this.apparatus.has(instance.id)) throw new Error(`Apparatus ${instance.id} already exists.`);
    this.writableApparatus().set(instance.id, instance);
    this.touchedApparatus.add(instance.id);
  }

  updateApparatus(id: UUID, changes: Partial<Pick<ApparatusInstance, 'transform' | 'revision' | 'config' | 'stationId'>>): void {
    const current = this.getApparatus(id);
    const next: ApparatusInstance = { ...current, ...changes, id };
    if (sameApparatus(current, next)) return;
    this.writableApparatus().set(id, next);
    this.touchedApparatus.add(id);
  }

  removeApparatus(id: UUID): void {
    this.getApparatus(id);
    // Dangling connections referencing a removed instance are removed too, so the graph never
    // points at an instance that no longer exists.
    for (const connection of [...this.connections.values()]) {
      if (connection.from.instanceId === id || connection.to.instanceId === id) this.removeConnection(connection.id);
    }
    for (const group of [...this.groups.values()]) {
      if (group.memberIds.includes(id)) this.updateGroup(group.id, group.memberIds.filter((m) => m !== id));
    }
    this.writableApparatus().delete(id);
    this.touchedApparatus.add(id);
    if (this.locked.has(id)) {
      this.writableLocked().delete(id);
      this.touchedLocks.add(id);
    }
  }

  addConnection(connection: Connection): void {
    if (this.connections.has(connection.id)) throw new Error(`Connection ${connection.id} already exists.`);
    this.writableConnections().set(connection.id, connection);
    this.touchedConnections.add(connection.id);
  }

  removeConnection(id: UUID): void {
    if (!this.connections.has(id)) return;
    this.writableConnections().delete(id);
    this.touchedConnections.add(id);
  }

  addGroup(group: Group): void {
    if (this.groups.has(group.id)) throw new Error(`Group ${group.id} already exists.`);
    this.writableGroups().set(group.id, group);
    this.touchedGroups.add(group.id);
  }

  updateGroup(id: UUID, memberIds: readonly UUID[]): void {
    const current = this.groups.get(id);
    if (!current) throw new Error(`Group ${id} does not exist.`);
    const next: Group = { ...current, memberIds };
    if (sameGroup(current, next)) return;
    this.writableGroups().set(id, next);
    this.touchedGroups.add(id);
  }

  removeGroup(id: UUID): void {
    if (!this.groups.has(id)) return;
    this.writableGroups().delete(id);
    this.touchedGroups.add(id);
  }

  setLocked(id: UUID, locked: boolean): void {
    this.getApparatus(id);
    const was = this.locked.has(id);
    if (was === locked) return;
    const set = this.writableLocked();
    if (locked) set.add(id);
    else set.delete(id);
    this.touchedLocks.add(id);
  }

  /** The state as it currently stands inside this editor, for code that needs read-only queries mid-edit. */
  snapshot(): EditorSceneState {
    return { apparatus: this.apparatus, connections: this.connections, groups: this.groups, locked: this.locked, nextRevision: this.base.nextRevision };
  }

  commit(label: string): { state: EditorSceneState; patch: EditorPatch } {
    const apparatusAdded: ApparatusInstance[] = [];
    const apparatusRemoved: ApparatusInstance[] = [];
    const apparatusChanged: { before: ApparatusInstance; after: ApparatusInstance }[] = [];
    for (const id of this.touchedApparatus) {
      const before = this.base.apparatus.get(id);
      const after = this.apparatus.get(id);
      if (before && after) {
        if (!sameApparatus(before, after)) apparatusChanged.push({ before, after });
      } else if (after) apparatusAdded.push(after);
      else if (before) apparatusRemoved.push(before);
    }

    const connectionsAdded: Connection[] = [];
    const connectionsRemoved: Connection[] = [];
    for (const id of this.touchedConnections) {
      const before = this.base.connections.get(id);
      const after = this.connections.get(id);
      if (after && !before) connectionsAdded.push(after);
      else if (before && !after) connectionsRemoved.push(before);
    }

    const groupsAdded: Group[] = [];
    const groupsRemoved: Group[] = [];
    const groupsChanged: { before: Group; after: Group }[] = [];
    for (const id of this.touchedGroups) {
      const before = this.base.groups.get(id);
      const after = this.groups.get(id);
      if (before && after) {
        if (!sameGroup(before, after)) groupsChanged.push({ before, after });
      } else if (after) groupsAdded.push(after);
      else if (before) groupsRemoved.push(before);
    }

    const lockedAdded: UUID[] = [];
    const lockedRemoved: UUID[] = [];
    for (const id of this.touchedLocks) {
      const was = this.base.locked.has(id);
      const is = this.locked.has(id);
      if (is && !was) lockedAdded.push(id);
      else if (was && !is) lockedRemoved.push(id);
    }

    const patch: EditorPatch = {
      label,
      apparatusAdded,
      apparatusRemoved,
      apparatusChanged,
      connectionsAdded,
      connectionsRemoved,
      groupsAdded,
      groupsRemoved,
      groupsChanged,
      lockedAdded,
      lockedRemoved,
    };

    if (isEmptyEditorPatch(patch)) return { state: this.base, patch };
    return { state: { ...this.snapshot(), nextRevision: this.base.nextRevision + 1 }, patch };
  }
}

/** Runs `fn` against an editor for `state` and commits the result as a single labelled edit. */
export function editEditorScene(
  state: EditorSceneState,
  label: string,
  fn: (editor: EditorSceneEditor) => void,
): { state: EditorSceneState; patch: EditorPatch } {
  const editor = new EditorSceneEditor(state);
  fn(editor);
  return editor.commit(label);
}

export function applyEditorPatch(state: EditorSceneState, patch: EditorPatch): EditorSceneState {
  if (isEmptyEditorPatch(patch)) return state;
  const apparatus = new Map(state.apparatus);
  const connections = new Map(state.connections);
  const groups = new Map(state.groups);
  const locked = new Set(state.locked);
  for (const instance of patch.apparatusRemoved) apparatus.delete(instance.id);
  for (const instance of patch.apparatusAdded) apparatus.set(instance.id, instance);
  for (const change of patch.apparatusChanged) apparatus.set(change.after.id, change.after);
  for (const connection of patch.connectionsRemoved) connections.delete(connection.id);
  for (const connection of patch.connectionsAdded) connections.set(connection.id, connection);
  for (const group of patch.groupsRemoved) groups.delete(group.id);
  for (const group of patch.groupsAdded) groups.set(group.id, group);
  for (const change of patch.groupsChanged) groups.set(change.after.id, change.after);
  for (const id of patch.lockedRemoved) locked.delete(id);
  for (const id of patch.lockedAdded) locked.add(id);
  return { apparatus, connections, groups, locked, nextRevision: state.nextRevision + 1 };
}

/** The patch that exactly undoes `patch`. */
export function invertEditorPatch(patch: EditorPatch): EditorPatch {
  return {
    label: patch.label,
    apparatusAdded: patch.apparatusRemoved,
    apparatusRemoved: patch.apparatusAdded,
    apparatusChanged: patch.apparatusChanged.map((c) => ({ before: c.after, after: c.before })),
    connectionsAdded: patch.connectionsRemoved,
    connectionsRemoved: patch.connectionsAdded,
    groupsAdded: patch.groupsRemoved,
    groupsRemoved: patch.groupsAdded,
    groupsChanged: patch.groupsChanged.map((c) => ({ before: c.after, after: c.before })),
    lockedAdded: patch.lockedRemoved,
    lockedRemoved: patch.lockedAdded,
  };
}
