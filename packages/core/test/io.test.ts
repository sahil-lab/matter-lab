import { describe, expect, it } from 'vitest';
import {
  EXAMPLES,
  FILE_FORMATS,
  MoleculeParseError,
  SCENE_FORMAT,
  SceneFormatError,
  analyseValences,
  atomCharge,
  deserializeScene,
  detectFileFormat,
  editScene,
  exampleScene,
  exportMolecule,
  findExample,
  fromMolfile,
  fromPDB,
  fromSDF,
  fromXYZ,
  hillFormula,
  importMolecules,
  kekulize,
  serializeScene,
  sortedAtoms,
  sortedBonds,
  toMolfile,
  toPDB,
  toSDF,
  toXYZ,
  vdist,
} from '../src';
import type { FileFormatId, Scene } from '../src';
import { atomsOfElement, build } from './helpers';

/** Bonds as pairs of 0-based creation-order atom indices, so scenes with different ids can be compared. */
function connectivity(scene: Scene): string[] {
  const index = new Map(sortedAtoms(scene).map((a, i) => [a.id, i]));
  return sortedBonds(scene)
    .map((b) => [index.get(b.a)!, index.get(b.b)!].sort((x, y) => x - y).join('-'))
    .sort();
}

const bondOrderSum = (scene: Scene) => [...scene.bonds.values()].reduce((s, b) => s + b.order, 0);
const elementsOf = (scene: Scene) => sortedAtoms(scene).map((a) => a.protons);

function expectSamePositions(a: Scene, b: Scene, tolerance: number): void {
  const pa = sortedAtoms(a);
  const pb = sortedAtoms(b);
  expect(pb).toHaveLength(pa.length);
  pa.forEach((atom, i) => expect(vdist(atom.position, pb[i]!.position)).toBeLessThan(tolerance));
}

const atomLine = (x: number, y: number, z: number, symbol: string) =>
  `${x.toFixed(4).padStart(10)}${y.toFixed(4).padStart(10)}${z.toFixed(4).padStart(10)} ${symbol.padEnd(3)} 0  0  0  0  0  0  0  0  0  0  0  0`;
const bondLine = (a: number, b: number, type: number) =>
  `${String(a).padStart(3)}${String(b).padStart(3)}${String(type).padStart(3)}  0  0  0  0`;
const countsLine = (atoms: number, bonds: number) =>
  `${String(atoms).padStart(3)}${String(bonds).padStart(3)}  0  0  0  0  0  0  0  0999 V2000`;

