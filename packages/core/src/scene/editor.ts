import { MAX_ATOMIC_NUMBER, isAtomicNumber } from '../elements';
import type { Atom, AtomId, Bond, BondId, BondOrder, Scene, ScenePatch, Vec3 } from '../types';
import { BOND_ORDERS } from '../types';
import { inheritAdjacency } from './queries';

export const EMPTY_SCENE: Scene = Object.freeze({
  atoms: new Map<AtomId, Atom>(),
  bonds: new Map<BondId, Bond>(),
  nextAtomId: 1,
  nextBondId: 1,
});

/** Upper bounds that keep particle counts finite; physical plausibility is reported separately as warnings. */
export const MAX_NEUTRONS = 400;
export const MAX_ELECTRONS = 400;

export interface AtomSpec {
  readonly protons: number;
  /** Omit or pass `null` for natural isotopic composition. */
  readonly neutrons?: number | null;
  /** Defaults to `protons - (charge ?? 0)`, i.e. a neutral atom when neither is given. */
  readonly electrons?: number;
  readonly charge?: number;
  readonly position: Vec3;
}

export type AtomChanges = Partial<Pick<Atom, 'protons' | 'neutrons' | 'electrons' | 'position'>>;

/** Thrown when an edit would produce a scene that cannot exist (unknown element, dangling bond, ...). */
export class SceneEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SceneEditError';
  }
}

function checkParticles(protons: number, neutrons: number | null, electrons: number): void {
  if (!isAtomicNumber(protons)) {
    throw new SceneEditError(
      `A proton count of ${protons} does not correspond to a known element (1-${MAX_ATOMIC_NUMBER}).`,
    );
  }
  if (neutrons !== null && (!Number.isInteger(neutrons) || neutrons < 0 || neutrons > MAX_NEUTRONS)) {
    throw new SceneEditError(`The neutron count must be a whole number between 0 and ${MAX_NEUTRONS}.`);
  }
  if (!Number.isInteger(electrons) || electrons < 0 || electrons > MAX_ELECTRONS) {
    throw new SceneEditError(`The electron count must be a whole number between 0 and ${MAX_ELECTRONS}.`);
  }
}

function checkPosition(position: Vec3): void {
  if (!position.every((c) => Number.isFinite(c))) {
    throw new SceneEditError('Atom positions must be finite numbers.');
  }
}

function sameAtom(a: Atom, b: Atom): boolean {
  return (
    a.protons === b.protons &&
    a.neutrons === b.neutrons &&
    a.electrons === b.electrons &&
    a.position[0] === b.position[0] &&
    a.position[1] === b.position[1] &&
    a.position[2] === b.position[2]
  );
}

function sameBond(a: Bond, b: Bond): boolean {
  return a.a === b.a && a.b === b.b && a.order === b.order;
}

/**
 * Collects any number of changes against a scene and turns them into one new scene plus one
 * reversible patch. Nothing is visible to the rest of the app until `commit` is called.
 */
export class SceneEditor {
  private atoms: ReadonlyMap<AtomId, Atom>;
  private bonds: ReadonlyMap<BondId, Bond>;
  private ownAtoms: Map<AtomId, Atom> | null = null;
  private ownBonds: Map<BondId, Bond> | null = null;
  private nextAtomId: AtomId;
  private nextBondId: BondId;
  private readonly touchedAtoms = new Set<AtomId>();
  private readonly touchedBonds = new Set<BondId>();
  private adjacency: Map<AtomId, Set<BondId>> | null = null;

  constructor(private readonly base: Scene) {
    this.atoms = base.atoms;
    this.bonds = base.bonds;
    this.nextAtomId = base.nextAtomId;
    this.nextBondId = base.nextBondId;
  }

  private writableAtoms(): Map<AtomId, Atom> {
    if (!this.ownAtoms) {
      this.ownAtoms = new Map(this.base.atoms);
      this.atoms = this.ownAtoms;
    }
    return this.ownAtoms;
  }

  private writableBonds(): Map<BondId, Bond> {
    if (!this.ownBonds) {
      this.ownBonds = new Map(this.base.bonds);
      this.bonds = this.ownBonds;
    }
    return this.ownBonds;
  }

  private bondIndex(): Map<AtomId, Set<BondId>> {
    if (!this.adjacency) {
      const index = new Map<AtomId, Set<BondId>>();
      for (const bond of this.bonds.values()) {
        for (const end of [bond.a, bond.b]) {
          const set = index.get(end);
          if (set) set.add(bond.id);
          else index.set(end, new Set([bond.id]));
        }
      }
      this.adjacency = index;
    }
    return this.adjacency;
  }

  hasAtom(id: AtomId): boolean {
    return this.atoms.has(id);
  }

  getAtom(id: AtomId): Atom {
    const atom = this.atoms.get(id);
    if (!atom) throw new SceneEditError(`Atom ${id} does not exist.`);
    return atom;
  }

