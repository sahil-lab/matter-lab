import { SceneFormatError, composition, deserializeScene, formatFormula, serializeScene } from '@matterlab/core';
import type { SerializedScene } from '@matterlab/core';
import { viewApi } from '../render/viewApi';
import { notify, replaceDocument } from './actions';
import { deleteOne, getAll, getOne, putOne } from './db';
import { DEFAULT_VIEW, architectDocument, lab, sessionHooks } from './store';
import type { CameraBookmark, CameraPose, ExplainLevel, LabelMode, Projection, QualityId, RenderMode } from './store';

export const PROJECT_FORMAT = 'matterlab.project';
export const PROJECT_VERSION = 1;
export const APP_VERSION = '0.1.0';

/** A saved project: the scene plus the annotations and view that go with it. */
export interface ProjectFile {
  readonly format: typeof PROJECT_FORMAT;
  readonly version: number;
  readonly app: { readonly name: 'MATTER LAB'; readonly version: string };
  readonly id: string;
  readonly name: string;
  readonly savedAt: string;
  readonly scene: SerializedScene;
  readonly measurements: ReadonlyArray<{ readonly atoms: readonly number[] }>;
  readonly bookmarks: readonly CameraBookmark[];
  readonly view: { readonly renderMode: RenderMode; readonly projection: Projection; readonly labelMode: LabelMode };
  readonly camera: CameraPose | null;
}

export function buildProjectFile(): ProjectFile {
  const s = lab.get();
  // The project is the Architect's document, also while another workspace is using the stage.
  const doc = architectDocument(s);
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    app: { name: 'MATTER LAB', version: APP_VERSION },
    id: doc.projectId,
    name: doc.projectName,
    savedAt: new Date().toISOString(),
    scene: serializeScene(doc.scene),
    measurements: doc.measurements.map((m) => ({ atoms: [...m.atoms] })),
    bookmarks: doc.bookmarks,
    view: { renderMode: s.renderMode, projection: s.projection, labelMode: s.labelMode },
    camera: s.parked ? s.parked.camera : viewApi.getPose(),
  };
}

const RENDER_MODES: readonly RenderMode[] = ['ball-stick', 'space-fill', 'sticks', 'wire', 'skeletal'];
const LABEL_MODES: readonly LabelMode[] = ['none', 'hetero', 'all'];

function isPose(value: unknown): value is CameraPose {
  const v = value as CameraPose | null;
  const triple = (t: unknown) => Array.isArray(t) && t.length === 3 && t.every((n) => typeof n === 'number' && Number.isFinite(n));
  return !!v && triple(v.position) && triple(v.target) && typeof v.zoom === 'number' && (v.projection === 'perspective' || v.projection === 'orthographic');
}

/**
 * Opens a project file. The scene is validated strictly; view settings and annotations are
 * optional extras that are restored when well-formed and otherwise ignored.
 */
export function openProjectFile(data: unknown): void {
  if (typeof data !== 'object' || data === null) throw new SceneFormatError('The file does not contain a project.');
  const file = data as Partial<ProjectFile>;
  if (file.format !== PROJECT_FORMAT) throw new SceneFormatError('This is not a MATTER LAB project file.');
  if (typeof file.version !== 'number' || file.version > PROJECT_VERSION) {
    throw new SceneFormatError('This project was saved by a newer version of MATTER LAB.');
  }
  const scene = deserializeScene(file.scene);

  const measurements = (Array.isArray(file.measurements) ? (file.measurements as unknown[]) : [])
    .map((m) => (m as { atoms?: unknown } | null)?.atoms)
    .filter(
      (atoms): atoms is number[] =>
        Array.isArray(atoms) && atoms.length >= 2 && atoms.length <= 4 && atoms.every((id) => typeof id === 'number' && scene.atoms.has(id)),
    )
    .map((atoms, i) => ({ id: `r${i + 1}`, atoms: [...atoms] }));
  const bookmarks = (Array.isArray(file.bookmarks) ? (file.bookmarks as unknown[]) : []).filter(
    (b): b is CameraBookmark => isPose(b) && typeof (b as { id?: unknown }).id === 'string' && typeof (b as { name?: unknown }).name === 'string',
  );
  const view = file.view;
  const projection: Projection = view?.projection === 'orthographic' ? 'orthographic' : 'perspective';

  replaceDocument(scene, typeof file.name === 'string' ? file.name : 'Untitled', {
    measurements,
    bookmarks,
    renderMode: view && RENDER_MODES.includes(view.renderMode) ? view.renderMode : DEFAULT_VIEW.renderMode,
    labelMode: view && LABEL_MODES.includes(view.labelMode) ? view.labelMode : DEFAULT_VIEW.labelMode,
    projection,
    ...(typeof file.id === 'string' ? { projectId: file.id } : {}),
  });
  if (isPose(file.camera)) viewApi.setPose({ ...file.camera, projection }, false);
}

// ---------- session (restored on reload) ----------

const SESSION_KEY = 'matterlab.session.v1';
const PREFS_KEY = 'matterlab.prefs.v1';

interface Preferences {
  quality?: QualityId;
  ambientMotion?: boolean;
  showPerf?: boolean;
  explainLevel?: ExplainLevel;
  autoHydrogens?: boolean;
  inspectorOpen?: boolean;
}