describe('native scene format', () => {
  it('round-trips every built-in molecule exactly, through real JSON text', () => {
    for (const example of EXAMPLES) {
      const scene = exampleScene(example);
      const restored = deserializeScene(JSON.parse(JSON.stringify(serializeScene(scene))));
      expect(serializeScene(restored)).toEqual(serializeScene(scene));
      expect(restored.nextAtomId).toBe(scene.nextAtomId);
    }
  });

  it('preserves isotopes, electron counts and full coordinate precision', () => {
    const scene = build((e) => {
      const a = e.addAtom({ protons: 8, neutrons: 10, electrons: 10, position: [0.1 + 0.2, -1e-7, Math.PI] });
      const b = e.addAtom({ protons: 1, neutrons: 2, electrons: 0, position: [1, 0, 0] });
      e.addBond(a, b, 1.5);
    });
    const text = JSON.stringify(serializeScene(scene));
    const restored = deserializeScene(JSON.parse(text));
    expect([...restored.atoms.values()]).toEqual([...scene.atoms.values()]);
    expect([...restored.bonds.values()]).toEqual([...scene.bonds.values()]);
    expect(JSON.parse(text)).toMatchObject({ format: SCENE_FORMAT, version: 1, units: { length: 'angstrom' } });
  });

  it('keeps id counters ahead of the ids in use even if the file says otherwise', () => {
    const data = { ...serializeScene(exampleScene(findExample('water')!)), nextAtomId: 1, nextBondId: 0 };
    const restored = deserializeScene(data);
    expect(restored.nextAtomId).toBe(4);
    expect(restored.nextBondId).toBe(3);
    editScene(restored, 'add', (e) => expect(e.addAtom({ protons: 1, position: [0, 0, 0] })).toBe(4));
  });

  it('rejects damaged or foreign files with a clear reason instead of loading them', () => {
    const good = serializeScene(exampleScene(findExample('water')!));
    const broken = (change: (d: any) => void) => {
      const copy = JSON.parse(JSON.stringify(good));
      change(copy);
      return () => deserializeScene(copy);
    };
    expect(() => deserializeScene(null)).toThrow(SceneFormatError);
    expect(() => deserializeScene([])).toThrow(SceneFormatError);
    expect(broken((d) => (d.format = 'something-else'))).toThrow(/not a MATTER LAB scene/);
    expect(broken((d) => (d.version = 99))).toThrow(/newer version/);
    expect(broken((d) => (d.units.length = 'bohr'))).toThrow(/length unit/);
    expect(broken((d) => delete d.atoms)).toThrow(/"atoms" and "bonds"/);
    expect(broken((d) => (d.atoms[0].p = 0))).toThrow(/Atom entry 1.*known element/);
    expect(broken((d) => (d.atoms[1].p = 119))).toThrow(/Atom entry 2/);
    expect(broken((d) => (d.atoms[0].e = -1))).toThrow(/electron count/);
    expect(broken((d) => (d.atoms[0].n = 2.5))).toThrow(/neutron count/);
    expect(broken((d) => (d.atoms[0].x = 'left'))).toThrow(/x must be a finite number/);
    expect(broken((d) => (d.atoms[0].y = null))).toThrow(/finite/);
    expect(broken((d) => (d.atoms[1].id = d.atoms[0].id))).toThrow(/used more than once/);
    expect(broken((d) => (d.bonds[0].b = 999))).toThrow(/not in the file/);
    expect(broken((d) => (d.bonds[0].b = d.bonds[0].a))).toThrow(/to itself/);
    expect(broken((d) => (d.bonds[0].order = 4))).toThrow(/bond order/);
    expect(broken((d) => d.bonds.push({ ...d.bonds[0], id: 77 }))).toThrow(/bonded more than once/);
    expect(broken((d) => (d.bonds[1].id = d.bonds[0].id))).toThrow(/used more than once/);
  });
});

describe('XYZ', () => {
  it('round-trips elements and coordinates and re-infers the connectivity', () => {
    for (const example of EXAMPLES) {
      const scene = exampleScene(example);
      const result = fromXYZ(toXYZ(scene, example.name));
      expect(result.name).toBe(example.name);
      expect(elementsOf(result.scene), example.id).toEqual(elementsOf(scene));
      expectSamePositions(scene, result.scene, 1e-5);
      expect(connectivity(result.scene), example.id).toEqual(connectivity(scene));
    }
  });

  it('says plainly that bond orders and charges are not stored', () => {
    const co2 = exampleScene(findExample('carbon-dioxide')!);
    const result = fromXYZ(toXYZ(co2));
    expect([...result.scene.bonds.values()].every((b) => b.order === 1)).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/store no bonds.*single/);
    const single = fromXYZ('1\nlone atom\nHe 0 0 0\n');
    expect(single.warnings).toEqual([]);
    expect(single.scene.atoms.size).toBe(1);
  });

  it('accepts atomic numbers, blank leading lines and extra columns, and reports extra frames', () => {
    const result = fromXYZ('\n3\nwater\n8 0.0 0.0 0.0 extra\nH 0.96 0.0 0.0\nh -0.24 0.93 0.0\n3\nframe 2\nO 0 0 0\nH 1 0 0\nH 0 1 0\n');
    expect(hillFormula(result.scene, undefined, 'plain')).toBe('H2O');
    expect(result.scene.bonds.size).toBe(2);
    expect(result.warnings.join(' ')).toMatch(/more than one frame/);
  });

  it('explains what is wrong with a malformed file', () => {
    expect(() => fromXYZ('three\ncomment\n')).toThrow(MoleculeParseError);
    expect(() => fromXYZ('2\ncomment\nH 0 0 0\n')).toThrow(/declares 2 atoms but contains only 1/);
    expect(() => fromXYZ('1\ncomment\nXx 0 0 0\n')).toThrow(/line 3: unknown element "Xx"/);
    expect(() => fromXYZ('1\ncomment\nH 0 zero 0\n')).toThrow(/coordinates must be numbers/);
    expect(() => fromXYZ('1\ncomment\nH 0 0\n')).toThrow(/expected "element x y z"/);
  });
});

