import { describe, expect, it } from 'vitest';
import {
  EXAMPLES,
  addHydrogens,
  allowedValences,
  analyseValences,
  angleDegrees,
  composition,
  dihedralDegrees,
  editScene,
  exampleScene,
  findExample,
  formatFormula,
  hillFormula,
  idealBondLength,
  kekulize,
  molecularMass,
  neighborsOf,
  perceiveBonds,
  removeHydrogens,
  substituentDirections,
  validateScene,
  vangle,
  vdist,
} from '../src';
import type { AtomId, BondOrder, Scene, Vec3 } from '../src';
import { atomsOfElement, build, positionOf, seededRandom } from './helpers';

const DEG = 180 / Math.PI;

/** A lone atom completed with hydrogens. */
function hydride(z: number, charge = 0): Scene {
  const scene = build((e) => {
    e.addAtom({ protons: z, charge, position: [0, 0, 0] });
  });
  return editScene(scene, 'add H', (e) => void addHydrogens(e)).scene;
}

function anglesAt(scene: Scene, center: AtomId): number[] {
  const around = neighborsOf(scene, center).map((n) => positionOf(scene, n.atomId));
  const result: number[] = [];
  for (let i = 0; i < around.length; i++) {
    for (let j = i + 1; j < around.length; j++) result.push(angleDegrees(around[i]!, positionOf(scene, center), around[j]!));
  }
  return result;
}

/** A regular planar ring with the given per-atom elements and bond orders. */
function ring(elements: number[], orders: BondOrder[], hydrogensOn: number[] = []): Scene {
  return build((e) => {
    const n = elements.length;
    const radius = 1.4 / (2 * Math.sin(Math.PI / n));
    const ids = elements.map((z, i) => {
      const a = (2 * Math.PI * i) / n;
      return e.addAtom({ protons: z, position: [radius * Math.cos(a), radius * Math.sin(a), 0] });
    });
    ids.forEach((id, i) => e.addBond(id, ids[(i + 1) % n]!, orders[i]!));
    for (const i of hydrogensOn) {
      const a = (2 * Math.PI * i) / n;
      e.addBond(ids[i]!, e.addAtom({ protons: 1, position: [(radius + 1.08) * Math.cos(a), (radius + 1.08) * Math.sin(a), 0] }));
    }
  });
}

const AROMATIC6: BondOrder[] = [1.5, 1.5, 1.5, 1.5, 1.5, 1.5];
const AROMATIC5: BondOrder[] = [1.5, 1.5, 1.5, 1.5, 1.5];