export function restorePreferences(): boolean {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return false;
    const p = JSON.parse(raw) as Preferences;
    lab.set({
      ...(p.quality === 'efficient' || p.quality === 'balanced' || p.quality === 'quality' ? { quality: p.quality } : {}),
      ...(typeof p.ambientMotion === 'boolean' ? { ambientMotion: p.ambientMotion } : {}),
      ...(typeof p.showPerf === 'boolean' ? { showPerf: p.showPerf } : {}),
      ...(p.explainLevel === 'beginner' || p.explainLevel === 'advanced' ? { explainLevel: p.explainLevel } : {}),
      ...(typeof p.autoHydrogens === 'boolean' ? { autoHydrogens: p.autoHydrogens } : {}),
      ...(typeof p.inspectorOpen === 'boolean' ? { inspectorOpen: p.inspectorOpen } : {}),
    });
    return p.quality !== undefined;
  } catch {
    return false;
  }
}

export function restoreSession(): boolean {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return false;
    openProjectFile(JSON.parse(raw));
    return true;
  } catch {
    // A session that cannot be read is discarded rather than blocking start-up.
    localStorage.removeItem(SESSION_KEY);
    return false;
  }
}

let warnedAboutQuota = false;

/** Keeps the current session and preferences in local storage so a reload picks up where you left off. */
export function startAutosave(): () => void {
  let timer = 0;
  const saveSession = () => {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(buildProjectFile()));
    } catch {
      if (!warnedAboutQuota) {
        warnedAboutQuota = true;
        notify('warning', 'This project is too large to auto-save', 'Use Save or Export to keep your work.');
      }
    }
  };
  const schedule = () => {
    // Other workspaces only display structures; the Architect's document cannot change meanwhile.
    if (lab.get().workspace !== 'architect') return;
    window.clearTimeout(timer);
    timer = window.setTimeout(saveSession, 700);
  };
  sessionHooks.flush = () => {
    window.clearTimeout(timer);
    saveSession();
  };
  const stopSession = lab.subscribe(
    (s) => [s.revision, s.projectName, s.renderMode, s.projection, s.labelMode, s.measurements, s.bookmarks] as const,
    schedule,
    { equalityFn: (a, b) => a.every((v, i) => v === b[i]) },
  );
  const stopPrefs = lab.subscribe(
    (s) => [s.quality, s.ambientMotion, s.showPerf, s.explainLevel, s.autoHydrogens, s.inspectorOpen] as const,
    ([quality, ambientMotion, showPerf, explainLevel, autoHydrogens, inspectorOpen]) => {
      try {
        const prefs: Preferences = { quality, ambientMotion, showPerf, explainLevel, autoHydrogens, inspectorOpen };
        localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
      } catch {
        /* preferences are a convenience; losing them is harmless */
      }
    },
    { equalityFn: (a, b) => a.every((v, i) => v === b[i]) },
  );
  const flush = () => saveSession();
  window.addEventListener('pagehide', flush);
  return () => {
    window.clearTimeout(timer);
    sessionHooks.flush = () => {};
    stopSession();
    stopPrefs();
    window.removeEventListener('pagehide', flush);
  };
}

// ---------- project library (IndexedDB) ----------

export interface ProjectSummary {
  readonly id: string;
  readonly name: string;
  readonly savedAt: string;
  readonly atomCount: number;
  readonly formula: string;
  readonly thumbnail: string | null;
}

interface ProjectRecord extends ProjectSummary {
  readonly file: ProjectFile;
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const records = await getAll<ProjectRecord>('projects');
  return records
    .map(({ id, name, savedAt, atomCount, formula, thumbnail }) => ({ id, name, savedAt, atomCount, formula, thumbnail }))
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

/** Saves the current project to the library on this device, with a thumbnail of the view. */
export async function saveCurrentProject(): Promise<void> {
  if (lab.get().workspace !== 'architect') {
    notify('info', 'Projects are saved from the Architect', 'Switch back to the Architect workspace to save the molecule you are building.');
    return;
  }
  try {
    const file = buildProjectFile();
    const { scene, revision } = lab.get();
    const thumbnail = await viewApi.capture(420);
    const record: ProjectRecord = {
      id: file.id,
      name: file.name,
      savedAt: file.savedAt,
      atomCount: scene.atoms.size,
      formula: formatFormula(composition(scene)),
      thumbnail,
      file,
    };
    await putOne('projects', record);
    lab.set({ savedRevision: revision });
    notify('success', `Saved “${file.name}”`, 'Stored in the project library on this device.');
  } catch (error) {
    notify('error', 'The project could not be saved', error instanceof Error ? error.message : undefined);
  }
}

export async function openProject(id: string): Promise<void> {
  try {
    const record = await getOne<ProjectRecord>('projects', id);
    if (!record) throw new Error('That project is no longer in the library.');
    openProjectFile(record.file);
    lab.set((s) => ({ savedRevision: s.revision, dialog: null }));
  } catch (error) {
    notify('error', 'The project could not be opened', error instanceof Error ? error.message : undefined);
  }
}

export async function deleteProject(id: string): Promise<void> {
  await deleteOne('projects', id);
}
