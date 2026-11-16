/**
 * Serialization for editor-only scene aspects (brief item 7), plus the optimistic-concurrency
 * check the shared contract's `PATCH /api/v1/lab/scenes/{id}` calls for ("If-Match revision
 * required"). Persistence itself (`GET`/`POST`/`PATCH .../scenes`) is Agent 09's surface and does
 * not exist in this worktree; `saveSessionToLocalStorage`/`loadSessionFromLocalStorage` are a
 * clearly provisional stand-in so "save, reopen, replay" (Section 6 step 7) is demonstrable end to
 * end, and are the only two functions here that touch a browser API. Everything else is pure and
 * unit-tested without a DOM.
 *
 * What is serialized here is deliberately only placement/connections/groups/locks — the
 * `ExperimentScene` (chemistry truth) is captured separately, via whatever `exportScene`-shaped
 * function the caller supplies (currently the provisional `LabReducer`), so this module never has
 * to import Agent 07's reducer to do its job.
 */
import type { ApparatusInstance, Connection, ExperimentScene, Station, UUID } from './contracts';
import type { EditorSceneState, Group } from './types';

export interface SerializedEditorScene {
  readonly schemaVersion: 1;
  readonly apparatus: readonly ApparatusInstance[];
  readonly connections: readonly Connection[];
  readonly groups: readonly Group[];
  readonly locked: readonly UUID[];
  readonly nextRevision: number;
}

export function serializeEditorScene(scene: EditorSceneState): SerializedEditorScene {
  return {
    schemaVersion: 1,
    apparatus: [...scene.apparatus.values()],
    connections: [...scene.connections.values()],
    groups: [...scene.groups.values()],
    locked: [...scene.locked],
    nextRevision: scene.nextRevision,
  };
}

export function deserializeEditorScene(data: SerializedEditorScene): EditorSceneState {
  return {
    apparatus: new Map(data.apparatus.map((a) => [a.id, a])),
    connections: new Map(data.connections.map((c) => [c.id, c])),
    groups: new Map(data.groups.map((g) => [g.id, g])),
    locked: new Set(data.locked),
    nextRevision: data.nextRevision,
  };
}

export interface SavedLabSession {
  readonly schemaVersion: 1;
  readonly savedAt: string;
  readonly editor: SerializedEditorScene;
  /** `null` when no authoritative reducer was installed at save time (e.g. a unit test), not when the experiment is merely empty. */
  readonly experiment: ExperimentScene | null;
  readonly stations: readonly Station[];
  readonly activeStationId: UUID;
}

export function buildSavedSession(scene: EditorSceneState, stations: readonly Station[], activeStationId: UUID, experiment: ExperimentScene | null): SavedLabSession {
  return { schemaVersion: 1, savedAt: new Date().toISOString(), editor: serializeEditorScene(scene), experiment, stations, activeStationId };
}

export interface RestoredLabSession {
  readonly scene: EditorSceneState;
  readonly stations: readonly Station[];
  readonly activeStationId: UUID;
  readonly experiment: ExperimentScene | null;
}

export function restoreSavedSession(session: SavedLabSession): RestoredLabSession {
  return {
    scene: deserializeEditorScene(session.editor),
    stations: session.stations,
    activeStationId: session.activeStationId,
    experiment: session.experiment,
  };
}

export interface RevisionConflict {
  readonly code: 'REVISION_CONFLICT';
  readonly message: string;
  readonly storedRevision: number;
  readonly baseRevision: number;
}

/**
 * Mirrors the shared API's `If-Match` check: a save started from `baseRevision` (the revision last
 * loaded or saved) is only safe to apply if the currently stored scene is still at that revision.
 * Returns `null` when it is safe, or a conflict describing what moved underneath the save.
 */
export function checkRevision(storedRevision: number, baseRevision: number): RevisionConflict | null {
  if (storedRevision === baseRevision) return null;
  return {
    code: 'REVISION_CONFLICT',
    message: `The saved scene is at revision ${storedRevision}, but this save was based on revision ${baseRevision}. Reload before saving again.`,
    storedRevision,
    baseRevision,
  };
}

const STORAGE_KEY_PREFIX = 'matterlab.lab.session.';

function hasLocalStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
}

/** Provisional stand-in for Agent 09's `POST/PATCH /api/v1/lab/scenes/{id}`; one browser tab, no server round-trip. */
export function saveSessionToLocalStorage(key: string, session: SavedLabSession): void {
  if (!hasLocalStorage()) throw new Error('No storage is available to save to.');
  localStorage.setItem(STORAGE_KEY_PREFIX + key, JSON.stringify(session));
}

/** Provisional stand-in for Agent 09's `GET /api/v1/lab/scenes/{id}`. */
export function loadSessionFromLocalStorage(key: string): SavedLabSession | null {
  if (!hasLocalStorage()) return null;
  const raw = localStorage.getItem(STORAGE_KEY_PREFIX + key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SavedLabSession;
  } catch {
    return null;
  }
}

export function listSavedSessionKeys(): string[] {
  if (!hasLocalStorage()) return [];
  const keys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(STORAGE_KEY_PREFIX)) keys.push(key.slice(STORAGE_KEY_PREFIX.length));
  }
  return keys;
}
