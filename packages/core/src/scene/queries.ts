import type { Atom, AtomId, Bond, BondId, Scene, Vec3 } from '../types';
import { vdist } from '../vec3';

export interface Neighbor {
  readonly atomId: AtomId;
  readonly bondId: BondId;
}

export type Adjacency = ReadonlyMap<AtomId, readonly Neighbor[]>;

const adjacencyCache = new WeakMap<Scene, Adjacency>();

/** Bonded neighbours of every atom. Scenes are immutable, so the result is computed once per scene. */
export function getAdjacency(scene: Scene): Adjacency {
  let adjacency = adjacencyCache.get(scene);
  if (!adjacency) {
    const map = new Map<AtomId, Neighbor[]>();
    for (const id of scene.atoms.keys()) map.set(id, []);
    for (const bond of scene.bonds.values()) {
      map.get(bond.a)?.push({ atomId: bond.b, bondId: bond.id });
      map.get(bond.b)?.push({ atomId: bond.a, bondId: bond.id });
    }
    adjacency = map;
    adjacencyCache.set(scene, adjacency);
  }
  return adjacency;
}

export function neighborsOf(scene: Scene, atomId: AtomId): readonly Neighbor[] {
  return getAdjacency(scene).get(atomId) ?? [];
}

/**
 * Lets `to` reuse the adjacency already worked out for `from`. Only valid when both scenes hold
 * the same atoms and the same bonds between the same atoms, as after a move or a change of
 * element, charge or bond order. It spares a pass over the whole structure on every such edit.
 */
export function inheritAdjacency(from: Scene, to: Scene): void {
  const adjacency = adjacencyCache.get(from);
  if (adjacency) adjacencyCache.set(to, adjacency);
}

export function bondBetween(scene: Scene, a: AtomId, b: AtomId): Bond | undefined {
  const link = neighborsOf(scene, a).find((n) => n.atomId === b);
  return link ? scene.bonds.get(link.bondId) : undefined;
}

/** Atoms in creation order. Ids only ever grow, so this order is stable across undo and redo. */
export function sortedAtoms(scene: Scene): Atom[] {
  return [...scene.atoms.values()].sort((a, b) => a.id - b.id);
}

export function sortedBonds(scene: Scene): Bond[] {
  return [...scene.bonds.values()].sort((a, b) => a.id - b.id);
}

/** All atoms connected to `start` through bonds, including `start` itself. */
export function fragmentOf(scene: Scene, start: AtomId): Set<AtomId> {
  const seen = new Set<AtomId>();
  if (!scene.atoms.has(start)) return seen;
  const adjacency = getAdjacency(scene);
  const stack = [start];
  seen.add(start);
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const n of adjacency.get(current) ?? []) {
      if (!seen.has(n.atomId)) {
        seen.add(n.atomId);
        stack.push(n.atomId);
      }
    }
  }
  return seen;
}

/** Connected components (molecules and lone atoms), each sorted by id, ordered by their smallest id. */
export function fragments(scene: Scene): AtomId[][] {
  const result: AtomId[][] = [];
  const seen = new Set<AtomId>();
  for (const atom of sortedAtoms(scene)) {
    if (seen.has(atom.id)) continue;
    const component = fragmentOf(scene, atom.id);
    for (const id of component) seen.add(id);
    result.push([...component].sort((a, b) => a - b));
  }
  return result;
}

/**
 * The atoms on the `to` side of the bond `from`-`to`: everything reachable from `to` without
 * crossing that bond. Returns `null` when `from` is reachable anyway, i.e. the bond is part of a
 * ring and the molecule cannot be split there.
 */
export function sideOfBond(scene: Scene, from: AtomId, to: AtomId): Set<AtomId> | null {
  const adjacency = getAdjacency(scene);
  const seen = new Set<AtomId>([to]);
  const stack = [to];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const n of adjacency.get(current) ?? []) {
      if (current === to && n.atomId === from) continue;
      if (n.atomId === from) return null;
      if (!seen.has(n.atomId)) {
        seen.add(n.atomId);
        stack.push(n.atomId);
      }
    }
  }
  return seen;
}

export function isBondInRing(scene: Scene, bond: Bond): boolean {
  return sideOfBond(scene, bond.a, bond.b) === null;
}

export interface BoundingSphere {
  readonly center: Vec3;
  readonly radius: number;
}

/**
 * A sphere enclosing the given atoms (all atoms when `ids` is omitted). `padding` is added around
 * each atom centre, typically an atomic radius. Returns `null` for an empty selection.
 */
export function boundingSphere(scene: Scene, ids?: Iterable<AtomId>, padding = 0): BoundingSphere | null {
  const points: Vec3[] = [];
  if (ids) {
    for (const id of ids) {
      const atom = scene.atoms.get(id);
      if (atom) points.push(atom.position);
    }
  } else {
    for (const atom of scene.atoms.values()) points.push(atom.position);
  }
  if (points.length === 0) return null;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const p of points) {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[2] < minZ) minZ = p[2];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
    if (p[2] > maxZ) maxZ = p[2];
  }
  const center: Vec3 = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
  let radius = 0;
  for (const p of points) radius = Math.max(radius, vdist(p, center));
  return { center, radius: radius + padding };
}
