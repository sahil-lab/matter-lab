import { EMPTY_SCENE, editScene, sortedAtoms, vcross, vdist, vdot, vnorm, vsub } from '@matterlab/core';
import type { AtomId, Scene, Vec3 } from '@matterlab/core';
import { describe, expect, it } from 'vitest';
import { WEDGE_LIFT, configurationErrors, flipDoubleBond, handedness, invertCentre, wedgeHeights } from './stereoRepair';
import type { Positions } from './stereoRepair';

const TETRAHEDRON: Vec3[] = (
  [
    [1, 1, 1],
    [1, -1, -1],
    [-1, 1, -1],
    [-1, -1, 1],
  ] as Vec3[]
).map((v) => vnorm(v));

const positionsOf = (scene: Scene): Positions => new Map(sortedAtoms(scene).map((atom) => [atom.id, atom.position]));

/** Dihedral angle a-b-c-d in degrees. */
function dihedral(p: ReadonlyMap<AtomId, Vec3>, a: AtomId, b: AtomId, c: AtomId, d: AtomId): number {
  const b1 = vsub(p.get(b)!, p.get(a)!);
  const b2 = vsub(p.get(c)!, p.get(b)!);
  const b3 = vsub(p.get(d)!, p.get(c)!);
  const n1 = vcross(b1, b2);
  const n2 = vcross(b2, b3);
  return (Math.atan2(vdot(vcross(n1, n2), vnorm(b2)), vdot(n1, n2)) * 180) / Math.PI;
}

/** Every distance between the atoms listed, for checking that a group moved as a rigid body. */
const distances = (p: ReadonlyMap<AtomId, Vec3>, ids: readonly AtomId[]): number[] => ids.flatMap((a, i) => ids.slice(i + 1).map((b) => vdist(p.get(a)!, p.get(b)!)));

/**
 * A carbon with four different substituents, one of which is a second stereocentre:
 * C1(F)(Cl)(H)-C5(Br)(I)(H).
 */
function twoCentres(): { scene: Scene; c1: AtomId; f: AtomId; cl: AtomId; h: AtomId; c5: AtomId; br: AtomId; i: AtomId; h5: AtomId } {
  let out!: ReturnType<typeof twoCentres>;
  const scene = editScene(EMPTY_SCENE, 'two centres', (e) => {
    const at = (direction: Vec3, length: number, from: Vec3 = [0, 0, 0]): Vec3 => [from[0] + direction[0] * length, from[1] + direction[1] * length, from[2] + direction[2] * length];
    const c1 = e.addAtom({ protons: 6, position: [0, 0, 0] });
    const f = e.addAtom({ protons: 9, position: at(TETRAHEDRON[0]!, 1.35) });
    const cl = e.addAtom({ protons: 17, position: at(TETRAHEDRON[1]!, 1.77) });
    const h = e.addAtom({ protons: 1, position: at(TETRAHEDRON[2]!, 1.09) });
    const origin = at(TETRAHEDRON[3]!, 1.54);
    const c5 = e.addAtom({ protons: 6, position: origin });
    // The substituents of the second carbon point away from the first: the same tetrahedron turned over.
    const away = TETRAHEDRON.map((v) => [-v[0], -v[1], -v[2]] as Vec3);
    const br = e.addAtom({ protons: 35, position: at(away[0]!, 1.94, origin) });
    const i = e.addAtom({ protons: 53, position: at(away[1]!, 2.14, origin) });
    const h5 = e.addAtom({ protons: 1, position: at(away[2]!, 1.09, origin) });
    for (const [a, b] of [[c1, f], [c1, cl], [c1, h], [c1, c5], [c5, br], [c5, i], [c5, h5]] as const) e.addBond(a, b, 1);
    out = { scene: EMPTY_SCENE, c1, f, cl, h, c5, br, i, h5 };
  }).scene;
  return { ...out, scene };
}

