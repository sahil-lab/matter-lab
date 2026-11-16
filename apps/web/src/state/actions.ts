import {
  EMPTY_HISTORY,
  EMPTY_SCENE,
  SceneEditError,
  addHydrogens,
  adjustHydrogens,
  atomCharge,
  editScene,
  exampleScene,
  findExample,
  fragmentOf,
  getElement,
  idealBondLength,
  insertExample,
  isEmptyPatch,
  recordPatch,
  redo as redoPatch,
  removeHydrogens,
  setAngle,
  setDihedral,
  setDistance,
  sortedAtoms,
  undo as undoPatch,
  vadd,
  vlen,
  vscale,
  vsub,
} from '@matterlab/core';
import type { AtomId, BondId, BondOrder, GeometryEditResult, Scene, SceneEditor, ScenePatch, Vec3 } from '@matterlab/core';
import { viewApi } from '../render/viewApi';
import { DEFAULT_VIEW, MEASURE_ATOM_COUNT, isReadOnly, lab, newProjectId, pickDocument, sessionHooks } from './store';
import type { ClipboardData, DocumentSlice, LabState, Toast, Workspace } from './store';

// ---------- notifications ----------

let toastSeq = 1;

export function notify(kind: Toast['kind'], title: string, detail?: string): void {
  const id = toastSeq++;
  lab.set((s) => ({ toasts: [...s.toasts.slice(-3), { id, kind, title, detail }] }));
  const lifetime = kind === 'error' ? 9000 : kind === 'warning' ? 7000 : 3800;
  window.setTimeout(() => dismissToast(id), lifetime);
}

export function dismissToast(id: number): void {
  lab.set((s) => (s.toasts.some((t) => t.id === id) ? { toasts: s.toasts.filter((t) => t.id !== id) } : s));
}

// ---------- scene changes ----------

function keep<T>(set: ReadonlySet<T>, alive: (value: T) => boolean): ReadonlySet<T> {
  let dropped = false;
  for (const value of set) {
    if (!alive(value)) {
      dropped = true;
      break;
    }
  }
  if (!dropped) return set;
  const next = new Set<T>();
  for (const value of set) if (alive(value)) next.add(value);
  return next;
}

/** Drops references to atoms and bonds that no longer exist after a scene change. */
function reconcile(scene: Scene, s: LabState): Partial<LabState> {
  const hasAtom = (id: AtomId) => scene.atoms.has(id);
  return {
    selectedAtoms: keep(s.selectedAtoms, hasAtom),
    selectedBonds: keep(s.selectedBonds, (id) => scene.bonds.has(id)),
    hoveredAtom: s.hoveredAtom !== null && hasAtom(s.hoveredAtom) ? s.hoveredAtom : null,
    hoveredBond: s.hoveredBond !== null && scene.bonds.has(s.hoveredBond) ? s.hoveredBond : null,
    measurements: s.measurements.every((m) => m.atoms.every(hasAtom))
      ? s.measurements
      : s.measurements.filter((m) => m.atoms.every(hasAtom)),
    measurePicks: s.measurePicks.every(hasAtom) ? s.measurePicks : s.measurePicks.filter(hasAtom),
  };
}

function commit(scene: Scene, patch: ScenePatch): void {
  lab.set((s) => ({
    scene,
    history: recordPatch(s.history, patch),
    revision: s.revision + 1,
    lastPatch: patch,
    ...reconcile(scene, s),
  }));
}

/**
 * Applies one undoable edit. Every change to the scene goes through here, which is what guarantees
 * that every edit can be undone. Returns what `fn` returned, or `undefined` if the edit was rejected.
 */