describe('valence model', () => {
  it('follows RDKit for neutral atoms and treats charged atoms like their isoelectronic neighbours', () => {
    expect(allowedValences(6, 0)).toEqual([4]);
    expect(allowedValences(7, 0)).toEqual([3]);
    expect(allowedValences(8, 0)).toEqual([2]);
    expect(allowedValences(16, 0)).toEqual([2, 4, 6]);
    expect(allowedValences(7, 1)).toEqual([4]); // ammonium nitrogen behaves like carbon
    expect(allowedValences(8, 1)).toEqual([3]); // oxonium
    expect(allowedValences(8, -1)).toEqual([1]); // alkoxide
    expect(allowedValences(6, -1)).toEqual([3]); // carbanion
    expect(allowedValences(5, -1)).toEqual([4]); // borate
    expect(allowedValences(1, 1)).toEqual([0]); // bare proton
    expect(allowedValences(9, -1)).toEqual([0]); // fluoride
    expect(allowedValences(26, 0)).toBeNull(); // iron is unconstrained
    expect(allowedValences(11, 1)).toBeNull();
  });

  it('classifies saturated, open-shell and over-bonded atoms', () => {
    const methane = exampleScene(findExample('methane')!);
    for (const v of analyseValences(methane).atoms.values()) expect(v.status).toBe('ok');

    const methyl = editScene(methane, 'remove H', (e) => e.removeAtom(atomsOfElement(methane, 1)[0]!)).scene;
    const carbon = analyseValences(methyl).atoms.get(atomsOfElement(methyl, 6)[0]!)!;
    expect(carbon).toMatchObject({ status: 'open', valence: 3, open: 1, degree: 3 });

    const overBonded = editScene(methane, 'fifth H', (e) => {
      e.addBond(atomsOfElement(methane, 6)[0]!, e.addAtom({ protons: 1, position: [0, 0, 2] }));
    }).scene;
    expect(analyseValences(overBonded).atoms.get(atomsOfElement(overBonded, 6)[0]!)!.status).toBe('exceeded');

    const ammonium = exampleScene(findExample('ammonium')!);
    expect(analyseValences(ammonium).atoms.get(atomsOfElement(ammonium, 7)[0]!)!).toMatchObject({ status: 'ok', valence: 4 });

    const heliumBond = build((e) => {
      e.addBond(e.addAtom({ protons: 2, position: [0, 0, 0] }), e.addAtom({ protons: 1, position: [1, 0, 0] }));
    });
    expect(analyseValences(heliumBond).atoms.get(1)!.status).toBe('exceeded');

    const iron = build((e) => {
      const fe = e.addAtom({ protons: 26, position: [0, 0, 0] });
      for (let i = 0; i < 6; i++) e.addBond(fe, e.addAtom({ protons: 17, position: [i + 2, 0, 0] }));
    });
    expect(analyseValences(iron).atoms.get(1)!.status).toBe('unconstrained');
  });
});

describe('kekulisation of aromatic bonds', () => {
  const doubleCount = (scene: Scene) => {
    const k = kekulize(scene);
    expect(k.ok).toBe(true);
    return [...k.orders.values()].filter((o) => o === 2).length;
  };

  it('assigns three alternating double bonds to benzene', () => {
    const benzene = exampleScene(findExample('benzene')!);
    expect(doubleCount(benzene)).toBe(3);
    for (const v of analyseValences(benzene).atoms.values()) expect(v.status).toBe('ok');
  });

  it('handles heteroaromatic rings by their lone pairs', () => {
    // Pyridine: the nitrogen has no hydrogen and takes part in a double bond.
    expect(doubleCount(ring([7, 6, 6, 6, 6, 6], AROMATIC6, [1, 2, 3, 4, 5]))).toBe(3);
    // Pyrrole: N-H contributes its lone pair, so only the four carbons pair up.
    const pyrrole = ring([7, 6, 6, 6, 6], AROMATIC5, [0, 1, 2, 3, 4]);
    expect(doubleCount(pyrrole)).toBe(2);
    expect(analyseValences(pyrrole).atoms.get(1)!).toMatchObject({ status: 'ok', valence: 3 });
    // Furan and thiophene: the heteroatom takes no double bond.
    expect(doubleCount(ring([8, 6, 6, 6, 6], AROMATIC5, [1, 2, 3, 4]))).toBe(2);
    expect(doubleCount(ring([16, 6, 6, 6, 6], AROMATIC5, [1, 2, 3, 4]))).toBe(2);
  });

  it('kekulises the fused rings of caffeine and aspirin from the example set', () => {
    for (const id of ['caffeine', 'aspirin']) {
      const scene = exampleScene(findExample(id)!);
      expect(kekulize(scene).ok, id).toBe(true);
      for (const v of analyseValences(scene).atoms.values()) expect(v.status, id).toBe('ok');
    }
  });

  it('reports aromatic bonds that cannot describe a real structure', () => {
    // Five CH atoms in an aromatic ring: an odd number of atoms each needing one double bond.
    const impossible = ring([6, 6, 6, 6, 6], AROMATIC5, [0, 1, 2, 3, 4]);
    const k = kekulize(impossible);
    expect(k.ok).toBe(false);
    if (!k.ok) expect(k.reason).toMatch(/cannot be assigned/);
    expect(validateScene(impossible).issues.some((i) => i.code === 'aromatic-unassignable' && i.severity === 'error')).toBe(true);
  });
});