describe('inverting a stereocentre', () => {
  it('swaps two free substituents, exactly preserving the geometry at the centre', () => {
    const m = twoCentres();
    const before = positionsOf(m.scene);
    const p = positionsOf(m.scene);
    expect(invertCentre(m.scene, p, m.c1)).toBe(true);

    expect(handedness(p, m.c1, [m.f, m.cl, m.c5])).toBe(-handedness(before, m.c1, [m.f, m.cl, m.c5]));
    // The two smallest substituents, hydrogen and fluorine, changed places; nothing else moved.
    for (const id of [m.c1, m.cl, m.c5, m.br, m.i, m.h5]) expect(p.get(id)).toEqual(before.get(id));
    expect(vdist(p.get(m.h)!, before.get(m.h)!)).toBeGreaterThan(1);
    const direction = (map: ReadonlyMap<AtomId, Vec3>, id: AtomId): Vec3 => vnorm(vsub(map.get(id)!, map.get(m.c1)!));
    expect(vdot(direction(p, m.h), direction(before, m.f))).toBeCloseTo(1, 12);
    expect(vdot(direction(p, m.f), direction(before, m.h))).toBeCloseTo(1, 12);
    // Bond lengths are untouched, and so is every angle at the centre.
    expect(vdist(p.get(m.c1)!, p.get(m.h)!)).toBeCloseTo(1.09, 12);
    expect(vdist(p.get(m.c1)!, p.get(m.f)!)).toBeCloseTo(1.35, 12);
    for (const other of [m.cl, m.c5]) {
      expect(vdot(direction(p, m.h), direction(p, other))).toBeCloseTo(vdot(direction(before, m.f), direction(before, other)), 12);
      expect(vdot(direction(p, m.f), direction(p, other))).toBeCloseTo(vdot(direction(before, m.h), direction(before, other)), 12);
    }
  });

  it('leaves the handedness of a stereocentre inside a group it moves as it was', () => {
    const m = twoCentres();
    const before = positionsOf(m.scene);
    const p = positionsOf(m.scene);
    // Seen from the second carbon the free substituents are Br, I, H and the whole first carbon with its three atoms.
    expect(invertCentre(m.scene, p, m.c5)).toBe(true);
    expect(handedness(p, m.c5, [m.br, m.i, m.c1])).toBe(-handedness(before, m.c5, [m.br, m.i, m.c1]));
    expect(handedness(p, m.c1, [m.f, m.cl, m.c5])).toBe(handedness(before, m.c1, [m.f, m.cl, m.c5]));

    // And when the first carbon's whole group is what moves: make the bromine and the iodine into larger groups,
    // so that the two smallest substituents of the second carbon are its hydrogen and the first carbon with its three atoms.
    const scene = editScene(m.scene, 'larger groups', (e) => {
      for (const [atom, sign] of [[m.br, 1], [m.i, -1]] as const) {
        e.updateAtom(atom, { protons: 14 });
        const from = m.scene.atoms.get(atom)!.position;
        for (const offset of [[2, 0, 0], [0, 2, 0], [0, 0, 2], [2, 2, 2]] as Vec3[]) {
          e.addBond(atom, e.addAtom({ protons: 9, position: [from[0] + sign * offset[0], from[1] + sign * offset[1], from[2] + sign * offset[2]] }), 1);
        }
      }
    }).scene;
    const start = positionsOf(scene);
    const q = positionsOf(scene);
    expect(invertCentre(scene, q, m.c5)).toBe(true);
    expect(vdist(q.get(m.c1)!, start.get(m.c1)!)).toBeGreaterThan(1);
    for (const id of [m.c5, m.br, m.i]) expect(q.get(id)).toEqual(start.get(id));
    expect(handedness(q, m.c5, [m.br, m.i, m.c1])).toBe(-handedness(start, m.c5, [m.br, m.i, m.c1]));
    expect(handedness(q, m.c1, [m.f, m.cl, m.c5])).toBe(handedness(start, m.c1, [m.f, m.cl, m.c5]));
    const group = [m.c1, m.f, m.cl, m.h];
    distances(q, group).forEach((d, k) => expect(d).toBeCloseTo(distances(start, group)[k]!, 10));
  });

  it('turns an atom where three rings meet inside out, taking its one free substituent along', () => {
    // A cage corner: the centre above a triangle of three atoms that are bonded to one another, and a hydrogen on top.
    let centre!: AtomId;
    let h!: AtomId;
    let ring!: [AtomId, AtomId, AtomId];
    const scene = editScene(EMPTY_SCENE, 'corner', (e) => {
      centre = e.addAtom({ protons: 6, position: [0.1, -0.05, 0.6] });
      h = e.addAtom({ protons: 1, position: [0.2, -0.1, 1.68] });
      ring = [
        e.addAtom({ protons: 6, position: [1.4, 0, 0] }),
        e.addAtom({ protons: 7, position: [-0.7, 1.2, 0] }),
        e.addAtom({ protons: 8, position: [-0.7, -1.2, 0] }),
      ];
      e.addBond(centre, h, 1);
      for (const r of ring) e.addBond(centre, r, 1);
      e.addBond(ring[0], ring[1], 1);
      e.addBond(ring[1], ring[2], 1);
      e.addBond(ring[2], ring[0], 1);
    }).scene;
    const before = positionsOf(scene);
    const p = positionsOf(scene);
    expect(invertCentre(scene, p, centre)).toBe(true);
    expect(handedness(p, centre, ring)).toBe(-handedness(before, centre, ring));
    for (const r of ring) {
      expect(p.get(r)).toEqual(before.get(r));
      expect(vdist(p.get(centre)!, p.get(r)!)).toBeCloseTo(vdist(before.get(centre)!, before.get(r)!), 10);
    }
    // The centre is now as far below the ring plane as it was above, and the hydrogen is further below still.
    expect(p.get(centre)![2]).toBeCloseTo(-0.6, 10);
    expect(p.get(h)![2]).toBeCloseTo(-1.68, 10);
    expect(vdist(p.get(centre)!, p.get(h)!)).toBeCloseTo(vdist(before.get(centre)!, before.get(h)!), 10);
  });

  it('pushes a three-coordinate centre through the plane of its neighbours', () => {
    let s!: AtomId;
    let around!: [AtomId, AtomId, AtomId];
    const scene = editScene(EMPTY_SCENE, 'sulfoxide', (e) => {
      s = e.addAtom({ protons: 16, position: [0, 0, 0.7] });
      around = [e.addAtom({ protons: 8, position: [1.4, 0, 0] }), e.addAtom({ protons: 6, position: [-0.8, 1.3, 0] }), e.addAtom({ protons: 6, position: [-0.8, -1.3, 0] })];
      e.addBond(s, around[0], 2);
      e.addBond(s, around[1], 1);
      e.addBond(s, around[2], 1);
    }).scene;
    const p = positionsOf(scene);
    expect(invertCentre(scene, p, s)).toBe(true);
    expect(p.get(s)![0]).toBeCloseTo(0, 12);
    expect(p.get(s)![1]).toBeCloseTo(0, 12);
    expect(p.get(s)![2]).toBeCloseTo(-0.7, 12);
    for (const id of around) expect(p.get(id)).toEqual(scene.atoms.get(id)!.position);
  });

  it('refuses a spiro atom, all of whose bonds are in rings, and changes nothing', () => {
    let spiro!: AtomId;
    const scene = editScene(EMPTY_SCENE, 'spiro', (e) => {
      spiro = e.addAtom({ protons: 6, position: [0, 0, 0] });
      const corners = TETRAHEDRON.map((v) => e.addAtom({ protons: 6, position: [v[0] * 1.5, v[1] * 1.5, v[2] * 1.5] }));
      for (const corner of corners) e.addBond(spiro, corner, 1);
      // Two three-membered rings that share only the spiro atom.
      e.addBond(corners[0]!, corners[1]!, 1);
      e.addBond(corners[2]!, corners[3]!, 1);
    }).scene;
    const p = positionsOf(scene);
    expect(invertCentre(scene, p, spiro)).toBe(false);
    expect(p).toEqual(positionsOf(scene));
  });
});