export function runEdit<T>(label: string, fn: (editor: SceneEditor) => T): T | undefined {
  // Structures shown by the other workspaces are results, not documents: they cannot be edited.
  if (isReadOnly(lab.get())) return undefined;
  let value: T;
  let result: { scene: Scene; patch: ScenePatch };
  try {
    let captured: T | undefined;
    result = editScene(lab.get().scene, label, (editor) => {
      captured = fn(editor);
    });
    value = captured as T;
  } catch (error) {
    if (error instanceof SceneEditError) {
      notify('error', 'That edit is not possible', error.message);
      return undefined;
    }
    throw error;
  }
  if (!isEmptyPatch(result.patch)) commit(result.scene, result.patch);
  return value;
}

export function undo(): void {
  const s = lab.get();
  if (isReadOnly(s)) return;
  const step = undoPatch(s.scene, s.history);
  if (!step) return;
  lab.set((state) => ({
    scene: step.scene,
    history: step.history,
    revision: state.revision + 1,
    lastPatch: step.applied,
    ...reconcile(step.scene, state),
  }));
}

export function redo(): void {
  const s = lab.get();
  if (isReadOnly(s)) return;
  const step = redoPatch(s.scene, s.history);
  if (!step) return;
  lab.set((state) => ({
    scene: step.scene,
    history: step.history,
    revision: state.revision + 1,
    lastPatch: step.applied,
    ...reconcile(step.scene, state),
  }));
}

/** Replaces the whole document (new, open, import). This is not an edit: history starts afresh. */
export function replaceDocument(scene: Scene, name: string, extra: Partial<LabState> = {}): void {
  // Documents live in the Architect; opening one from another workspace goes there first.
  if (lab.get().workspace !== 'architect') enterWorkspace('architect');
  lab.set((s) => ({
    projectId: newProjectId(),
    projectName: name || 'Untitled',
    scene,
    history: EMPTY_HISTORY,
    revision: s.revision + 1,
    savedRevision: s.revision + 1,
    lastPatch: null,
    selectedAtoms: new Set(),
    selectedBonds: new Set(),
    hoveredAtom: null,
    hoveredBond: null,
    measurements: [],
    measurePicks: [],
    bookmarks: [],
    ...extra,
  }));
  viewApi.fitAll(false);
}

export function newDocument(): void {
  replaceDocument(EMPTY_SCENE, 'Untitled', { ...DEFAULT_VIEW, tool: 'build' });
}

// ---------- workspaces ----------

const WORKSPACE_STAGE: Readonly<Record<Exclude<Workspace, 'architect'>, string>> = {
  reactions: 'Reaction chamber',
  vault: 'Discovery Vault',
};

/**
 * Switches workspace. The Architect's document, history and camera are set aside untouched while
 * another workspace uses the 3D stage, and come back exactly as they were.
 */
export function enterWorkspace(workspace: Workspace): void {
  const s = lab.get();
  if (s.workspace === workspace) return;
  if (s.workspace === 'architect') {
    sessionHooks.flush();
    lab.set({
      workspace,
      parked: { document: pickDocument(s), camera: viewApi.getPose() },
      ...emptyStage(WORKSPACE_STAGE[workspace as Exclude<Workspace, 'architect'>], s.revision + 1),
    });
    viewApi.fitAll(false);
    return;
  }
  if (workspace === 'architect') {
    const parked = s.parked;
    // The revision counter only ever moves forward; whether there are unsaved changes carries over.
    const revision = s.revision + 1;
    lab.set({
      workspace,
      parked: null,
      ...(parked
        ? {
            ...parked.document,
            revision,
            savedRevision: parked.document.revision === parked.document.savedRevision ? revision : parked.document.savedRevision,
            lastPatch: null,
            hoveredAtom: null,
            hoveredBond: null,
          }
        : {}),
    });
    if (parked?.camera) viewApi.setPose(parked.camera, false);
    else viewApi.fitAll(false);
    return;
  }
  lab.set({ workspace, ...emptyStage(WORKSPACE_STAGE[workspace], s.revision + 1) });
  viewApi.fitAll(false);
}

