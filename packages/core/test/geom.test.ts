import { describe, expect, it } from 'vitest';
import {
  EXAMPLES,
  EXAMPLE_PROVENANCE,
  addHydrogens,
  angleDegrees,
  dihedralDegrees,
  editScene,
  exampleScene,
  findExample,
  measurePoints,
  neighborsOf,
  rotateAtoms,
  serializeScene,
  setAngle,
  setDihedral,
  setDistance,
  translateAtoms,
  vdist,
} from '../src';
import type { AtomId, Scene, Vec3 } from '../src';
import { atomsOfElement, build, positionOf } from './helpers';

function bondLengths(scene: Scene): number[] {
  return [...scene.bonds.values()].sort((a, b) => a.id - b.id).map((b) => vdist(positionOf(scene, b.a), positionOf(scene, b.b)));
}

function expectSameBondLengths(a: Scene, b: Scene): void {
  const la = bondLengths(a);
  const lb = bondLengths(b);
  expect(lb).toHaveLength(la.length);
  la.forEach((l, i) => expect(lb[i]).toBeCloseTo(l, 9));
}

const hydrogensOn = (scene: Scene, atom: AtomId) =>
  neighborsOf(scene, atom).map((n) => n.atomId).filter((id) => scene.atoms.get(id)!.protons === 1);

/** Ethane built from a C-C skeleton with idealised, staggered hydrogens. */
function ethane(): Scene {
  const skeleton = build((e) => {
    e.addBond(e.addAtom({ protons: 6, position: [0, 0, 0] }), e.addAtom({ protons: 6, position: [1.52, 0, 0] }));
  });
  return editScene(skeleton, 'H', (e) => void addHydrogens(e)).scene;
}

describe('measurements', () => {
  it('measures distances and angles', () => {
    expect(measurePoints([[0, 0, 0], [3, 4, 0]])).toEqual({ kind: 'distance', value: 5, unit: 'Å' });
    expect(angleDegrees([1, 0, 0], [0, 0, 0], [0, 1, 0])).toBeCloseTo(90, 12);
    expect(angleDegrees([1, 0, 0], [0, 0, 0], [-1, 0, 0])).toBeCloseTo(180, 12);
    expect(measurePoints([[1, 0, 0], [0, 0, 0], [1, 1, 0]])!.value).toBeCloseTo(45, 12);
    expect(measurePoints([[0, 0, 0]])).toBeNull();
    expect(measurePoints([])).toBeNull();
  });

  it('follows the IUPAC sign convention for dihedral angles', () => {
    const b: Vec3 = [0, 0, 0];
    const c: Vec3 = [0, 0, 1];
    const a: Vec3 = [1, 0, 0];
    // Looking from b towards c (along +z), turning from +x to +y is clockwise, which is positive.
    expect(dihedralDegrees(a, b, c, [0, 1, 1])).toBeCloseTo(90, 12);
    expect(dihedralDegrees(a, b, c, [0, -1, 1])).toBeCloseTo(-90, 12);
    expect(dihedralDegrees(a, b, c, [1, 0, 1])).toBeCloseTo(0, 12);
    expect(Math.abs(dihedralDegrees(a, b, c, [-1, 0, 1]))).toBeCloseTo(180, 12);
    // Reversing the order of the four atoms leaves a dihedral unchanged.
    expect(dihedralDegrees([0, 1, 1], c, b, a)).toBeCloseTo(90, 12);
    expect(measurePoints([a, b, c, [0, 1, 1]])).toMatchObject({ kind: 'dihedral', unit: '°' });
  });

  it('finds chemically sensible geometry in the built-in molecules', () => {
    const water = exampleScene(findExample('water')!);
    const o = atomsOfElement(water, 8)[0]!;
    const [h1, h2] = atomsOfElement(water, 1);
    const hoh = angleDegrees(positionOf(water, h1!), positionOf(water, o), positionOf(water, h2!));
    expect(hoh).toBeGreaterThan(100);
    expect(hoh).toBeLessThan(110);
    expect(vdist(positionOf(water, o), positionOf(water, h1!))).toBeGreaterThan(0.93);
    expect(vdist(positionOf(water, o), positionOf(water, h1!))).toBeLessThan(1.0);

    const methane = exampleScene(findExample('methane')!);
    const c = atomsOfElement(methane, 6)[0]!;
    const hs = atomsOfElement(methane, 1);
    for (let i = 0; i < 4; i++) {
      expect(vdist(positionOf(methane, c), positionOf(methane, hs[i]!))).toBeCloseTo(1.09, 1);
      for (let j = i + 1; j < 4; j++) {
        expect(angleDegrees(positionOf(methane, hs[i]!), positionOf(methane, c), positionOf(methane, hs[j]!))).toBeCloseTo(109.47, 0);
      }
    }

    const benzene = exampleScene(findExample('benzene')!);
    const ringBonds = [...benzene.bonds.values()].filter((bond) => bond.order === 1.5);
    expect(ringBonds).toHaveLength(6);
    for (const bond of ringBonds) {
      const length = vdist(positionOf(benzene, bond.a), positionOf(benzene, bond.b));
      expect(length).toBeGreaterThan(1.38);
      expect(length).toBeLessThan(1.41);
    }
    // All twelve atoms of benzene lie in one plane.
    const zs = [...benzene.atoms.values()].map((atom) => atom.position);
    const carbons = atomsOfElement(benzene, 6).map((id) => positionOf(benzene, id));
    for (const p of zs) expect(Math.abs(dihedralDegrees(carbons[0]!, carbons[1]!, carbons[2]!, p)) % 180).toBeLessThan(0.5);

    const co2 = exampleScene(findExample('carbon-dioxide')!);
    const [o1, o2] = atomsOfElement(co2, 8);
    expect(angleDegrees(positionOf(co2, o1!), positionOf(co2, atomsOfElement(co2, 6)[0]!), positionOf(co2, o2!))).toBeCloseTo(180, 1);
  });

  it('ships examples with stated provenance and structures centred on the origin', () => {
    expect(EXAMPLES.map((e) => e.id)).toEqual(expect.arrayContaining(['water', 'methane', 'benzene']));
    expect(new Set(EXAMPLES.map((e) => e.id)).size).toBe(EXAMPLES.length);
    expect(EXAMPLE_PROVENANCE.source).toMatch(/MMFF94/);
    expect(EXAMPLE_PROVENANCE.version).toMatch(/RDKit/);
    for (const example of EXAMPLES) {
      const scene = exampleScene(example);
      const n = scene.atoms.size;
      const centroid = [0, 1, 2].map((k) => [...scene.atoms.values()].reduce((s, a) => s + a.position[k]!, 0) / n);
      for (const component of centroid) expect(Math.abs(component), example.id).toBeLessThan(0.75);
      expect(scene.bonds.size).toBe(example.bonds.length);
    }
  });
});