describe('adding hydrogens', () => {
  it('completes lone atoms to their simple hydrides with VSEPR geometry', () => {
    const expected: Array<[number, number, string, number | null]> = [
      [6, 0, 'CH₄', 109.471],
      [7, 0, 'H₃N', 109.471],
      [8, 0, 'H₂O', 109.471],
      [5, 0, 'BH₃', 120],
      [9, 0, 'FH', null],
      [16, 0, 'H₂S', 109.471],
      [15, 0, 'H₃P', 109.471],
      [14, 0, 'H₄Si', 109.471],
      [7, 1, 'H₄N⁺', 109.471],
      [8, 1, 'H₃O⁺', 109.471],
      [1, 0, 'H₂', null],
    ];
    for (const [z, charge, formula, angle] of expected) {
      const scene = hydride(z, charge);
      expect(hillFormula(scene), `Z=${z}`).toBe(formula);
      expect(validateScene(scene).errors, formula).toBe(0);
      for (const v of analyseValences(scene).atoms.values()) expect(v.status, formula).toBe('ok');
      if (angle !== null) for (const a of anglesAt(scene, 1)) expect(a, formula).toBeCloseTo(angle, 2);
      for (const n of neighborsOf(scene, 1)) {
        expect(vdist(positionOf(scene, 1), positionOf(scene, n.atomId))).toBeCloseTo(idealBondLength(z, 1), 9);
      }
    }
  });

  it('leaves atoms alone when the valence model does not constrain them or they are already saturated', () => {
    for (const z of [2, 10, 11, 26, 79]) expect(hydride(z).atoms.size, `Z=${z}`).toBe(1);
    const methane = exampleScene(findExample('methane')!);
    expect(editScene(methane, 'add H', (e) => void addHydrogens(e)).scene).toBe(methane);
  });

  it('staggers hydrogens across a single bond and keeps a double bond planar', () => {
    const skeleton = (order: BondOrder) =>
      build((e) => {
        e.addBond(e.addAtom({ protons: 6, position: [0, 0, 0] }), e.addAtom({ protons: 6, position: [1.5, 0, 0] }), order);
      });

    const ethane = editScene(skeleton(1), 'H', (e) => void addHydrogens(e)).scene;
    expect(hillFormula(ethane)).toBe('C₂H₆');
    const hOn = (scene: Scene, c: AtomId) => neighborsOf(scene, c).map((n) => n.atomId).filter((id) => scene.atoms.get(id)!.protons === 1);
    for (const h1 of hOn(ethane, 1)) {
      for (const h2 of hOn(ethane, 2)) {
        const d = Math.abs(dihedralDegrees(positionOf(ethane, h1), positionOf(ethane, 1), positionOf(ethane, 2), positionOf(ethane, h2)));
        expect(Math.min(Math.abs(d - 60), Math.abs(d - 180))).toBeLessThan(0.01);
      }
    }

    const ethene = editScene(skeleton(2), 'H', (e) => void addHydrogens(e)).scene;
    expect(hillFormula(ethene)).toBe('C₂H₄');
    for (const a of [...anglesAt(ethene, 1), ...anglesAt(ethene, 2)]) expect(a).toBeCloseTo(120, 6);
    for (const h1 of hOn(ethene, 1)) {
      for (const h2 of hOn(ethene, 2)) {
        const d = Math.abs(dihedralDegrees(positionOf(ethene, h1), positionOf(ethene, 1), positionOf(ethene, 2), positionOf(ethene, h2)));
        expect(Math.min(d, Math.abs(d - 180))).toBeLessThan(1e-6);
      }
    }

    const ethyne = editScene(skeleton(3), 'H', (e) => void addHydrogens(e)).scene;
    expect(hillFormula(ethyne)).toBe('C₂H₂');
    for (const a of [...anglesAt(ethyne, 1), ...anglesAt(ethyne, 2)]) expect(a).toBeCloseTo(180, 6);
  });

  it('can restrict itself to chosen atoms, and can strip hydrogens again', () => {
    const skeleton = build((e) => {
      e.addBond(e.addAtom({ protons: 6, position: [0, 0, 0] }), e.addAtom({ protons: 8, position: [1.43, 0, 0] }));
    });
    const partial = editScene(skeleton, 'H on O', (e) => void addHydrogens(e, [2])).scene;
    expect(hillFormula(partial)).toBe('CHO');
    const full = editScene(partial, 'H', (e) => void addHydrogens(e)).scene;
    expect(hillFormula(full)).toBe('CH₄O');

    const stripped = editScene(full, 'strip', (e) => {
      expect(removeHydrogens(e)).toBe(4);
    }).scene;
    expect(hillFormula(stripped)).toBe('CO');

    const h2 = hydride(1);
    expect(editScene(h2, 'strip', (e) => void removeHydrogens(e)).scene).toBe(h2);
  });

  it('spreads substituents evenly for every ideal geometry', () => {
    const minAngle = (dirs: Vec3[]) => {
      let min = 180;
      for (let i = 0; i < dirs.length; i++) for (let j = i + 1; j < dirs.length; j++) min = Math.min(min, vangle(dirs[i]!, dirs[j]!) * DEG);
      return min;
    };
    expect(minAngle(substituentDirections(2, [], 2))).toBeCloseTo(180, 6);
    expect(minAngle(substituentDirections(3, [], 3))).toBeCloseTo(120, 6);
    expect(minAngle(substituentDirections(4, [], 4))).toBeCloseTo(109.471, 2);
    expect(minAngle(substituentDirections(5, [], 5))).toBeCloseTo(90, 6);
    expect(minAngle(substituentDirections(6, [], 6))).toBeCloseTo(90, 6);
    // Completing an octahedron around four existing bonds in a plane puts the last two along the axis.
    const square: Vec3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];
    const axial = substituentDirections(6, square, 2);
    expect(Math.abs(axial[0]![2])).toBeCloseTo(1, 3);
    expect(vangle(axial[0]!, axial[1]!) * DEG).toBeCloseTo(180, 1);
    for (const d of axial) expect(Math.hypot(...d)).toBeCloseTo(1, 9);
  });
});