function emptyStage(name: string, revision: number): DocumentSlice {
  return {
    projectId: 'stage',
    projectName: name,
    scene: EMPTY_SCENE,
    history: EMPTY_HISTORY,
    revision,
    savedRevision: revision,
    lastPatch: null,
    selectedAtoms: new Set(),
    selectedBonds: new Set(),
    hoveredAtom: null,
    hoveredBond: null,
    tool: 'select',
    measurePicks: [],
    measurements: [],
    bookmarks: [],
  };
}

/**
 * Puts a structure on the 3D stage of a display-only workspace (a reaction chamber, a vault
 * candidate). It never touches the Architect's document.
 */
export function showOnStage(scene: Scene, options: { fit?: boolean; keepSelection?: boolean } = {}): void {
  const s = lab.get();
  if (!isReadOnly(s)) return;
  const empty = s.scene.atoms.size === 0;
  lab.set({
    scene,
    lastPatch: null,
    revision: s.revision + 1,
    savedRevision: s.revision + 1,
    hoveredAtom: null,
    hoveredBond: null,
    ...(options.keepSelection ? reconcile(scene, s) : { selectedAtoms: new Set<AtomId>(), selectedBonds: new Set<BondId>(), measurePicks: [], measurements: [] }),
  });
  if (options.fit ?? empty) viewApi.fitAll(!empty);
}

export function openExample(id: string): void {
  const example = findExample(id);
  if (!example) return;
  replaceDocument(exampleScene(example), example.name);
}

/** Adds an example molecule next to what is already in the workspace, as one undoable edit. */
export function addExample(id: string): void {
  const example = findExample(id);
  if (!example) return;
  const scene = lab.get().scene;
  let offsetX = 0;
  if (scene.atoms.size > 0) {
    let maxX = -Infinity;
    for (const atom of scene.atoms.values()) maxX = Math.max(maxX, atom.position[0]);
    const minX = Math.min(...example.atoms.map((a) => a[2]!));
    offsetX = maxX - minX + 3.2;
  }
  const ids = runEdit(`Add ${example.name}`, (e) => insertExample(e, example, [offsetX, 0, 0]));
  if (ids) {
    selectOnly(ids);
    viewApi.fitAll(true);
  }
}

/** Inserts atoms and bonds from another scene (an imported file) into the workspace as one edit. */
export function insertScene(source: Scene, label: string, offset: Vec3 = [0, 0, 0]): AtomId[] | undefined {
  return runEdit(label, (e) => {
    const map = new Map<AtomId, AtomId>();
    for (const atom of sortedAtoms(source)) {
      map.set(
        atom.id,
        e.addAtom({ protons: atom.protons, neutrons: atom.neutrons, electrons: atom.electrons, position: vadd(atom.position, offset) }),
      );
    }
    for (const bond of source.bonds.values()) e.addBond(map.get(bond.a)!, map.get(bond.b)!, bond.order);
    return [...map.values()];
  });
}

// ---------- selection ----------

export function selectOnly(atoms: Iterable<AtomId> = [], bonds: Iterable<BondId> = []): void {
  lab.set({ selectedAtoms: new Set(atoms), selectedBonds: new Set(bonds) });
}

export function clearSelection(): void {
  const s = lab.get();
  if (s.selectedAtoms.size === 0 && s.selectedBonds.size === 0) return;
  lab.set({ selectedAtoms: new Set(), selectedBonds: new Set() });
}

export function toggleAtomSelection(id: AtomId): void {
  lab.set((s) => {
    const next = new Set(s.selectedAtoms);
    if (!next.delete(id)) next.add(id);
    return { selectedAtoms: next };
  });
}

export function toggleBondSelection(id: BondId): void {
  lab.set((s) => {
    const next = new Set(s.selectedBonds);
    if (!next.delete(id)) next.add(id);
    return { selectedBonds: next };
  });
}

export function addToSelection(atoms: Iterable<AtomId>): void {
  lab.set((s) => {
    const next = new Set(s.selectedAtoms);
    for (const id of atoms) next.add(id);
    return { selectedAtoms: next };
  });
}