describe('MDL molfile and SD file', () => {
  it('round-trips structure, writing aromatic rings in Kekule form', () => {
    for (const example of EXAMPLES) {
      const scene = exampleScene(example);
      const text = toMolfile(scene, { name: example.name });
      expect(text.split('\n')[3]).toMatch(/V2000$/);
      const result = fromMolfile(text);
      expect(result.name).toBe(example.name);
      expect(result.warnings, example.id).toEqual([]);
      expect(elementsOf(result.scene), example.id).toEqual(elementsOf(scene));
      expect(connectivity(result.scene), example.id).toEqual(connectivity(scene));
      // The file holds the Kekule form: no aromatic bonds, the same total bond order as the
      // Kekule assignment of the original, and every atom at an allowed valence.
      const kekule = kekulize(scene);
      const kekuleSum = [...scene.bonds.values()].reduce((s, b) => s + (b.order === 1.5 ? kekule.orders.get(b.id)! : b.order), 0);
      expect(bondOrderSum(result.scene), example.id).toBe(kekuleSum);
      expect([...result.scene.bonds.values()].some((b) => b.order === 1.5)).toBe(false);
      for (const v of analyseValences(result.scene).atoms.values()) expect(v.status, example.id).toBe('ok');
      expectSamePositions(scene, result.scene, 1e-4);
    }
  });

  it('preserves formal charges and specified isotopes', () => {
    const scene = build((e) => {
      const n = e.addAtom({ protons: 7, charge: 1, neutrons: 8, position: [0, 0, 0] });
      const o = e.addAtom({ protons: 8, charge: -1, position: [1.3, 0, 0] });
      const d = e.addAtom({ protons: 1, neutrons: 1, position: [-0.5, 0.9, 0] });
      e.addBond(n, o);
      e.addBond(n, d);
    });
    const text = toMolfile(scene);
    expect(text).toMatch(/^M {2}CHG {2}2 {3}1 {3}1 {3}2 {2}-1$/m);
    expect(text).toMatch(/^M {2}ISO {2}2 {3}1 {2}15 {3}3 {3}2$/m);
    const back = fromMolfile(text).scene;
    expect(sortedAtoms(back).map((a) => [a.protons, a.neutrons, atomCharge(a)])).toEqual([
      [7, 8, 1],
      [8, null, -1],
      [1, 1, 0],
    ]);
  });

  it('states each valence so that readers add no implicit hydrogens', () => {
    const methane = exampleScene(findExample('methane')!);
    const methyl = editScene(methane, 'radical', (e) => e.removeAtom(atomsOfElement(methane, 1)[0]!)).scene;
    const back = fromMolfile(toMolfile(methyl));
    expect(hillFormula(back.scene, undefined, 'plain')).toBe('CH3');
    expect(back.warnings).toEqual([]);

    const loneCarbon = build((e) => {
      e.addAtom({ protons: 6, position: [0, 0, 0] });
    });
    expect(toMolfile(loneCarbon).split('\n')[4]!.slice(48, 51)).toBe(' 15');
    expect(fromMolfile(toMolfile(loneCarbon)).scene.atoms.size).toBe(1);
  });

  it('marks its coordinates as a geometry unless told they are a flat drawing', () => {
    // Columns 21-22 of the second header line hold the dimension code a reader decides by whether
    // to take stereochemistry from the coordinates.
    const water = exampleScene(findExample('water')!);
    expect(toMolfile(water).split('\n')[1]!.slice(20, 22)).toBe('3D');
    expect(toMolfile(water, { dimensions: 2 }).split('\n')[1]!.slice(20, 22)).toBe('2D');
    // Nothing else about the file changes.
    expect(toMolfile(water, { dimensions: 2 }).split('\n').slice(2)).toEqual(toMolfile(water).split('\n').slice(2));
  });

  it('makes implicit hydrogens explicit when a file has no valence marks', () => {
    const text = ['ethanol', '  hand-written', '', countsLine(3, 2), atomLine(0, 0, 0, 'C'), atomLine(1.5, 0, 0, 'C'), atomLine(2.2, 1.2, 0, 'O'), bondLine(1, 2, 1), bondLine(2, 3, 1), 'M  END', ''].join('\n');
    const result = fromMolfile(text);
    expect(result.name).toBe('ethanol');
    expect(hillFormula(result.scene, undefined, 'plain')).toBe('C2H6O');
    expect(result.warnings.join(' ')).toMatch(/6 implicit hydrogens were made explicit/);
  });

  it('reads atom-block charge codes, aromatic bonds, deuterium symbols and flat drawings', () => {
    const lines = ['pyridinium-like', '                    2D', '', countsLine(7, 7)];
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI * i) / 3;
      let line = atomLine(1.4 * Math.cos(a), 1.4 * Math.sin(a), 0, i === 0 ? 'N' : 'C');
      if (i === 0) line = `${line.slice(0, 36)}  3${line.slice(39)}`; // charge code 3 = +1
      lines.push(line);
    }
    lines.push(atomLine(2.4, 0, 0, 'D'));
    for (let i = 0; i < 6; i++) lines.push(bondLine(i + 1, ((i + 1) % 6) + 1, 4));
    lines.push(bondLine(1, 7, 1), 'M  END', '');
    const result = fromMolfile(lines.join('\n'));
    const atoms = sortedAtoms(result.scene);
    expect(atomCharge(atoms[0]!)).toBe(1);
    expect(atoms[6]).toMatchObject({ protons: 1, neutrons: 1 });
    expect([...result.scene.bonds.values()].filter((b) => b.order === 1.5)).toHaveLength(6);
    expect(hillFormula(result.scene, undefined, 'plain')).toBe('C5H6N+');
    expect(result.warnings.join(' ')).toMatch(/flat 2D drawing/);
  });

  it('reads the V3000 dialect, and writes it for very large molecules', () => {
    const v3000 = [
      'acetate',
      '  hand-written        3D',
      '',
      '  0  0  0     0  0            999 V3000',
      'M  V30 BEGIN CTAB',
      'M  V30 COUNTS 4 3 0 0 0',
      'M  V30 BEGIN ATOM',
      'M  V30 1 C -1.2 0 0 0',
      'M  V30 2 C 0.3 0 0 0',
      'M  V30 3 O 0.9 1.1 0.2 0',
      'M  V30 4 O 0.9 -1.1 -0.2 0 CHG=-1 -',
      'M  V30 MASS=18',
      'M  V30 END ATOM',
      'M  V30 BEGIN BOND',
      'M  V30 1 1 1 2',
      'M  V30 2 2 2 3',
      'M  V30 3 1 2 4',
      'M  V30 END BOND',
      'M  V30 END CTAB',
      'M  END',
      '',
    ].join('\n');
    const result = fromMolfile(v3000);
    expect(hillFormula(result.scene, undefined, 'plain')).toBe('C2H3O2-');
    expect(sortedAtoms(result.scene)[3]).toMatchObject({ protons: 8, neutrons: 10, electrons: 9 });
    expect(sortedBonds(result.scene).map((b) => b.order)).toEqual([1, 2, 1, 1, 1, 1]);

    const big = build((e) => {
      for (let i = 0; i < 1001; i++) e.addAtom({ protons: 2, position: [i * 3, 0, 0] });
    });
    const text = toMolfile(big);
    expect(text).toMatch(/V3000/);
    expect(fromMolfile(text).scene.atoms.size).toBe(1001);
  });

  it('handles SD files with several records and data fields', () => {
    const water = exampleScene(findExample('water')!);
    const benzene = exampleScene(findExample('benzene')!);
    const text = toSDF([
      { scene: water, name: 'Water', data: { CAS: '7732-18-5', NOTE: 'line one\nline two' } },
      { scene: benzene, name: 'Benzene' },
    ]);
    expect(text.match(/\$\$\$\$/g)).toHaveLength(2);
    const records = fromSDF(text);
    expect(records.map((r) => r.name)).toEqual(['Water', 'Benzene']);
    expect(records[0]!.data).toEqual({ CAS: '7732-18-5', NOTE: 'line one\nline two' });
    expect(records[1]!.data).toEqual({});
    expect(records.map((r) => hillFormula(r.scene, undefined, 'plain'))).toEqual(['H2O', 'C6H6']);
    expect(fromSDF('\n\n')).toEqual([]);
  });

  it('refuses query atoms and truncated files with an explanation', () => {
    const withR = ['x', '', '', countsLine(1, 0), atomLine(0, 0, 0, 'R#'), 'M  END', ''].join('\n');
    expect(() => fromMolfile(withR)).toThrow(/"R#".*not a chemical element/);
    expect(() => fromMolfile('too\nshort\n')).toThrow(/counts line is missing/);
    expect(() => fromMolfile(['x', '', '', countsLine(2, 0), atomLine(0, 0, 0, 'C'), ''].join('\n'))).toThrow(MoleculeParseError);
    expect(() => fromMolfile(['x', '', '', 'not a counts line', 'M  END'].join('\n'))).toThrow(/atom and bond counts/);
    const danglingBond = ['x', '', '', countsLine(1, 1), atomLine(0, 0, 0, 'C'), bondLine(1, 5, 1), 'M  END', ''].join('\n');
    expect(() => fromMolfile(danglingBond)).toThrow(/atom 5, which is not in the file/);
  });
});