  getBond(id: BondId): Bond {
    const bond = this.bonds.get(id);
    if (!bond) throw new SceneEditError(`Bond ${id} does not exist.`);
    return bond;
  }

  allAtoms(): IterableIterator<Atom> {
    return this.atoms.values();
  }

  allBonds(): IterableIterator<Bond> {
    return this.bonds.values();
  }

  bondsOf(atomId: AtomId): Bond[] {
    const ids = this.bondIndex().get(atomId);
    return ids ? [...ids].map((id) => this.bonds.get(id)!) : [];
  }

  neighborsOf(atomId: AtomId): AtomId[] {
    return this.bondsOf(atomId).map((b) => (b.a === atomId ? b.b : b.a));
  }

  findBond(a: AtomId, b: AtomId): Bond | undefined {
    return this.bondsOf(a).find((bond) => bond.a === b || bond.b === b);
  }

  addAtom(spec: AtomSpec): AtomId {
    const neutrons = spec.neutrons ?? null;
    const electrons = spec.electrons ?? spec.protons - (spec.charge ?? 0);
    checkParticles(spec.protons, neutrons, electrons);
    checkPosition(spec.position);
    const id = this.nextAtomId++;
    const atom: Atom = {
      id,
      protons: spec.protons,
      neutrons,
      electrons,
      position: [spec.position[0], spec.position[1], spec.position[2]],
    };
    this.writableAtoms().set(id, atom);
    this.touchedAtoms.add(id);
    return id;
  }

  updateAtom(id: AtomId, changes: AtomChanges): void {
    const current = this.getAtom(id);
    const next: Atom = { ...current, ...changes, id };
    checkParticles(next.protons, next.neutrons, next.electrons);
    checkPosition(next.position);
    if (sameAtom(current, next)) return;
    this.writableAtoms().set(id, next);
    this.touchedAtoms.add(id);
  }

  moveAtom(id: AtomId, position: Vec3): void {
    this.updateAtom(id, { position: [position[0], position[1], position[2]] });
  }

  /** Removes an atom together with every bond attached to it. */
  removeAtom(id: AtomId): void {
    this.getAtom(id);
    for (const bond of this.bondsOf(id)) this.removeBond(bond.id);
    this.writableAtoms().delete(id);
    this.touchedAtoms.add(id);
  }

  /**
   * Bonds two atoms. If they are already bonded the existing bond's order is updated instead, so a
   * pair of atoms never carries two bonds.
   */
  addBond(a: AtomId, b: AtomId, order: BondOrder = 1): BondId {
    if (a === b) throw new SceneEditError('An atom cannot be bonded to itself.');
    this.getAtom(a);
    this.getAtom(b);
    if (!BOND_ORDERS.includes(order)) throw new SceneEditError(`Unsupported bond order: ${order}.`);
    const existing = this.findBond(a, b);
    if (existing) {
      this.setBondOrder(existing.id, order);
      return existing.id;
    }
    const id = this.nextBondId++;
    this.writableBonds().set(id, { id, a, b, order });
    const index = this.bondIndex();
    for (const end of [a, b]) {
      const set = index.get(end);
      if (set) set.add(id);
      else index.set(end, new Set([id]));
    }
    this.touchedBonds.add(id);
    return id;
  }

  setBondOrder(id: BondId, order: BondOrder): void {
    const bond = this.getBond(id);
    if (!BOND_ORDERS.includes(order)) throw new SceneEditError(`Unsupported bond order: ${order}.`);
    if (bond.order === order) return;
    this.writableBonds().set(id, { ...bond, order });
    this.touchedBonds.add(id);
  }

  removeBond(id: BondId): void {
    const bond = this.getBond(id);
    this.writableBonds().delete(id);
    const index = this.bondIndex();
    index.get(bond.a)?.delete(id);
    index.get(bond.b)?.delete(id);
    this.touchedBonds.add(id);
  }

  /** The scene as it currently stands inside this editor, for code that needs read-only scene queries mid-edit. */
  snapshot(): Scene {
    return { atoms: this.atoms, bonds: this.bonds, nextAtomId: this.nextAtomId, nextBondId: this.nextBondId };
  }

