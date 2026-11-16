import { describe, expect, it } from 'vitest';
import {
  EMPTY_HISTORY,
  EMPTY_SCENE,
  SceneEditError,
  SceneEditor,
  applyPatch,
  bondBetween,
  boundingSphere,
  editScene,
  fragmentOf,
  fragments,
  getAdjacency,
  invertPatch,
  isBondInRing,
  isEmptyPatch,
  neighborsOf,
  patchChangesTopology,
  recordPatch,
  redo,
  serializeScene,
  sideOfBond,
  undo,
} from '../src';
import type { BondOrder, History, Scene } from '../src';
import { build, seededRandom } from './helpers';

describe('scene editing', () => {
  it('keeps the bonded-neighbour table across edits that leave the bonding as it is, and only across those', () => {
    const water = build((e) => {
      const o = e.addAtom({ protons: 8, position: [0, 0, 0] });
      e.addBond(o, e.addAtom({ protons: 1, position: [0.96, 0, 0] }), 1);
      e.addBond(o, e.addAtom({ protons: 1, position: [-0.24, 0.93, 0] }), 1);
    });
    const table = getAdjacency(water);
    const ids = (scene: Scene, atom: number) => neighborsOf(scene, atom).map((n) => n.atomId);

    // Moving an atom or changing what it is does not change who is bonded to whom: the table is reused.
    const moved = editScene(water, 'move', (e) => e.moveAtom(2, [1.4, 0.2, 0])).scene;
    expect(getAdjacency(moved)).toBe(table);
    const altered = editScene(moved, 'alter', (e) => e.updateAtom(1, { protons: 16 })).scene;
    expect(getAdjacency(altered)).toBe(table);
    expect(ids(altered, 1)).toEqual([2, 3]);

    // Removing a bond does: a table of its own, and the right one.
    const cut = editScene(altered, 'cut', (e) => e.removeBond(1));
    expect(getAdjacency(cut.scene)).not.toBe(table);
    expect(ids(cut.scene, 1)).toEqual([3]);
    expect(ids(cut.scene, 2)).toEqual([]);
    // Undoing the cut restores the bond, so again a new table; the earlier scenes are untouched.
    const restored = applyPatch(cut.scene, invertPatch(cut.patch));
    expect(ids(restored, 1).sort()).toEqual([2, 3]);
    expect(ids(restored, 2)).toEqual([1]);
    expect(ids(water, 1)).toEqual([2, 3]);
    // Undoing a move goes through the same route and keeps the table.
    const move = editScene(restored, 'move again', (e) => e.moveAtom(3, [0, 1, 0]));
    const before = getAdjacency(move.scene);
    expect(getAdjacency(applyPatch(move.scene, invertPatch(move.patch)))).toBe(before);
  });

  it('adds atoms as neutral, isotope-unspecified by default', () => {
    const scene = build((e) => {
      e.addAtom({ protons: 6, position: [1, 2, 3] });
    });
    const atom = scene.atoms.get(1)!;
    expect(atom).toEqual({ id: 1, protons: 6, neutrons: null, electrons: 6, position: [1, 2, 3] });
    expect(scene.nextAtomId).toBe(2);
  });

  it('derives the electron count from a requested charge', () => {
    const scene = build((e) => {
      e.addAtom({ protons: 11, charge: 1, position: [0, 0, 0] });
      e.addAtom({ protons: 17, charge: -1, position: [2, 0, 0] });
      e.addAtom({ protons: 8, electrons: 10, neutrons: 10, position: [4, 0, 0] });
    });
    expect(scene.atoms.get(1)!.electrons).toBe(10);
    expect(scene.atoms.get(2)!.electrons).toBe(18);
    expect(scene.atoms.get(3)).toMatchObject({ electrons: 10, neutrons: 10 });
  });

  it('never mutates the scene it started from', () => {
    const before = build((e) => {
      const a = e.addAtom({ protons: 6, position: [0, 0, 0] });
      const b = e.addAtom({ protons: 8, position: [1.2, 0, 0] });
      e.addBond(a, b, 2);
    });
    const snapshot = JSON.stringify(serializeScene(before));
    const { scene: after } = editScene(before, 'change', (e) => {
      e.moveAtom(1, [5, 5, 5]);
      e.setBondOrder(1, 1);
      e.addAtom({ protons: 1, position: [0, 1, 0] });
      e.removeAtom(2);
    });
    expect(JSON.stringify(serializeScene(before))).toBe(snapshot);
    expect(after).not.toBe(before);
    expect(after.atoms.size).toBe(2);
    expect(after.bonds.size).toBe(0);
  });

  it('removes attached bonds when an atom is removed', () => {
    const scene = build((e) => {
      const c = e.addAtom({ protons: 6, position: [0, 0, 0] });
      for (let i = 0; i < 4; i++) e.addBond(c, e.addAtom({ protons: 1, position: [i + 1, 0, 0] }));
    });
    const { scene: after, patch } = editScene(scene, 'Delete atom', (e) => e.removeAtom(1));
    expect(after.atoms.size).toBe(4);
    expect(after.bonds.size).toBe(0);
    expect(patch.atomsRemoved).toHaveLength(1);
    expect(patch.bondsRemoved).toHaveLength(4);
  });

  it('keeps at most one bond between two atoms', () => {
    const scene = build((e) => {
      const a = e.addAtom({ protons: 6, position: [0, 0, 0] });
      const b = e.addAtom({ protons: 6, position: [1.3, 0, 0] });
      const first = e.addBond(a, b, 1);
      const second = e.addBond(b, a, 2);
      expect(second).toBe(first);
    });
    expect(scene.bonds.size).toBe(1);
    expect(scene.bonds.get(1)!.order).toBe(2);
  });

  it('never reuses ids, even after deletions', () => {
    let scene = build((e) => {
      e.addAtom({ protons: 1, position: [0, 0, 0] });
      e.addAtom({ protons: 1, position: [1, 0, 0] });
    });
    scene = editScene(scene, 'delete', (e) => e.removeAtom(2)).scene;
    scene = editScene(scene, 'add', (e) => {
      expect(e.addAtom({ protons: 1, position: [2, 0, 0] })).toBe(3);
    }).scene;
    expect([...scene.atoms.keys()].sort()).toEqual([1, 3]);
  });

  it('rejects edits that cannot describe matter', () => {
    const editor = new SceneEditor(EMPTY_SCENE);
    const a = editor.addAtom({ protons: 6, position: [0, 0, 0] });
    expect(() => editor.addAtom({ protons: 0, position: [0, 0, 0] })).toThrow(SceneEditError);
    expect(() => editor.addAtom({ protons: 119, position: [0, 0, 0] })).toThrow(/known element/);
    expect(() => editor.addAtom({ protons: 6, neutrons: -1, position: [0, 0, 0] })).toThrow(SceneEditError);
    expect(() => editor.addAtom({ protons: 6, electrons: -1, position: [0, 0, 0] })).toThrow(SceneEditError);
    expect(() => editor.addAtom({ protons: 6, electrons: 1.5, position: [0, 0, 0] })).toThrow(SceneEditError);
    expect(() => editor.addAtom({ protons: 6, position: [Number.NaN, 0, 0] })).toThrow(/finite/);
    expect(() => editor.addBond(a, a)).toThrow(/itself/);
    expect(() => editor.addBond(a, 99)).toThrow(/does not exist/);
    expect(() => editor.addBond(a, a + 1, 4 as BondOrder)).toThrow(SceneEditError);
    expect(() => editor.updateAtom(a, { protons: 200 })).toThrow(SceneEditError);
    expect(() => editor.removeAtom(42)).toThrow(SceneEditError);
    // The failed edits left nothing behind.
    expect(editor.commit('x').scene.atoms.size).toBe(1);
  });

  it('produces an empty patch, and the same scene object, when nothing really changed', () => {
    const scene = build((e) => {
      e.addAtom({ protons: 6, position: [0, 0, 0] });
    });
    const { scene: after, patch } = editScene(scene, 'noop', (e) => {
      e.moveAtom(1, [0, 0, 0]);
      const temp = e.addAtom({ protons: 1, position: [1, 1, 1] });
      e.removeAtom(temp);
    });
    expect(isEmptyPatch(patch)).toBe(true);
    expect(after).toBe(scene);
    expect(after.nextAtomId).toBe(2);
  });

  it('distinguishes topology changes from pure moves', () => {
    const scene = build((e) => {
      e.addBond(e.addAtom({ protons: 6, position: [0, 0, 0] }), e.addAtom({ protons: 6, position: [1.5, 0, 0] }));
    });
    expect(patchChangesTopology(editScene(scene, 'move', (e) => e.moveAtom(1, [0, 1, 0])).patch)).toBe(false);
    expect(patchChangesTopology(editScene(scene, 'element', (e) => e.updateAtom(1, { protons: 7 })).patch)).toBe(false);
    expect(patchChangesTopology(editScene(scene, 'order', (e) => e.setBondOrder(1, 2)).patch)).toBe(true);
    expect(patchChangesTopology(editScene(scene, 'add', (e) => void e.addAtom({ protons: 1, position: [3, 0, 0] })).patch)).toBe(true);
  });
});