describe('PDB', () => {
  it('round-trips atoms, coordinates and multiple bonds', () => {
    for (const example of EXAMPLES) {
      const scene = exampleScene(example);
      const result = fromPDB(toPDB(scene, example.name));
      expect(result.name).toBe(example.name);
      expect(elementsOf(result.scene), example.id).toEqual(elementsOf(scene));
      expect(connectivity(result.scene), example.id).toEqual(connectivity(scene));
      expectSamePositions(scene, result.scene, 1e-3);
    }
    const order = (id: string) => sortedBonds(fromPDB(toPDB(exampleScene(findExample(id)!))).scene).map((b) => b.order);
    expect(order('carbon-dioxide')).toEqual([2, 2]);
    expect(order('ethyne').filter((o) => o === 3)).toHaveLength(1);
    // Aromatic bond orders cannot be written to PDB and come back as single bonds.
    expect(order('benzene').every((o) => o === 1)).toBe(true);
  });

  it('writes fixed-column records that keep charges', () => {
    const scene = build((e) => {
      e.addAtom({ protons: 17, charge: -1, position: [1.5, -2.25, 3.125] });
      e.addAtom({ protons: 20, charge: 2, position: [-10, 0, 0] });
    });
    const lines = toPDB(scene).split('\n');
    expect(lines[0]).toBe('HETATM    1 CL1  UNL A   1       1.500  -2.250   3.125  1.00  0.00          CL1-');
    expect(lines[0]!.length).toBe(80);
    expect(lines[1]!.slice(76, 80)).toBe('CA2+');
    expect(sortedAtoms(fromPDB(lines.join('\n')).scene).map(atomCharge)).toEqual([-1, 2]);
  });

  it('infers elements from atom names when the element columns are missing', () => {
    const record = (serial: number, name: string, x: number) =>
      `ATOM  ${String(serial).padStart(5)} ${name} ALA A   1    ${x.toFixed(3).padStart(8)}${'0.000'.padStart(8)}${'0.000'.padStart(8)}  1.00  0.00`;
    const text = [record(1, ' CA ', 0), record(2, 'CA  ', 10), record(3, 'FE  ', 20), record(4, 'HD11', 30), record(5, '1HB ', 40), record(6, ' N  ', 50), record(7, ' OXT', 60), 'END'].join('\n');
    const result = fromPDB(text);
    expect(elementsOf(result.scene)).toEqual([6, 20, 26, 1, 1, 7, 8]);
    expect(result.warnings.join(' ')).toMatch(/lists no bonds/);
  });

  it('reads only the first model and the first alternate location', () => {
    const atom = (serial: number, alt: string, x: number) =>
      `HETATM${String(serial).padStart(5)}  O  ${alt}HOH A   1    ${x.toFixed(3).padStart(8)}${'0.000'.padStart(8)}${'0.000'.padStart(8)}  1.00  0.00           O`;
    const text = ['MODEL        1', atom(1, 'A', 0), atom(2, 'B', 0.3), atom(3, ' ', 5), 'ENDMDL', 'MODEL        2', atom(1, ' ', 9), 'ENDMDL', 'END'].join('\n');
    const result = fromPDB(text);
    expect(result.scene.atoms.size).toBe(2);
    expect(result.warnings.join(' ')).toMatch(/several models/);
    expect(result.warnings.join(' ')).toMatch(/no hydrogen atoms/);
    expect(() => fromPDB('REMARK nothing here\nEND\n')).toThrow(/no ATOM or HETATM/);
  });
});