  commit(label: string): { scene: Scene; patch: ScenePatch } {
    const atomsAdded: Atom[] = [];
    const atomsRemoved: Atom[] = [];
    const atomsChanged: { before: Atom; after: Atom }[] = [];
    for (const id of this.touchedAtoms) {
      const before = this.base.atoms.get(id);
      const after = this.atoms.get(id);
      if (before && after) {
        if (!sameAtom(before, after)) atomsChanged.push({ before, after });
      } else if (after) atomsAdded.push(after);
      else if (before) atomsRemoved.push(before);
    }

    const bondsAdded: Bond[] = [];
    const bondsRemoved: Bond[] = [];
    const bondsChanged: { before: Bond; after: Bond }[] = [];
    for (const id of this.touchedBonds) {
      const before = this.base.bonds.get(id);
      const after = this.bonds.get(id);
      if (before && after) {
        if (!sameBond(before, after)) bondsChanged.push({ before, after });
      } else if (after) bondsAdded.push(after);
      else if (before) bondsRemoved.push(before);
    }

    const byId = (x: { id: number }, y: { id: number }) => x.id - y.id;
    const patch: ScenePatch = {
      label,
      atomsAdded: atomsAdded.sort(byId),
      atomsRemoved: atomsRemoved.sort(byId),
      atomsChanged: atomsChanged.sort((x, y) => x.before.id - y.before.id),
      bondsAdded: bondsAdded.sort(byId),
      bondsRemoved: bondsRemoved.sort(byId),
      bondsChanged: bondsChanged.sort((x, y) => x.before.id - y.before.id),
      nextAtomId: { before: this.base.nextAtomId, after: this.nextAtomId },
      nextBondId: { before: this.base.nextBondId, after: this.nextBondId },
    };

    if (isEmptyPatch(patch)) return { scene: this.base, patch: { ...patch, nextAtomId: sameIds(this.base.nextAtomId), nextBondId: sameIds(this.base.nextBondId) } };
    const scene = this.snapshot();
    if (keepsBondingGraph(patch)) inheritAdjacency(this.base, scene);
    return { scene, patch };
  }
}

/** True when a patch leaves the atoms and the bonds between them as they were: it only moves or alters them. */
function keepsBondingGraph(patch: ScenePatch): boolean {
  return (
    patch.atomsAdded.length === 0 &&
    patch.atomsRemoved.length === 0 &&
    patch.bondsAdded.length === 0 &&
    patch.bondsRemoved.length === 0 &&
    patch.bondsChanged.every((change) => change.before.a === change.after.a && change.before.b === change.after.b)
  );
}

function sameIds(id: number): { before: number; after: number } {
  return { before: id, after: id };
}

/** True when a patch changes no atom and no bond. */
export function isEmptyPatch(patch: ScenePatch): boolean {
  return (
    patch.atomsAdded.length === 0 &&
    patch.atomsRemoved.length === 0 &&
    patch.atomsChanged.length === 0 &&
    patch.bondsAdded.length === 0 &&
    patch.bondsRemoved.length === 0 &&
    patch.bondsChanged.length === 0
  );
}

/** Runs `fn` against an editor for `scene` and commits the result as a single labelled edit. */
export function editScene(
  scene: Scene,
  label: string,
  fn: (editor: SceneEditor) => void,
): { scene: Scene; patch: ScenePatch } {
  const editor = new SceneEditor(scene);
  fn(editor);
  return editor.commit(label);
}

export function applyPatch(scene: Scene, patch: ScenePatch): Scene {
  if (isEmptyPatch(patch)) return scene;
  const atoms = new Map(scene.atoms);
  const bonds = new Map(scene.bonds);
  for (const bond of patch.bondsRemoved) bonds.delete(bond.id);
  for (const atom of patch.atomsRemoved) atoms.delete(atom.id);
  for (const atom of patch.atomsAdded) atoms.set(atom.id, atom);
  for (const change of patch.atomsChanged) atoms.set(change.after.id, change.after);
  for (const bond of patch.bondsAdded) bonds.set(bond.id, bond);
  for (const change of patch.bondsChanged) bonds.set(change.after.id, change.after);
  const next: Scene = { atoms, bonds, nextAtomId: patch.nextAtomId.after, nextBondId: patch.nextBondId.after };
  if (keepsBondingGraph(patch)) inheritAdjacency(scene, next);
  return next;
}

/** The patch that exactly undoes `patch`. */
export function invertPatch(patch: ScenePatch): ScenePatch {
  return {
    label: patch.label,
    atomsAdded: patch.atomsRemoved,
    atomsRemoved: patch.atomsAdded,
    atomsChanged: patch.atomsChanged.map((c) => ({ before: c.after, after: c.before })),
    bondsAdded: patch.bondsRemoved,
    bondsRemoved: patch.bondsAdded,
    bondsChanged: patch.bondsChanged.map((c) => ({ before: c.after, after: c.before })),
    nextAtomId: { before: patch.nextAtomId.after, after: patch.nextAtomId.before },
    nextBondId: { before: patch.nextBondId.after, after: patch.nextBondId.before },
  };
}

/** True when a patch adds or removes atoms or bonds, or changes a bond order (as opposed to only moving or re-labelling atoms). */
export function patchChangesTopology(patch: ScenePatch): boolean {
  return (
    patch.atomsAdded.length > 0 ||
    patch.atomsRemoved.length > 0 ||
    patch.bondsAdded.length > 0 ||
    patch.bondsRemoved.length > 0 ||
    patch.bondsChanged.length > 0
  );
}
