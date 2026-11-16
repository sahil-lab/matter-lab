import { EMPTY_SCENE, editScene, sortedAtoms } from '@matterlab/core';
import type { AtomId, Scene, Vec3 } from '@matterlab/core';
import type { SpeciesStructure } from '../science/structures';

/**
 * The reaction chamber's population view.
 *
 * It is a picture of stoichiometry, not a simulation of molecules: the chamber holds a small,
 * fixed set of "reaction events", each a group of sites that shows either its reactant molecules
 * or its product molecules. How many groups have reacted follows the computed extent of reaction;
 * where molecules sit and how they are turned is arbitrary. Nothing here moves along a computed path.
 */

export interface ChamberSpecies {
  /** Formula with phase label, as in the balanced equation. */
  readonly key: string;
  readonly side: 'reactant' | 'product';
  readonly coefficient: number;
  readonly structure: SpeciesStructure | null;
}

export interface ChamberPlan {
  readonly species: readonly ChamberSpecies[];
  /** Number of reaction events the population can show. */
  readonly groups: number;
  /** Molecules of each species that take no part in the reaction events shown (an excess, or present from the start), by species key. */
  readonly excess: Readonly<Record<string, number>>;
  /** Species whose surplus had to be cut down to keep the chamber readable. */
  readonly capped: readonly string[];
  /** Species that cannot be drawn because no 3D model is available. */
  readonly undrawn: readonly string[];
  /** Site positions in angstrom, grouped: `groups` runs of `sitesPerGroup`, then the excess sites. */
  readonly sites: readonly Vec3[];
  readonly sitesPerGroup: number;
  /** The order in which groups react, so that conversions appear scattered through the chamber. */
  readonly order: readonly number[];
  readonly seed: number;
}

const MAX_MOLECULES_PER_SIDE = 60;
const MAX_GROUPS = 18;
const MAX_EXCESS_PER_SPECIES = 24;
/** Width to height of the slab of sites, chosen to suit a wide view. */
const SLAB_ASPECT = 1.35;

/** Small deterministic generator (mulberry32), so a chamber always looks the same for the same experiment. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Lays the chamber out. `excessPerEvent` gives, for each species, how many molecules there are
 * per reaction event beyond those the events themselves account for (0 for a stoichiometric
 * mixture with no products at the start).
 */