describe('turning a double bond', () => {
  /** But-2-ene with its carbon skeleton in a plane: the two methyl carbons on opposite sides (E). */
  function butene(): { scene: Scene; c: [AtomId, AtomId, AtomId, AtomId] } {
    let c!: [AtomId, AtomId, AtomId, AtomId];
    const scene = editScene(EMPTY_SCENE, 'butene', (e) => {
      c = [
        e.addAtom({ protons: 6, position: [-1.9, 0.9, 0] }),
        e.addAtom({ protons: 6, position: [-0.67, 0, 0] }),
        e.addAtom({ protons: 6, position: [0.67, 0, 0] }),
        e.addAtom({ protons: 6, position: [1.9, -0.9, 0] }),
      ];
      e.addBond(c[0], c[1], 1);
      e.addBond(c[1], c[2], 2);
      e.addBond(c[2], c[3], 1);
      e.addBond(c[1], e.addAtom({ protons: 1, position: [-0.7, -1.09, 0] }), 1);
      e.addBond(c[2], e.addAtom({ protons: 1, position: [0.7, 1.09, 0] }), 1);
    }).scene;
    return { scene, c };
  }

  it('changes E into Z by a half turn of one end, keeping every bond length', () => {
    const { scene, c } = butene();
    const before = positionsOf(scene);
    const p = positionsOf(scene);
    expect(Math.abs(dihedral(p, c[0], c[1], c[2], c[3]))).toBeCloseTo(180, 8);
    expect(flipDoubleBond(scene, p, c[1], c[2])).toBe(true);
    expect(dihedral(p, c[0], c[1], c[2], c[3])).toBeCloseTo(0, 8);
    for (const bond of scene.bonds.values()) expect(vdist(p.get(bond.a)!, p.get(bond.b)!)).toBeCloseTo(vdist(before.get(bond.a)!, before.get(bond.b)!), 10);
    // A second turn brings everything back.
    expect(flipDoubleBond(scene, p, c[1], c[2])).toBe(true);
    for (const [id, position] of before) position.forEach((value, k) => expect(p.get(id)![k]).toBeCloseTo(value, 10));
  });

  it('refuses a double bond in a ring and changes nothing', () => {
    const { scene, c } = butene();
    const ring = editScene(scene, 'close the ring', (e) => e.addBond(c[0], c[3], 1)).scene;
    const p = positionsOf(ring);
    expect(flipDoubleBond(ring, p, c[1], c[2])).toBe(false);
    expect(p).toEqual(positionsOf(ring));
  });
});