export function selectAll(): void {
  lab.set((s) => ({ selectedAtoms: new Set(s.scene.atoms.keys()), selectedBonds: new Set() }));
}

/** Selects the whole molecule that `atomId` belongs to. */
export function selectMolecule(atomId: AtomId, additive = false): void {
  const fragment = fragmentOf(lab.get().scene, atomId);
  if (additive) addToSelection(fragment);
  else selectOnly(fragment);
}

export function setHover(atom: AtomId | null, bond: BondId | null): void {
  const s = lab.get();
  if (s.hoveredAtom !== atom || s.hoveredBond !== bond) lab.set({ hoveredAtom: atom, hoveredBond: bond });
}

// ---------- building ----------

function hydrogensFollow(editor: SceneEditor, atoms: Iterable<AtomId>): void {
  if (lab.get().autoHydrogens) adjustHydrogens(editor, atoms);
}

export function placeAtom(position: Vec3): AtomId | undefined {
  const z = lab.get().buildElement;
  return runEdit(`Add ${getElement(z).name.toLowerCase()}`, (e) => {
    const id = e.addAtom({ protons: z, position });
    hydrogensFollow(e, [id]);
    return id;
  });
}

/** Adds a new atom of the current element bonded to `from`. */
export function growAtom(from: AtomId, position: Vec3): AtomId | undefined {
  const { buildElement: z, bondOrder } = lab.get();
  return runEdit(`Add bonded ${getElement(z).name.toLowerCase()}`, (e) => {
    const id = e.addAtom({ protons: z, position });
    e.addBond(from, id, bondOrder);
    hydrogensFollow(e, [from, id]);
    return id;
  });
}

const ORDER_CYCLE: readonly BondOrder[] = [1, 2, 3, 1.5];

/** Bonds two atoms with the current bond order; if they are already bonded at that order, steps to the next one. */
export function connectAtoms(a: AtomId, b: AtomId): void {
  if (a === b) return;
  const { bondOrder } = lab.get();
  runEdit('Bond atoms', (e) => {
    const existing = e.findBond(a, b);
    const order = existing && existing.order === bondOrder ? ORDER_CYCLE[(ORDER_CYCLE.indexOf(bondOrder) + 1) % ORDER_CYCLE.length]! : bondOrder;
    e.addBond(a, b, order);
    hydrogensFollow(e, [a, b]);
  });
}

/** Applies the current bond order to a bond, or steps to the next order if it already has it. */
export function applyBondOrder(bondId: BondId): void {
  const { bondOrder, scene } = lab.get();
  const bond = scene.bonds.get(bondId);
  if (!bond) return;
  const order = bond.order === bondOrder ? ORDER_CYCLE[(ORDER_CYCLE.indexOf(bond.order) + 1) % ORDER_CYCLE.length]! : bondOrder;
  setBondOrders([bondId], order);
}

export function setBondOrders(bondIds: Iterable<BondId>, order: BondOrder): void {
  runEdit('Change bond order', (e) => {
    const touched: AtomId[] = [];
    for (const id of bondIds) {
      const bond = e.getBond(id);
      e.setBondOrder(id, order);
      touched.push(bond.a, bond.b);
    }
    hydrogensFollow(e, touched);
  });
}

/**
 * Turns atoms into another element while keeping each atom's net charge; any specified isotope is
 * cleared. A chain-end atom also slides to a typical bond length for its new element, and when
 * hydrogens follow valence its hydrogens are rebuilt, so the local geometry stays sensible.
 */