describe('formulas and masses', () => {
  it('writes Hill formulas with charges', () => {
    const formula = (id: string) => hillFormula(exampleScene(findExample(id)!), undefined, 'plain');
    expect(formula('water')).toBe('H2O');
    expect(formula('methane')).toBe('CH4');
    expect(formula('benzene')).toBe('C6H6');
    expect(formula('ethanol')).toBe('C2H6O');
    expect(formula('glucose')).toBe('C6H12O6');
    expect(formula('aspirin')).toBe('C9H8O4');
    expect(formula('caffeine')).toBe('C8H10N4O2');
    expect(formula('ammonium')).toBe('H4N+');
    expect(hillFormula(exampleScene(findExample('ammonium')!))).toBe('H₄N⁺');
    expect(formatFormula({ parts: [], atomCount: 0, charge: 0, electrons: 0 })).toBe('');
  });

  it('sums standard atomic weights, or isotope masses when isotopes are specified', () => {
    const water = exampleScene(findExample('water')!);
    const light = molecularMass(water);
    expect(light.basis).toBe('standard');
    expect(light.mass).toBeCloseTo(2 * 1.008 + 15.999, 9);

    const heavy = editScene(water, 'deuterate', (e) => {
      for (const h of atomsOfElement(water, 1)) e.updateAtom(h, { neutrons: 1 });
    }).scene;
    const heavyMass = molecularMass(heavy);
    expect(heavyMass.basis).toBe('mixed');
    expect(heavyMass.mass - light.mass).toBeCloseTo(2 * (2.014102 - 1.008), 4);
    expect(heavyMass.estimated).toBe(false);

    const total = composition(water);
    expect(total).toMatchObject({ atomCount: 3, charge: 0, electrons: 10 });
    expect(molecularMass(water, atomsOfElement(water, 1)).mass).toBeCloseTo(2.016, 9);
  });
});