describe('reading and comparing configurations', () => {
  it('lifts the atom at the wide end of each wedge out of the plane of a drawing', () => {
    // Bond block columns: first atom, second atom, bond type, stereo mark (1 = solid wedge, 6 = hashed).
    const molblock = [
      '',
      '  test',
      '',
      '  5  4  0  0  0  0  0  0  0  0999 V2000',
      ...Array.from({ length: 5 }, (_, i) => `    ${i}.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0`),
      '  1  2  1  1',
      '  1  3  1  6',
      '  1  4  1  0',
      '  1  5  2  0',
      'M  END',
    ].join('\n');
    expect(wedgeHeights(molblock, 5)).toEqual([0, WEDGE_LIFT, -WEDGE_LIFT, 0, 0]);
    // A block that is not about the structure in hand is not trusted.
    expect(wedgeHeights(molblock, 6)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(wedgeHeights(molblock.replace('V2000', 'V3000'), 5)).toEqual([0, 0, 0, 0, 0]);
  });

  it('counts as wrong only what was asked for and is not there', () => {
    const asked = { centres: [{ atom: 1, label: 'S' }, { atom: 4, label: 'R' }], doubleBonds: [{ a: 6, b: 7, label: 'E' }] };
    expect(configurationErrors(asked, asked)).toEqual({ centres: [], doubleBonds: [] });
    // The same bond named from its other end is the same bond.
    expect(configurationErrors(asked, { ...asked, doubleBonds: [{ a: 7, b: 6, label: 'E' }] }).doubleBonds).toEqual([]);
    const model = { centres: [{ atom: 1, label: 'R' }, { atom: 9, label: 'S' }], doubleBonds: [{ a: 6, b: 7, label: 'Z' }, { a: 2, b: 3, label: 'E' }] };
    // Atom 1 is inverted, atom 4 is not a stereocentre in the model at all, the bond is the other way round;
    // atom 9 and the bond 2-3, which nobody asked about, are not errors.
    expect(configurationErrors(asked, model)).toEqual({ centres: [1, 4], doubleBonds: [[6, 7]] });
  });
});