export function changeElement(atomIds: Iterable<AtomId>, z: number): void {
  const auto = lab.get().autoHydrogens;
  runEdit(`Change to ${getElement(z).name.toLowerCase()}`, (e) => {
    const ids = [...atomIds].filter((id) => e.hasAtom(id));
    for (const id of ids) {
      const atom = e.getAtom(id);
      e.updateAtom(id, { protons: z, neutrons: null, electrons: Math.max(0, z - atomCharge(atom)) });
      if (auto && z !== 1) {
        for (const n of e.neighborsOf(id)) {
          if (!ids.includes(n) && e.getAtom(n).protons === 1 && e.neighborsOf(n).length === 1) e.removeAtom(n);
        }
      }
      const neighbours = e.neighborsOf(id);
      if (neighbours.length === 1) {
        const anchor = e.getAtom(neighbours[0]!);
        const bond = e.findBond(id, anchor.id)!;
        const direction = vsub(e.getAtom(id).position, anchor.position);
        const length = vlen(direction);
        if (length > 1e-6) {
          e.moveAtom(id, vadd(anchor.position, vscale(direction, idealBondLength(anchor.protons, z, bond.order) / length)));
        }
      }
    }
    hydrogensFollow(e, ids);
  });
}

export interface ParticleChange {
  readonly protons?: number;
  readonly neutrons?: number | null;
  readonly electrons?: number;
}

/**
 * Sets the raw particle counts of one atom, exactly as asked: protons fix the element, neutrons the
 * isotope, electrons the charge. Nothing else is adjusted except, when hydrogens follow valence,
 * the hydrogens on a bonded atom.
 */
export function setParticles(atomId: AtomId, change: ParticleChange, label: string): void {
  runEdit(label, (e) => {
    e.updateAtom(atomId, change);
    if (e.neighborsOf(atomId).length > 0 && (change.protons !== undefined || change.electrons !== undefined)) {
      hydrogensFollow(e, [atomId]);
    }
  });
}

export function moveAtoms(positions: ReadonlyMap<AtomId, Vec3>, label = 'Move'): void {
  runEdit(label, (e) => {
    for (const [id, position] of positions) if (e.hasAtom(id)) e.moveAtom(id, position);
  });
}

export function setAtomPosition(atomId: AtomId, position: Vec3): void {
  runEdit('Set position', (e) => e.moveAtom(atomId, position));
}

export function eraseAtoms(atomIds: Iterable<AtomId>): void {
  const ids = [...atomIds];
  if (ids.length === 0) return;
  const before = lab.get().scene;
  const auto = lab.get().autoHydrogens;
  runEdit(ids.length === 1 ? 'Delete atom' : 'Delete atoms', (e) => {
    const doomed = new Set(ids.filter((id) => e.hasAtom(id)));
    if (auto) {
      // Hydrogens belong to the atom they sit on: when it goes, they go with it rather than being left adrift.
      for (const id of [...doomed]) {
        if (before.atoms.get(id)?.protons === 1) continue;
        for (const n of e.neighborsOf(id)) {
          if (e.getAtom(n).protons === 1 && e.neighborsOf(n).length === 1) doomed.add(n);
        }
      }
    }
    const neighbours = new Set<AtomId>();
    for (const id of doomed) {
      for (const n of e.neighborsOf(id)) if (!doomed.has(n)) neighbours.add(n);
    }
    for (const id of doomed) e.removeAtom(id);
    // Deleting a hydrogen on purpose must not have it grow straight back.
    const deletedOnlyHydrogens = ids.every((id) => before.atoms.get(id)?.protons === 1);
    if (!deletedOnlyHydrogens) hydrogensFollow(e, neighbours);
  });
}

export function eraseBonds(bondIds: Iterable<BondId>): void {
  const ids = [...bondIds];
  if (ids.length === 0) return;
  runEdit(ids.length === 1 ? 'Delete bond' : 'Delete bonds', (e) => {
    const ends: AtomId[] = [];
    for (const id of ids) {
      const bond = e.getBond(id);
      ends.push(bond.a, bond.b);
      e.removeBond(id);
    }
    hydrogensFollow(e, ends);
  });
}