describe('bond perception and typical lengths', () => {
  it('estimates familiar bond lengths to within a few hundredths of an angstrom', () => {
    expect(idealBondLength(6, 6, 1)).toBeCloseTo(1.52, 2);
    expect(idealBondLength(6, 6, 2)).toBeLessThan(idealBondLength(6, 6, 1));
    expect(idealBondLength(6, 6, 3)).toBeLessThan(idealBondLength(6, 6, 2));
    expect(idealBondLength(6, 6, 1.5)).toBeCloseTo(1.4, 1);
    expect(idealBondLength(6, 1)).toBeCloseTo(1.07, 2);
    expect(idealBondLength(8, 1)).toBeCloseTo(0.97, 2);
  });

  it('recovers the connectivity of every built-in molecule from coordinates alone', () => {
    for (const example of EXAMPLES) {
      const scene = exampleScene(example);
      const atoms = [...scene.atoms.values()];
      const perceived = perceiveBonds(atoms).map((b) => (b.a < b.b ? `${b.a}:${b.b}` : `${b.b}:${b.a}`)).sort();
      const actual = [...scene.bonds.values()].map((b) => (b.a < b.b ? `${b.a}:${b.b}` : `${b.b}:${b.a}`)).sort();
      expect(perceived, example.id).toEqual(actual);
    }
  });

  it('never gives hydrogen two bonds and ignores overlapping atoms', () => {
    // A hydrogen sitting between two oxygens bonds only to the nearer one.
    const bonds = perceiveBonds([
      { id: 1, protons: 8, position: [0, 0, 0] },
      { id: 2, protons: 1, position: [0.96, 0, 0] },
      { id: 3, protons: 8, position: [2.05, 0, 0] },
    ]);
    expect(bonds).toEqual([{ a: 1, b: 2 }]);
    expect(perceiveBonds([{ id: 1, protons: 6, position: [0, 0, 0] }, { id: 2, protons: 6, position: [0.1, 0, 0] }])).toEqual([]);
    expect(perceiveBonds([])).toEqual([]);
  });
});

