/** Cartesian vector. Positions are in angstrom unless a field states otherwise. */
export type Vec3 = readonly [number, number, number];

export type AtomId = number;
export type BondId = number;

/** 1 = single, 2 = double, 3 = triple, 1.5 = aromatic (delocalised). */
export type BondOrder = 1 | 1.5 | 2 | 3;

export const BOND_ORDERS: readonly BondOrder[] = [1, 1.5, 2, 3];

export interface Atom {
  readonly id: AtomId;
  /** Proton count, i.e. the atomic number Z (1-118). This alone fixes the element. */
  readonly protons: number;
  /**
   * Neutron count N, or `null` when no isotope is specified. An unspecified isotope means natural
   * isotopic composition, so mass calculations use the standard atomic weight.
   */
  readonly neutrons: number | null;
  /** Electron count. Net charge = protons - electrons, in units of the elementary charge. */
  readonly electrons: number;
  readonly position: Vec3;
}

export interface Bond {
  readonly id: BondId;
  readonly a: AtomId;
  readonly b: AtomId;
  readonly order: BondOrder;
}

/**
 * An immutable snapshot of everything in the workspace. Edits never mutate a scene; they produce a
 * new scene plus a `ScenePatch` describing the difference (see scene/editor.ts).
 */
export interface Scene {
  readonly atoms: ReadonlyMap<AtomId, Atom>;
  readonly bonds: ReadonlyMap<BondId, Bond>;
  /** Ids are never reused within a scene, so undo/redo and selections stay unambiguous. */
  readonly nextAtomId: AtomId;
  readonly nextBondId: BondId;
}

export interface AtomChange {
  readonly before: Atom;
  readonly after: Atom;
}

export interface BondChange {
  readonly before: Bond;
  readonly after: Bond;
}

/** A reversible description of one edit. Applying the inverse patch restores the previous scene exactly. */
export interface ScenePatch {
  /** Short human-readable name shown in the history list, e.g. "Add atom". */
  readonly label: string;
  readonly atomsAdded: readonly Atom[];
  readonly atomsRemoved: readonly Atom[];
  readonly atomsChanged: readonly AtomChange[];
  readonly bondsAdded: readonly Bond[];
  readonly bondsRemoved: readonly Bond[];
  readonly bondsChanged: readonly BondChange[];
  readonly nextAtomId: { readonly before: AtomId; readonly after: AtomId };
  readonly nextBondId: { readonly before: BondId; readonly after: BondId };
}