export function deleteSelection(): void {
  const { selectedAtoms, selectedBonds, scene } = lab.get();
  if (selectedAtoms.size === 0 && selectedBonds.size === 0) return;
  if (selectedAtoms.size === 0) return eraseBonds(selectedBonds);
  // Bonds between surviving atoms are removed first; the atoms then go through the usual path.
  const looseBonds = [...selectedBonds].filter((id) => {
    const bond = scene.bonds.get(id);
    return bond && !selectedAtoms.has(bond.a) && !selectedAtoms.has(bond.b);
  });
  if (looseBonds.length === 0) return eraseAtoms(selectedAtoms);
  const atoms = [...selectedAtoms];
  runEdit('Delete selection', (e) => {
    const touched = new Set<AtomId>();
    for (const id of looseBonds) {
      const bond = e.getBond(id);
      touched.add(bond.a).add(bond.b);
      e.removeBond(id);
    }
    for (const id of atoms) {
      for (const n of e.neighborsOf(id)) if (!selectedAtoms.has(n)) touched.add(n);
      e.removeAtom(id);
    }
    hydrogensFollow(e, touched);
  });
}

/** Fills open valences with hydrogens on the selected atoms, or on every atom when nothing is selected. */
export function hydrogenate(): void {
  const { selectedAtoms } = lab.get();
  const added = runEdit('Add hydrogens', (e) => addHydrogens(e, selectedAtoms.size > 0 ? selectedAtoms : undefined));
  if (!added) return;
  if (added.length === 0) notify('info', 'No open valences', 'Every atom in scope already has a complete valence.');
  else notify('success', `Added ${added.length} hydrogen${added.length === 1 ? '' : 's'}`, 'Placed at idealised positions. Optimise the geometry to refine them.');
}

export function stripHydrogens(): void {
  const { selectedAtoms } = lab.get();
  const removed = runEdit('Remove hydrogens', (e) => removeHydrogens(e, selectedAtoms.size > 0 ? selectedAtoms : undefined));
  if (removed === 0) notify('info', 'No hydrogens to remove');
}

// ---------- clipboard ----------

function snapshotSelection(): ClipboardData | null {
  const { scene, selectedAtoms } = lab.get();
  if (selectedAtoms.size === 0) return null;
  const atoms = sortedAtoms(scene).filter((a) => selectedAtoms.has(a.id));
  const index = new Map(atoms.map((a, i) => [a.id, i]));
  const bonds = [...scene.bonds.values()]
    .filter((b) => index.has(b.a) && index.has(b.b))
    .map((b) => ({ a: index.get(b.a)!, b: index.get(b.b)!, order: b.order }));
  return {
    atoms: atoms.map((a) => ({ protons: a.protons, neutrons: a.neutrons, electrons: a.electrons, position: a.position })),
    bonds,
  };
}

function insertClipboard(data: ClipboardData, offset: Vec3, label: string): void {
  const ids = runEdit(label, (e) => {
    const created = data.atoms.map((a) => e.addAtom({ ...a, position: vadd(a.position, offset) }));
    for (const b of data.bonds) e.addBond(created[b.a]!, created[b.b]!, b.order);
    return created;
  });
  if (ids) selectOnly(ids);
}

/** Offset that moves a copy clear of the original: sideways in the current view. */
function sidewaysOffset(): Vec3 {
  const basis = viewApi.getBasis();
  const d = 1.6;
  return basis ? [(basis.right[0] - basis.up[0]) * d, (basis.right[1] - basis.up[1]) * d, (basis.right[2] - basis.up[2]) * d] : [d, -d, 0];
}

export function copySelection(): boolean {
  const data = snapshotSelection();
  if (!data) return false;
  lab.set({ clipboard: data });
  notify('info', `Copied ${data.atoms.length} atom${data.atoms.length === 1 ? '' : 's'}`);
  return true;
}

export function cutSelection(): void {
  const data = snapshotSelection();
  if (!data) return;
  lab.set({ clipboard: data });
  eraseAtoms(lab.get().selectedAtoms);
}