describe('patches and history', () => {
  it('applying a patch and then its inverse restores the scene exactly', () => {
    const base = build((e) => {
      const a = e.addAtom({ protons: 6, position: [0, 0, 0] });
      const b = e.addAtom({ protons: 7, position: [1.4, 0, 0] });
      e.addBond(a, b, 3);
    });
    const { scene: next, patch } = editScene(base, 'mixed edit', (e) => {
      e.updateAtom(1, { protons: 8, electrons: 9, neutrons: 10, position: [0, 0.5, 0] });
      e.setBondOrder(1, 2);
      const h = e.addAtom({ protons: 1, position: [-1, 0, 0] });
      e.addBond(1, h);
    });
    expect(serializeScene(applyPatch(base, patch))).toEqual(serializeScene(next));
    expect(serializeScene(applyPatch(next, invertPatch(patch)))).toEqual(serializeScene(base));
    expect(invertPatch(invertPatch(patch))).toEqual(patch);
  });

  it('undoes and redoes a long random editing session step by step', () => {
    const random = seededRandom(20261113);
    const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]!;
    const orders: BondOrder[] = [1, 1.5, 2, 3];

    let scene: Scene = EMPTY_SCENE;
    let history: History = EMPTY_HISTORY;
    const states = [serializeScene(scene)];

    for (let step = 0; step < 300; step++) {
      const result = editScene(scene, `step ${step}`, (e) => {
        const atoms = [...e.allAtoms()].map((a) => a.id);
        const bonds = [...e.allBonds()].map((b) => b.id);
        const roll = random();
        if (atoms.length < 3 || roll < 0.3) {
          e.addAtom({ protons: 1 + Math.floor(random() * 118), position: [random() * 10, random() * 10, random() * 10] });
        } else if (roll < 0.45) {
          e.moveAtom(pick(atoms), [random() * 10, random() * 10, random() * 10]);
        } else if (roll < 0.6) {
          const a = pick(atoms);
          const b = pick(atoms);
          if (a !== b) e.addBond(a, b, pick(orders));
        } else if (roll < 0.7 && bonds.length > 0) {
          e.setBondOrder(pick(bonds), pick(orders));
        } else if (roll < 0.8 && bonds.length > 0) {
          e.removeBond(pick(bonds));
        } else if (roll < 0.9) {
          e.removeAtom(pick(atoms));
        } else {
          const id = pick(atoms);
          const z = 1 + Math.floor(random() * 118);
          e.updateAtom(id, { protons: z, electrons: Math.floor(random() * 120), neutrons: random() < 0.5 ? null : Math.floor(random() * 180) });
        }
      });
      if (isEmptyPatch(result.patch)) continue;
      scene = result.scene;
      history = recordPatch(history, result.patch);
      states.push(serializeScene(scene));
    }
    expect(states.length).toBeGreaterThan(200);

    for (let i = states.length - 2; i >= 0; i--) {
      const step = undo(scene, history)!;
      scene = step.scene;
      history = step.history;
      expect(serializeScene(scene)).toEqual(states[i]);
    }
    expect(undo(scene, history)).toBeNull();
    expect(scene.atoms.size).toBe(0);

    for (let i = 1; i < states.length; i++) {
      const step = redo(scene, history)!;
      scene = step.scene;
      history = step.history;
      expect(serializeScene(scene)).toEqual(states[i]);
    }
    expect(redo(scene, history)).toBeNull();
  });

  it('discards redo steps once a new edit is made, and ignores empty patches', () => {
    let scene: Scene = EMPTY_SCENE;
    let history: History = EMPTY_HISTORY;
    for (const z of [1, 6, 8]) {
      const r = editScene(scene, 'add', (e) => void e.addAtom({ protons: z, position: [z, 0, 0] }));
      scene = r.scene;
      history = recordPatch(history, r.patch);
    }
    const undone = undo(scene, history)!;
    expect(undone.history.future).toHaveLength(1);

    const fresh = editScene(undone.scene, 'add', (e) => void e.addAtom({ protons: 7, position: [0, 1, 0] }));
    const after = recordPatch(undone.history, fresh.patch);
    expect(after.future).toHaveLength(0);
    expect(after.past).toHaveLength(3);

    const noop = editScene(fresh.scene, 'noop', () => {});
    expect(recordPatch(after, noop.patch)).toBe(after);
  });

  it('caps the number of undo steps it keeps', () => {
    let scene: Scene = EMPTY_SCENE;
    let history: History = EMPTY_HISTORY;
    for (let i = 0; i < 12; i++) {
      const r = editScene(scene, `add ${i}`, (e) => void e.addAtom({ protons: 1, position: [i, 0, 0] }));
      scene = r.scene;
      history = recordPatch(history, r.patch, 5);
    }
    expect(history.past).toHaveLength(5);
    expect(history.past[0]!.label).toBe('add 7');
  });
});