describe('precise geometry edits', () => {
  it('sets a bond length by moving one side of the molecule rigidly', () => {
    const start = ethane();
    const { scene } = editScene(start, 'Set distance', (e) => {
      expect(setDistance(e, 1, 2, 2.0)).toEqual({ ok: true, moved: 4 });
    });
    expect(vdist(positionOf(scene, 1), positionOf(scene, 2))).toBeCloseTo(2.0, 12);
    // The hydrogens on carbon 2 travelled with it; those on carbon 1 stayed put.
    for (const h of hydrogensOn(start, 2)) expect(vdist(positionOf(scene, 2), positionOf(scene, h))).toBeCloseTo(vdist(positionOf(start, 2), positionOf(start, h)), 12);
    for (const h of hydrogensOn(start, 1)) expect(positionOf(scene, h)).toEqual(positionOf(start, h));
    expect(positionOf(scene, 1)).toEqual(positionOf(start, 1));
  });

  it('moves only the picked atom when the bond is in a ring, and a whole molecule when the atoms are unconnected', () => {
    const benzene = exampleScene(findExample('benzene')!);
    const bond = [...benzene.bonds.values()].find((b) => b.order === 1.5)!;
    editScene(benzene, 'ring', (e) => expect(setDistance(e, bond.a, bond.b, 1.6)).toEqual({ ok: true, moved: 1 }));

    const two = build((e) => {
      const o = e.addAtom({ protons: 8, position: [0, 0, 0] });
      e.addBond(o, e.addAtom({ protons: 1, position: [0.96, 0, 0] }));
      const o2 = e.addAtom({ protons: 8, position: [3, 0, 0] });
      e.addBond(o2, e.addAtom({ protons: 1, position: [3.96, 0, 0] }));
    });
    const { scene } = editScene(two, 'separate', (e) => expect(setDistance(e, 1, 3, 5)).toEqual({ ok: true, moved: 2 }));
    expect(vdist(positionOf(scene, 1), positionOf(scene, 3))).toBeCloseTo(5, 12);
    expect(vdist(positionOf(scene, 3), positionOf(scene, 4))).toBeCloseTo(0.96, 12);

    editScene(two, 'bad', (e) => {
      expect(setDistance(e, 1, 3, 0).ok).toBe(false);
      expect(setDistance(e, 1, 1, 2).ok).toBe(false);
    });
  });

  it('sets a bond angle without changing bond lengths', () => {
    const water = exampleScene(findExample('water')!);
    const o = atomsOfElement(water, 8)[0]!;
    const [h1, h2] = atomsOfElement(water, 1) as [AtomId, AtomId];
    for (const target of [90, 104.5, 120, 180, 60]) {
      const { scene } = editScene(water, 'Set angle', (e) => expect(setAngle(e, h1, o, h2, target).ok).toBe(true));
      expect(angleDegrees(positionOf(scene, h1), positionOf(scene, o), positionOf(scene, h2))).toBeCloseTo(target, 9);
      expectSameBondLengths(water, scene);
      expect(positionOf(scene, h1)).toEqual(positionOf(water, h1));
    }
    editScene(water, 'bad', (e) => {
      expect(setAngle(e, h1, o, h2, 200).ok).toBe(false);
      expect(setAngle(e, h1, o, h1, 100).ok).toBe(false);
    });
  });

  it('opens a straight angle by choosing a perpendicular axis', () => {
    const co2 = exampleScene(findExample('carbon-dioxide')!);
    const c = atomsOfElement(co2, 6)[0]!;
    const [o1, o2] = atomsOfElement(co2, 8) as [AtomId, AtomId];
    const { scene } = editScene(co2, 'bend', (e) => expect(setAngle(e, o1, c, o2, 120).ok).toBe(true));
    expect(angleDegrees(positionOf(scene, o1), positionOf(scene, c), positionOf(scene, o2))).toBeCloseTo(120, 6);
    expectSameBondLengths(co2, scene);
  });

  it('rotates about a bond to reach any dihedral angle, preserving bond lengths and angles', () => {
    const start = ethane();
    const h1 = hydrogensOn(start, 1)[0]!;
    const h2 = hydrogensOn(start, 2)[0]!;
    const hcc = angleDegrees(positionOf(start, h1), positionOf(start, 1), positionOf(start, 2));
    for (const target of [0, 45, -60, 120, 180, -170]) {
      const { scene } = editScene(start, 'Set dihedral', (e) => {
        expect(setDihedral(e, h1, 1, 2, h2, target)).toEqual({ ok: true, moved: 4 });
      });
      const actual = dihedralDegrees(positionOf(scene, h1), positionOf(scene, 1), positionOf(scene, 2), positionOf(scene, h2));
      const difference = ((((actual - target + 180) % 360) + 360) % 360) - 180;
      expect(difference).toBeCloseTo(0, 8);
      expectSameBondLengths(start, scene);
      expect(angleDegrees(positionOf(scene, h2), positionOf(scene, 2), positionOf(scene, 1))).toBeCloseTo(hcc, 6);
      // Carbon 1 and its hydrogens are the fixed side.
      for (const id of [1, 2, ...hydrogensOn(start, 1)]) expect(vdist(positionOf(scene, id), positionOf(start, id))).toBeLessThan(1e-12);
    }
  });

  it('rejects undefined dihedrals and repeated atoms', () => {
    const co2 = exampleScene(findExample('carbon-dioxide')!);
    const c = atomsOfElement(co2, 6)[0]!;
    const [o1, o2] = atomsOfElement(co2, 8) as [AtomId, AtomId];
    const withH = editScene(co2, 'h', (e) => void e.addBond(o2, e.addAtom({ protons: 1, position: [9, 9, 9] }))).scene;
    const h = atomsOfElement(withH, 1)[0]!;
    editScene(withH, 'bad', (e) => {
      const result = setDihedral(e, o1, c, o2, h, 90);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/straight line/);
      expect(setDihedral(e, o1, c, o2, o1, 90).ok).toBe(false);
    });
  });

  it('translates and rotates groups of atoms as rigid bodies', () => {
    const water = exampleScene(findExample('water')!);
    const ids = [...water.atoms.keys()];
    const { scene: moved } = editScene(water, 'move', (e) => translateAtoms(e, ids, [1, -2, 3]));
    for (const id of ids) {
      const p = positionOf(water, id);
      expect(positionOf(moved, id)).toEqual([p[0] + 1, p[1] - 2, p[2] + 3]);
    }
    const { scene: turned } = editScene(water, 'rotate', (e) => rotateAtoms(e, ids, [0, 0, 0], [0, 0, 5], Math.PI / 2));
    for (const id of ids) {
      const p = positionOf(water, id);
      const q = positionOf(turned, id);
      expect(q[0]).toBeCloseTo(-p[1], 12);
      expect(q[1]).toBeCloseTo(p[0], 12);
      expect(q[2]).toBeCloseTo(p[2], 12);
    }
    expectSameBondLengths(water, turned);
    // A full turn returns every atom to where it started.
    const { scene: full } = editScene(water, 'rotate', (e) => rotateAtoms(e, ids, [1, 1, 1], [1, 2, 3], 2 * Math.PI));
    for (const id of ids) expect(vdist(positionOf(full, id), positionOf(water, id))).toBeLessThan(1e-12);
    expect(serializeScene(full).bonds).toEqual(serializeScene(water).bonds);
  });
});