export function pasteClipboard(): void {
  const { clipboard } = lab.get();
  if (!clipboard) return;
  insertClipboard(clipboard, sidewaysOffset(), 'Paste');
  // Shift the stored copy too, so repeated pastes do not stack on top of each other.
  const offset = sidewaysOffset();
  lab.set({ clipboard: { ...clipboard, atoms: clipboard.atoms.map((a) => ({ ...a, position: vadd(a.position, offset) })) } });
}

export function duplicateSelection(): void {
  const data = snapshotSelection();
  if (data) insertClipboard(data, sidewaysOffset(), 'Duplicate');
}

// ---------- precise geometry ----------

function geometryEdit(label: string, apply: (e: SceneEditor) => GeometryEditResult): void {
  let failure: string | null = null;
  runEdit(label, (e) => {
    const result = apply(e);
    if (!result.ok) failure = result.reason;
  });
  if (failure) notify('warning', 'Could not apply that value', failure);
}

export function applyDistance(a: AtomId, b: AtomId, angstrom: number): void {
  geometryEdit('Set distance', (e) => setDistance(e, a, b, angstrom));
}

export function applyAngle(a: AtomId, b: AtomId, c: AtomId, degrees: number): void {
  geometryEdit('Set angle', (e) => setAngle(e, a, b, c, degrees));
}

export function applyDihedral(a: AtomId, b: AtomId, c: AtomId, d: AtomId, degrees: number): void {
  geometryEdit('Set dihedral', (e) => setDihedral(e, a, b, c, d, degrees));
}

// ---------- measurements ----------

let measurementSeq = 1;

/** Adds an atom to the measurement in progress; completes it once enough atoms are picked. */
export function pickForMeasurement(atomId: AtomId): void {
  lab.set((s) => {
    if (s.measurePicks.includes(atomId)) return { measurePicks: s.measurePicks.filter((id) => id !== atomId) };
    const picks = [...s.measurePicks, atomId];
    if (picks.length < MEASURE_ATOM_COUNT[s.measureKind]) return { measurePicks: picks };
    return {
      measurePicks: [],
      measurements: [...s.measurements, { id: `m${measurementSeq++}`, atoms: picks }],
      inspectorTab: 'measure',
    };
  });
}

export function addMeasurement(atoms: readonly AtomId[]): void {
  if (atoms.length < 2 || atoms.length > 4) return;
  lab.set((s) => ({ measurements: [...s.measurements, { id: `m${measurementSeq++}`, atoms: [...atoms] }] }));
}

export function removeMeasurement(id: string): void {
  lab.set((s) => ({ measurements: s.measurements.filter((m) => m.id !== id) }));
}

export function clearMeasurements(): void {
  lab.set({ measurements: [], measurePicks: [] });
}

// ---------- camera bookmarks ----------

let bookmarkSeq = 1;

export function addBookmark(): void {
  const pose = viewApi.getPose();
  if (!pose) return;
  lab.set((s) => ({ bookmarks: [...s.bookmarks, { ...pose, id: `b${bookmarkSeq++}`, name: `View ${s.bookmarks.length + 1}` }] }));
  notify('success', 'View bookmarked');
}

export function removeBookmark(id: string): void {
  lab.set((s) => ({ bookmarks: s.bookmarks.filter((b) => b.id !== id) }));
}

export function gotoBookmark(id: string): void {
  const bookmark = lab.get().bookmarks.find((b) => b.id === id);
  if (!bookmark) return;
  if (bookmark.projection !== lab.get().projection) lab.set({ projection: bookmark.projection });
  viewApi.setPose(bookmark, true);
}

/** Frames the selection, or the whole scene when nothing is selected. */
export function focusSelection(): void {
  const { selectedAtoms, selectedBonds, scene } = lab.get();
  const ids = new Set(selectedAtoms);
  for (const id of selectedBonds) {
    const bond = scene.bonds.get(id);
    if (bond) ids.add(bond.a).add(bond.b);
  }
  if (ids.size > 0) viewApi.focusAtoms(ids, true);
  else viewApi.fitAll(true);
}