describe('scene queries', () => {
  // Ethanol skeleton plus a separate water: C1-C2-O3, O4 alone; then a three-membered ring 5-6-7.
  const scene = build((e) => {
    const c1 = e.addAtom({ protons: 6, position: [0, 0, 0] });
    const c2 = e.addAtom({ protons: 6, position: [1.5, 0, 0] });
    const o3 = e.addAtom({ protons: 8, position: [2.2, 1.2, 0] });
    e.addAtom({ protons: 8, position: [10, 0, 0] });
    e.addBond(c1, c2);
    e.addBond(c2, o3);
    const r1 = e.addAtom({ protons: 6, position: [0, 5, 0] });
    const r2 = e.addAtom({ protons: 6, position: [1.5, 5, 0] });
    const r3 = e.addAtom({ protons: 6, position: [0.75, 6.3, 0] });
    e.addBond(r1, r2);
    e.addBond(r2, r3);
    e.addBond(r3, r1);
    e.addBond(r1, e.addAtom({ protons: 1, position: [-1, 4.5, 0] }));
  });

  it('finds neighbours, bonds and connected fragments', () => {
    expect(neighborsOf(scene, 2).map((n) => n.atomId).sort()).toEqual([1, 3]);
    expect(bondBetween(scene, 1, 2)?.id).toBe(1);
    expect(bondBetween(scene, 1, 3)).toBeUndefined();
    expect(fragments(scene)).toEqual([[1, 2, 3], [4], [5, 6, 7, 8]]);
    expect([...fragmentOf(scene, 3)].sort()).toEqual([1, 2, 3]);
    expect(fragmentOf(scene, 999).size).toBe(0);
  });

  it('splits a molecule at an acyclic bond but refuses to split a ring', () => {
    expect([...sideOfBond(scene, 1, 2)!].sort()).toEqual([2, 3]);
    expect([...sideOfBond(scene, 2, 1)!]).toEqual([1]);
    expect(sideOfBond(scene, 5, 6)).toBeNull();
    expect(isBondInRing(scene, scene.bonds.get(3)!)).toBe(true);
    expect(isBondInRing(scene, scene.bonds.get(1)!)).toBe(false);
    expect([...sideOfBond(scene, 5, 8)!]).toEqual([8]);
  });

  it('computes a bounding sphere that contains every requested atom', () => {
    const sphere = boundingSphere(scene, [1, 2, 3], 0.5)!;
    for (const id of [1, 2, 3]) {
      const p = scene.atoms.get(id)!.position;
      expect(Math.hypot(p[0] - sphere.center[0], p[1] - sphere.center[1], p[2] - sphere.center[2])).toBeLessThanOrEqual(sphere.radius - 0.5 + 1e-9);
    }
    expect(boundingSphere(EMPTY_SCENE)).toBeNull();
    expect(boundingSphere(scene)!.radius).toBeGreaterThan(4);
  });
});