export function planChamber(species: readonly ChamberSpecies[], excessPerEvent: Readonly<Record<string, number>> = {}): ChamberPlan {
  const drawn = species.filter((s) => s.structure);
  const undrawn = species.filter((s) => !s.structure).map((s) => s.key);
  const perSide = (side: 'reactant' | 'product') => drawn.filter((s) => s.side === side).reduce((sum, s) => sum + Math.round(s.coefficient), 0);
  const sitesPerGroup = Math.max(1, perSide('reactant'), perSide('product'));
  const groups = Math.max(2, Math.min(MAX_GROUPS, Math.floor(MAX_MOLECULES_PER_SIDE / sitesPerGroup)));

  const excess: Record<string, number> = {};
  const capped: string[] = [];
  let excessSites = 0;
  // Molecules that take no part in the reaction events shown: reactants in excess, and products present from the start.
  for (const s of drawn) {
    const wanted = Math.round((excessPerEvent[s.key] ?? 0) * groups);
    const shown = Math.min(MAX_EXCESS_PER_SPECIES, Math.max(0, wanted));
    if (shown < wanted) capped.push(s.key);
    if (shown > 0) excess[s.key] = shown;
    excessSites += shown;
  }

  const seed = hash(species.map((s) => `${s.key}:${s.coefficient}:${s.side}`).join('|'));
  const next = random(seed);
  const extent = drawn.reduce((max, s) => Math.max(max, s.structure!.extent), 0);
  // Centre-to-centre distance that keeps the largest molecules apart by a little more than two van der Waals radii.
  const spacing = 2 * extent + 4.2;
  const total = groups * sitesPerGroup + excessSites;
  // A shallow slab facing the viewer: two layers at most, the back one behind the gaps of the front
  // one, so that every molecule can be seen and counted.
  const layers = total > 10 ? 2 : 1;
  const perLayer = Math.ceil(total / layers);
  const columns = Math.max(1, Math.ceil(Math.sqrt(perLayer * SLAB_ASPECT)));
  const rows = Math.ceil(perLayer / columns);
  const stagger = (layers - 1) * 0.5;
  const sites: Vec3[] = [];
  // Cells are filled row by row in serpentine order, front then back, which keeps consecutive
  // sites, and with them the molecules of one reaction event, next to each other.
  for (let cell = 0; sites.length < total; cell++) {
    const row = Math.floor(cell / columns);
    const column = row % 2 === 0 ? cell % columns : columns - 1 - (cell % columns);
    for (let layer = 0; layer < layers && sites.length < total; layer++) {
      const shift = layer * 0.5;
      sites.push([
        (column + shift - (columns - 1 + stagger) / 2) * spacing + (next() - 0.5) * spacing * 0.2,
        ((rows - 1 + stagger) / 2 - row - shift) * spacing + (next() - 0.5) * spacing * 0.2,
        (stagger - layer) * spacing * 0.85 + (next() - 0.5) * spacing * 0.4,
      ]);
    }
  }
  const order = Array.from({ length: groups }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return { species, groups, excess, capped, undrawn, sites, sitesPerGroup, order, seed };
}

function rotation(next: () => number): (p: Vec3) => Vec3 {
  // A uniformly random rotation from a random unit quaternion (Shoemake).
  const u1 = next();
  const u2 = next() * 2 * Math.PI;
  const u3 = next() * 2 * Math.PI;
  const a = Math.sqrt(1 - u1);
  const b = Math.sqrt(u1);
  const [x, y, z, w] = [a * Math.sin(u2), a * Math.cos(u2), b * Math.sin(u3), b * Math.cos(u3)];
  return ([px, py, pz]) => [
    (1 - 2 * (y * y + z * z)) * px + 2 * (x * y - z * w) * py + 2 * (x * z + y * w) * pz,
    2 * (x * y + z * w) * px + (1 - 2 * (x * x + z * z)) * py + 2 * (y * z - x * w) * pz,
    2 * (x * z - y * w) * px + 2 * (y * z + x * w) * py + (1 - 2 * (x * x + y * y)) * pz,
  ];
}

export interface ChamberScene {
  readonly scene: Scene;
  /** Which species each atom belongs to. */
  readonly speciesOfAtom: ReadonlyMap<AtomId, string>;
  /** Molecules drawn of each species. */
  readonly counts: Readonly<Record<string, number>>;
}

/** The chamber after `reacted` of its groups have turned from reactants into products. */
export function buildChamber(plan: ChamberPlan, reacted: number): ChamberScene {
  const done = new Set(plan.order.slice(0, Math.max(0, Math.min(plan.groups, Math.round(reacted)))));
  const drawn = plan.species.filter((s) => s.structure);
  const speciesOfAtom = new Map<AtomId, string>();
  const counts: Record<string, number> = {};
  for (const s of plan.species) counts[s.key] = 0;

  const { scene } = editScene(EMPTY_SCENE, 'Reaction chamber', (editor) => {
    const place = (species: ChamberSpecies, siteIndex: number) => {
      const site = plan.sites[siteIndex];
      if (!site || !species.structure) return;
      // Orientation depends on the site and the species only, so a molecule never spins as time is scrubbed.
      const turn = rotation(random(plan.seed ^ Math.imul(siteIndex + 1, 2654435761) ^ hash(species.key)));
      const ids = new Map<AtomId, AtomId>();
      for (const atom of sortedAtoms(species.structure.scene)) {
        const [x, y, z] = turn(atom.position);
        const id = editor.addAtom({ protons: atom.protons, neutrons: atom.neutrons, electrons: atom.electrons, position: [x + site[0], y + site[1], z + site[2]] });
        ids.set(atom.id, id);
        speciesOfAtom.set(id, species.key);
      }
      for (const bond of species.structure.scene.bonds.values()) editor.addBond(ids.get(bond.a)!, ids.get(bond.b)!, bond.order);
      counts[species.key] = (counts[species.key] ?? 0) + 1;
    };

    for (let group = 0; group < plan.groups; group++) {
      const side = done.has(group) ? 'product' : 'reactant';
      let slot = group * plan.sitesPerGroup;
      for (const species of drawn) {
        if (species.side !== side) continue;
        for (let k = 0; k < Math.round(species.coefficient); k++) place(species, slot++);
      }
    }
    let slot = plan.groups * plan.sitesPerGroup;
    for (const species of drawn) {
      const extra = plan.excess[species.key] ?? 0;
      for (let k = 0; k < extra; k++) place(species, slot++);
    }
  });
  return { scene, speciesOfAtom, counts };
}
