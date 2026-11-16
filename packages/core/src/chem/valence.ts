import { findElement, getElement } from '../elements';
import { neighborsOf } from '../scene/queries';
import type { AtomId, BondId, Scene } from '../types';
import { atomCharge } from './atom';

/**
 * Total valences permitted for an atom of element `z` carrying formal charge `charge`, following
 * RDKit's valence model: a charged main-group atom is treated like the neutral element with the
 * same electron count (N+ behaves like C, O- like F). Returns `null` when the model places no
 * constraint (most metals, or charges that leave the period).
 */
export function allowedValences(z: number, charge: number): readonly number[] | null {
  const element = getElement(z);
  if (element.valenceUnconstrained) return null;
  if (charge === 0) return element.valences;
  if (z - charge === 0) return [0];
  const isoelectronic = findElement(z - charge);
  if (!isoelectronic || isoelectronic.period !== element.period || isoelectronic.valenceUnconstrained) return null;
  return isoelectronic.valences;
}

export type KekuleResult =
  | { readonly ok: true; readonly orders: ReadonlyMap<BondId, 1 | 2> }
  | { readonly ok: false; readonly orders: ReadonlyMap<BondId, 1 | 2>; readonly reason: string; readonly atoms: readonly AtomId[] };

const kekuleCache = new WeakMap<Scene, KekuleResult>();
const SEARCH_BUDGET = 400_000;

/**
 * Assigns alternating single and double bonds to every aromatic (order 1.5) bond so that each
 * aromatic atom reaches an allowed valence. Fails with an explanation when no assignment exists,
 * which means the aromatic bonds as drawn do not describe a valid structure.
 */
export function kekulize(scene: Scene): KekuleResult {
  const cached = kekuleCache.get(scene);
  if (cached) return cached;
  const result = computeKekule(scene);
  kekuleCache.set(scene, result);
  return result;
}

function computeKekule(scene: Scene): KekuleResult {
  const aromatic = new Map<AtomId, Array<{ atomId: AtomId; bondId: BondId }>>();
  for (const bond of scene.bonds.values()) {
    if (bond.order !== 1.5) continue;
    for (const [from, to] of [
      [bond.a, bond.b],
      [bond.b, bond.a],
    ] as const) {
      const list = aromatic.get(from);
      if (list) list.push({ atomId: to, bondId: bond.id });
      else aromatic.set(from, [{ atomId: to, bondId: bond.id }]);
    }
  }
  const orders = new Map<BondId, 1 | 2>();
  if (aromatic.size === 0) return { ok: true, orders };

  // An atom "must" receive one double bond when its valence without one is not allowed, and "can"
  // receive one only if that would land on an allowed valence.
  const must = new Set<AtomId>();
  const can = new Set<AtomId>();
  for (const atomId of aromatic.keys()) {
    const atom = scene.atoms.get(atomId)!;
    let base = 0;
    for (const n of neighborsOf(scene, atomId)) {
      const order = scene.bonds.get(n.bondId)!.order;
      base += order === 1.5 ? 1 : order;
    }
    const allowed = allowedValences(atom.protons, atomCharge(atom));
    if (allowed === null) {
      can.add(atomId);
      continue;
    }
    const needsMore = !allowed.includes(base) && allowed.some((v) => v > base);
    if (needsMore) must.add(atomId);
    if (needsMore || allowed.includes(base + 1)) can.add(atomId);
  }

  const partner = new Map<AtomId, { atomId: AtomId; bondId: BondId }>();
  let budget = SEARCH_BUDGET;

  const options = (atomId: AtomId) => aromatic.get(atomId)!.filter((n) => can.has(n.atomId) && !partner.has(n.atomId));

  const solve = (): boolean => {
    if (budget-- <= 0) return false;
    let next: AtomId | undefined;
    let fewest = Infinity;
    for (const atomId of must) {
      if (partner.has(atomId)) continue;
      const count = options(atomId).length;
      if (count < fewest) {
        fewest = count;
        next = atomId;
        if (count === 0) return false;
      }
    }
    if (next === undefined) return true;
    for (const choice of options(next)) {
      partner.set(next, choice);
      partner.set(choice.atomId, { atomId: next, bondId: choice.bondId });
      if (solve()) return true;
      partner.delete(next);
      partner.delete(choice.atomId);
    }
    return false;
  };

  const solved = solve();
  if (!solved) {
    return {
      ok: false,
      orders,
      reason:
        budget <= 0
          ? 'The aromatic system is too large to assign alternating single and double bonds within the search limit.'
          : 'The bonds marked aromatic cannot be assigned alternating single and double bonds that give every atom an allowed valence.',
      atoms: [...must].sort((a, b) => a - b),
    };
  }

  const doubles = new Set<BondId>();
  for (const link of partner.values()) doubles.add(link.bondId);
  for (const bond of scene.bonds.values()) {
    if (bond.order === 1.5) orders.set(bond.id, doubles.has(bond.id) ? 2 : 1);
  }
  return { ok: true, orders };
}

export type ValenceStatus = 'ok' | 'open' | 'exceeded' | 'unconstrained';

export interface AtomValence {
  readonly atomId: AtomId;
  /** Number of bonded neighbours. */
  readonly degree: number;
  /** Sum of bond orders, using the Kekule assignment for aromatic bonds. */
  readonly valence: number;
  readonly allowed: readonly number[] | null;
  readonly status: ValenceStatus;
  /** Valence still missing to reach the next allowed value: the number of hydrogens that would saturate the atom. */
  readonly open: number;
}

export interface ValenceAnalysis {
  readonly atoms: ReadonlyMap<AtomId, AtomValence>;
  readonly kekule: KekuleResult;
}

const valenceCache = new WeakMap<Scene, ValenceAnalysis>();

/** Valence bookkeeping for every atom. Rule-based: it mirrors RDKit's valence model but does not replace its sanitisation. */
export function analyseValences(scene: Scene): ValenceAnalysis {
  const cached = valenceCache.get(scene);
  if (cached) return cached;

  const kekule = kekulize(scene);
  const atoms = new Map<AtomId, AtomValence>();
  for (const atom of scene.atoms.values()) {
    const neighbors = neighborsOf(scene, atom.id);
    let sum = 0;
    for (const n of neighbors) {
      const order = scene.bonds.get(n.bondId)!.order;
      sum += order === 1.5 ? (kekule.orders.get(n.bondId) ?? 1.5) : order;
    }
    // Only reached with half-integer sums when kekulisation failed; round half down.
    const valence = Math.ceil(sum - 0.5 - 1e-9);
    const allowed = allowedValences(atom.protons, atomCharge(atom));

    let status: ValenceStatus;
    let open = 0;
    if (allowed === null) status = 'unconstrained';
    else if (allowed.includes(valence)) status = 'ok';
    else {
      const next = allowed.filter((v) => v > valence).sort((a, b) => a - b)[0];
      if (next === undefined) status = 'exceeded';
      else {
        status = 'open';
        open = next - valence;
      }
    }
    atoms.set(atom.id, { atomId: atom.id, degree: neighbors.length, valence, allowed, status, open });
  }

  const analysis = { atoms, kekule };
  valenceCache.set(scene, analysis);
  return analysis;
}