describe('format registry', () => {
  it('detects formats by file name and, failing that, by content', () => {
    const water = exampleScene(findExample('water')!);
    expect(detectFileFormat('water.XYZ', '')).toBe('xyz');
    expect(detectFileFormat('ligand.sdf', '')).toBe('sdf');
    expect(detectFileFormat('1abc.pdb', '')).toBe('pdb');
    expect(detectFileFormat('scene.matterlab.json', '')).toBe('matterlab');
    for (const format of FILE_FORMATS) {
      expect(detectFileFormat('pasted', exportMolecule(format.id, water, 'Water')), format.id).toBe(format.id);
    }
    expect(detectFileFormat('notes.txt', 'just some words')).toBeNull();
  });

  it('imports what it exports, for every format', () => {
    const scene = exampleScene(findExample('ethanol')!);
    for (const format of FILE_FORMATS.map((f) => f.id) as FileFormatId[]) {
      const [result] = importMolecules(format, exportMolecule(format, scene, 'Ethanol'));
      expect(hillFormula(result!.scene, undefined, 'plain'), format).toBe('C2H6O');
      expect(connectivity(result!.scene), format).toEqual(connectivity(scene));
    }
    expect(() => importMolecules('matterlab', '{not json')).toThrow(/not valid JSON/);
    expect(() => importMolecules('sdf', '')).toThrow(/no molecules/);
    // A project file that wraps a scene is accepted too.
    const wrapped = JSON.stringify({ name: 'My project', scene: serializeScene(scene) });
    expect(importMolecules('matterlab', wrapped)[0]).toMatchObject({ name: 'My project' });
  });

  it('tells the user what each format keeps and loses', () => {
    for (const format of FILE_FORMATS) {
      expect(format.preserves.length).toBeGreaterThan(10);
      expect(format.loses.length).toBeGreaterThan(0);
      expect(format.extensions.length).toBeGreaterThan(0);
    }
  });
});