describe('structure validation', () => {
  it('passes every built-in molecule without errors or warnings', () => {
    for (const example of EXAMPLES) {
      const report = validateScene(exampleScene(example));
      expect(report.errors, example.id).toBe(0);
      expect(report.warnings, example.id).toBe(0);
      expect(report.ok).toBe(true);
    }
    expect(validateScene(exampleScene(findExample('ammonium')!)).issues.map((i) => i.code)).toEqual(['net-charge']);
  });

  it('explains open valences and offers to add hydrogens', () => {
    const report = validateScene(
      build((e) => {
        e.addAtom({ protons: 6, position: [0, 0, 0] });
      }),
    );
    expect(report.ok).toBe(true);
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]).toMatchObject({ severity: 'warning', code: 'valence-open', fix: 'add-hydrogens', atomIds: [1] });
    expect(report.issues[0]!.message).toMatch(/4 short of the usual 4 for Carbon.*4 unpaired electrons/);
  });

  it('flags over-bonded atoms, overlapping atoms and implausible bond lengths', () => {
    const methane = exampleScene(findExample('methane')!);
    const carbon = atomsOfElement(methane, 6)[0]!;
    const bad = editScene(methane, 'break it', (e) => {
      e.addBond(carbon, e.addAtom({ protons: 1, position: [0.2, 3.9, 0] })); // fifth, very long bond
      e.addAtom({ protons: 2, position: [8, 8, 8] });
      e.addAtom({ protons: 2, position: [8.1, 8, 8] }); // on top of the other helium
    }).scene;
    const report = validateScene(bad);
    const codes = report.issues.map((i) => `${i.severity}:${i.code}`);
    expect(codes).toContain('error:valence-exceeded');
    expect(codes).toContain('error:atoms-overlap');
    expect(codes).toContain('warning:bond-stretched');
    expect(codes).toContain('info:multiple-fragments');
    expect(report.ok).toBe(false);
    expect(report.issues[0]!.severity).toBe('error');
    expect(report.issues.find((i) => i.code === 'valence-exceeded')!.message).toMatch(/total bond order of 5.*at most 4/);

    const squeezed = editScene(methane, 'squeeze', (e) => {
      const h = atomsOfElement(methane, 1)[0]!;
      const p = positionOf(methane, h);
      const c = positionOf(methane, carbon);
      e.moveAtom(h, [c[0] + (p[0] - c[0]) * 0.6, c[1] + (p[1] - c[1]) * 0.6, c[2] + (p[2] - c[2]) * 0.6]);
    }).scene;
    expect(validateScene(squeezed).issues.map((i) => i.code)).toContain('bond-compressed');
  });

  it('notes atoms that sit within bonding distance without a bond', () => {
    const report = validateScene(
      build((e) => {
        e.addAtom({ protons: 6, position: [0, 0, 0] });
        e.addAtom({ protons: 6, position: [1.5, 0, 0] });
      }),
    );
    expect(report.issues.map((i) => i.code)).toContain('unbonded-contact');
    expect(report.issues.find((i) => i.code === 'unbonded-contact')!.severity).toBe('info');
  });

  it('finds exactly the overlapping pairs, whether the atoms are packed together or scattered over an enormous box', () => {
    // 300 helium atoms thrown into a small cube around the origin: many overlaps, many contacts, no bonds.
    const random = seededRandom(20261115);
    const positions: Vec3[] = Array.from({ length: 300 }, () => [(random() - 0.5) * 9, (random() - 0.5) * 9, (random() - 0.5) * 9]);
    const packed = build((e) => positions.forEach((position) => e.addAtom({ protons: 2, position })));
    // The same atoms and one more, three billion kilometres away, which makes the grid of cells too large to
    // index by number and sends the search down its other route.
    const scattered = editScene(packed, 'far away', (e) => {
      e.addAtom({ protons: 2, position: [3e12, 0, 0] });
    }).scene;

    // What must be found, by comparing every atom with every other. Helium's covalent radius is 0.28 angstrom,
    // so two unbonded heliums count as "within bonding distance" below 2 x 0.28 + 0.1 = 0.66 angstrom.
    const expected: string[] = [];
    const inContact = new Set<number>();
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const d = vdist(positions[i]!, positions[j]!);
        if (d < 0.5) expected.push(`${i + 1}-${j + 1}`);
        else if (d < 0.66) inContact.add(i + 1).add(j + 1);
      }
    }
    expect(expected.length).toBeGreaterThan(20);
    expect(inContact.size).toBeGreaterThan(20);

    const overlaps = (scene: Scene) => validateScene(scene).issues.filter((i) => i.code === 'atoms-overlap');
    const found = overlaps(packed);
    expect(found.map((i) => i.atomIds.join('-')).sort()).toEqual([...expected].sort());
    // Both routes report the same pairs, in the same order, with the same distances.
    expect(overlaps(scattered)).toEqual(found);
    const contact = (scene: Scene) => validateScene(scene).issues.find((i) => i.code === 'unbonded-contact')!;
    expect([...contact(packed).atomIds].sort((a, b) => a - b)).toEqual([...inContact].sort((a, b) => a - b));
    expect(contact(scattered)).toEqual(contact(packed));
  });
});
