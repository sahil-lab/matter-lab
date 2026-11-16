import { atomCharge, atomMassNumber } from '../chem/atom';
import { addHydrogens } from '../chem/hydrogens';
import { analyseValences } from '../chem/valence';
import { elementBySymbol, getElement } from '../elements';
import { EMPTY_SCENE, SceneEditor } from '../scene/editor';
import { sortedAtoms, sortedBonds } from '../scene/queries';
import type { AtomId, BondOrder, Scene } from '../types';
import { MoleculeParseError } from './xyz';
import type { ImportResult } from './xyz';

const int3 = (n: number) => String(n).padStart(3);
const coord = (v: number) => v.toFixed(4).padStart(10);

const CHARGE_TO_CODE: Readonly<Record<number, number>> = { 3: 1, 2: 2, 1: 3, [-1]: 5, [-2]: 6, [-3]: 7 };
const CODE_TO_CHARGE: Readonly<Record<number, number>> = { 1: 3, 2: 2, 3: 1, 5: -1, 6: -2, 7: -3 };

export interface MolfileOptions {
  readonly name?: string;
  readonly comment?: string;
  /**
   * 2 when the coordinates are those of a flat drawing, which says nothing about the shape of the
   * molecule; a reader then takes no stereochemistry from them. Default 3: real coordinates.
   */
  readonly dimensions?: 2 | 3;
}

interface WritableMolecule {
  readonly atoms: ReturnType<typeof sortedAtoms>;
  readonly bonds: Array<{ a: number; b: number; type: number }>;
  /** Valence field per atom (0 = unmarked). */
  readonly valences: number[];
}

/**
 * Molfiles should be written in Kekule form with every atom's valence stated, so a reader adds no
 * implicit hydrogens and sees exactly the structure that was drawn. If the aromatic bonds cannot be
 * kekulised they are written as aromatic (type 4) and left unmarked.
 */
function prepare(scene: Scene): WritableMolecule {
  const atoms = sortedAtoms(scene);
  const index = new Map<AtomId, number>(atoms.map((a, i) => [a.id, i + 1]));
  const analysis = analyseValences(scene);
  const aromaticAtoms = new Set<AtomId>();
  const bonds = sortedBonds(scene).map((b) => {
    let type: number = b.order;
    if (b.order === 1.5) {
      const kekule = analysis.kekule.ok ? analysis.kekule.orders.get(b.id) : undefined;
      if (kekule) type = kekule;
      else {
        type = 4;
        aromaticAtoms.add(b.a);
        aromaticAtoms.add(b.b);
      }
    }
    return { a: index.get(b.a)!, b: index.get(b.b)!, type };
  });
  const valences = atoms.map((a) => {
    if (aromaticAtoms.has(a.id)) return 0;
    const v = analysis.atoms.get(a.id)!.valence;
    return v === 0 ? 15 : v <= 14 ? v : 0;
  });
  return { atoms, bonds, valences };
}

function propertyLines(tag: 'CHG' | 'ISO', entries: Array<[number, number]>): string[] {
  const lines: string[] = [];
  for (let i = 0; i < entries.length; i += 8) {
    const chunk = entries.slice(i, i + 8);
    lines.push(`M  ${tag}${int3(chunk.length)}${chunk.map(([atom, value]) => ` ${int3(atom)} ${int3(value)}`).join('')}`);
  }
  return lines;
}

function headerLines(options: MolfileOptions): string[] {
  const clean = (s: string | undefined) => (s ?? '').replace(/[\r\n]+/g, ' ').slice(0, 80);
  return [clean(options.name), `  MATTRLAB          ${options.dimensions === 2 ? '2D' : '3D'}`, clean(options.comment)];
}

function toV3000(scene: Scene, options: MolfileOptions): string {
  const { atoms, bonds, valences } = prepare(scene);
  const lines = [...headerLines(options), '  0  0  0     0  0            999 V3000', 'M  V30 BEGIN CTAB'];
  lines.push(`M  V30 COUNTS ${atoms.length} ${bonds.length} 0 0 0`, 'M  V30 BEGIN ATOM');
  atoms.forEach((atom, i) => {
    const q = atomCharge(atom);
    const a = atomMassNumber(atom);
    const v = valences[i]!;
    const extras = [q !== 0 ? ` CHG=${q}` : '', a !== null ? ` MASS=${a}` : '', v !== 0 ? ` VAL=${v === 15 ? -1 : v}` : ''].join('');
    const [x, y, z] = atom.position;
    lines.push(`M  V30 ${i + 1} ${getElement(atom.protons).symbol} ${x.toFixed(4)} ${y.toFixed(4)} ${z.toFixed(4)} 0${extras}`);
  });
  lines.push('M  V30 END ATOM', 'M  V30 BEGIN BOND');
  bonds.forEach((b, i) => lines.push(`M  V30 ${i + 1} ${b.type} ${b.a} ${b.b}`));
  lines.push('M  V30 END BOND', 'M  V30 END CTAB', 'M  END');
  return `${lines.join('\n')}\n`;
}

/**
 * Writes an MDL molfile (V2000; V3000 automatically when there are more than 999 atoms or bonds).
 * Charges and specified isotopes are preserved. Aromatic bonds are written in Kekule form.
 */
export function toMolfile(scene: Scene, options: MolfileOptions = {}): string {
  if (scene.atoms.size > 999 || scene.bonds.size > 999) return toV3000(scene, options);
  const { atoms, bonds, valences } = prepare(scene);
  const lines = [...headerLines(options), `${int3(atoms.length)}${int3(bonds.length)}  0  0  0  0  0  0  0  0999 V2000`];
  const charges: Array<[number, number]> = [];
  const isotopes: Array<[number, number]> = [];
  atoms.forEach((atom, i) => {
    const q = atomCharge(atom);
    const a = atomMassNumber(atom);
    if (q !== 0) charges.push([i + 1, q]);
    if (a !== null) isotopes.push([i + 1, a]);
    const [x, y, z] = atom.position;
    lines.push(
      `${coord(x)}${coord(y)}${coord(z)} ${getElement(atom.protons).symbol.padEnd(3)} 0${int3(CHARGE_TO_CODE[q] ?? 0)}  0  0  0${int3(valences[i]!)}  0  0  0  0  0  0`,
    );
  });
  for (const b of bonds) lines.push(`${int3(b.a)}${int3(b.b)}${int3(b.type)}  0  0  0  0`);
  lines.push(...propertyLines('CHG', charges), ...propertyLines('ISO', isotopes), 'M  END');
  return `${lines.join('\n')}\n`;
}

interface ParsedAtom {
  symbol: string;
  x: number;
  y: number;
  z: number;
  charge: number;
  massNumber: number | null;
  /** True when the file states the atom's valence, which means it has no implicit hydrogens. */
  valenceMarked: boolean;
}

interface ParsedBond {
  a: number;
  b: number;
  type: number;
}

function parseV2000(lines: string[], start: number, atomCount: number, bondCount: number) {
  const atoms: ParsedAtom[] = [];
  for (let i = 0; i < atomCount; i++) {
    const line = lines[start + i];
    const lineNo = start + i + 1;
    if (line === undefined) throw new MoleculeParseError(`Molfile ends before atom ${i + 1} of ${atomCount}.`);
    const x = Number(line.slice(0, 10));
    const y = Number(line.slice(10, 20));
    const z = Number(line.slice(20, 30));
    if (![x, y, z].every(Number.isFinite) || line.slice(0, 30).trim() === '') {
      throw new MoleculeParseError(`Molfile line ${lineNo}: could not read atom coordinates.`);
    }
    const massDiff = Number(line.slice(34, 36)) || 0;
    const symbol = line.slice(31, 34).trim();
    const element = elementBySymbol(symbol === 'D' || symbol === 'T' ? 'H' : symbol);
    atoms.push({
      symbol,
      x,
      y,
      z,
      charge: CODE_TO_CHARGE[Number(line.slice(36, 39)) || 0] ?? 0,
      massNumber: massDiff !== 0 && element ? Math.round(element.atomicWeight) + massDiff : null,
      valenceMarked: (Number(line.slice(48, 51)) || 0) !== 0,
    });
  }

  const bonds: ParsedBond[] = [];
  const bondStart = start + atomCount;
  for (let i = 0; i < bondCount; i++) {
    const line = lines[bondStart + i];
    if (line === undefined) throw new MoleculeParseError(`Molfile ends before bond ${i + 1} of ${bondCount}.`);
    const a = Number(line.slice(0, 3));
    const b = Number(line.slice(3, 6));
    const type = Number(line.slice(6, 9));
    if (![a, b, type].every(Number.isInteger)) {
      throw new MoleculeParseError(`Molfile line ${bondStart + i + 1}: could not read the bond.`);
    }
    bonds.push({ a, b, type });
  }

  let chargesReset = false;
  let end = bondStart + bondCount;
  for (; end < lines.length; end++) {
    const line = lines[end]!;
    if (line.startsWith('M  END')) break;
    if (line.startsWith('$$$$')) break;
    const tag = line.slice(0, 6);
    if (tag !== 'M  CHG' && tag !== 'M  ISO') continue;
    if (tag === 'M  CHG' && !chargesReset) {
      // Per the specification, charge property lines supersede the charge codes in the atom block.
      for (const atom of atoms) atom.charge = 0;
      chargesReset = true;
    }
    const n = Number(line.slice(6, 9)) || 0;
    for (let k = 0; k < n; k++) {
      const atomIndex = Number(line.slice(10 + 8 * k, 13 + 8 * k));
      const value = Number(line.slice(14 + 8 * k, 17 + 8 * k));
      const atom = atoms[atomIndex - 1];
      if (!atom || !Number.isInteger(value)) continue;
      if (tag === 'M  CHG') atom.charge = value;
      else atom.massNumber = value;
    }
  }
  return { atoms, bonds, end };
}

function parseV3000(lines: string[], start: number) {
  const atoms: ParsedAtom[] = [];
  const bonds: ParsedBond[] = [];
  const atomIndex = new Map<number, number>();
  let section: 'atom' | 'bond' | null = null;
  let end = start;
  let pending = '';
  for (; end < lines.length; end++) {
    const raw = lines[end]!;
    if (raw.startsWith('M  END') || raw.startsWith('$$$$')) break;
    if (!raw.startsWith('M  V30 ')) continue;
    let body = pending + raw.slice(7);
    if (body.endsWith('-')) {
      pending = body.slice(0, -1);
      continue;
    }
    pending = '';
    body = body.trim();
    if (body === 'BEGIN ATOM') section = 'atom';
    else if (body === 'BEGIN BOND') section = 'bond';
    else if (body.startsWith('END ') || body.startsWith('BEGIN ') || body.startsWith('COUNTS')) section = body.startsWith('END') ? null : section;
    else if (section === 'atom') {
      const t = body.split(/\s+/);
      const [x, y, z] = [Number(t[2]), Number(t[3]), Number(t[4])];
      if (t.length < 5 || ![x, y, z].every(Number.isFinite)) throw new MoleculeParseError(`Molfile line ${end + 1}: could not read the V3000 atom.`);
      const props = new Map(t.slice(6).map((p) => p.split('=') as [string, string]));
      atomIndex.set(Number(t[0]), atoms.length + 1);
      atoms.push({
        symbol: t[1]!,
        x,
        y,
        z,
        charge: Number(props.get('CHG') ?? 0) || 0,
        massNumber: props.has('MASS') ? Number(props.get('MASS')) : null,
        valenceMarked: props.has('VAL'),
      });
    } else if (section === 'bond') {
      const t = body.split(/\s+/).map(Number);
      if (t.length < 4 || !t.slice(0, 4).every(Number.isInteger)) throw new MoleculeParseError(`Molfile line ${end + 1}: could not read the V3000 bond.`);
      bonds.push({ type: t[1]!, a: atomIndex.get(t[2]!) ?? -1, b: atomIndex.get(t[3]!) ?? -1 });
    }
  }
  return { atoms, bonds, end };
}

const BOND_TYPE_TO_ORDER: Readonly<Record<number, BondOrder>> = { 1: 1, 2: 2, 3: 3, 4: 1.5 };

function buildScene(parsed: { atoms: ParsedAtom[]; bonds: ParsedBond[] }, name: string, flat2d: boolean): ImportResult {
  const warnings: string[] = [];
  const editor = new SceneEditor(EMPTY_SCENE);
  const ids: AtomId[] = [];
  const unmarked: AtomId[] = [];

  parsed.atoms.forEach((a, i) => {
    let symbol = a.symbol;
    let massNumber = a.massNumber;
    if (symbol === 'D' || symbol === 'T') {
      massNumber = symbol === 'D' ? 2 : 3;
      symbol = 'H';
    }
    const element = elementBySymbol(symbol);
    if (!element) {
      throw new MoleculeParseError(
        `Atom ${i + 1} has the symbol "${a.symbol}", which is not a chemical element. Query atoms, R-groups and pseudo-atoms are not supported.`,
      );
    }
    const neutrons = massNumber === null ? null : massNumber - element.z;
    if (neutrons !== null && neutrons < 0) throw new MoleculeParseError(`Atom ${i + 1}: mass number ${massNumber} is too small for ${element.name}.`);
    const id = editor.addAtom({ protons: element.z, neutrons, charge: a.charge, position: [a.x, a.y, a.z] });
    ids.push(id);
    if (!a.valenceMarked) unmarked.push(id);
  });

  let queryBonds = 0;
  for (const b of parsed.bonds) {
    const a = ids[b.a - 1];
    const c = ids[b.b - 1];
    if (a === undefined || c === undefined) throw new MoleculeParseError(`A bond refers to atom ${a === undefined ? b.a : b.b}, which is not in the file.`);
    if (a === c) continue;
    let order = BOND_TYPE_TO_ORDER[b.type];
    if (!order) {
      queryBonds++;
      order = 1;
    }
    editor.addBond(a, c, order);
  }
  if (queryBonds > 0) {
    warnings.push(`${queryBonds} bond${queryBonds === 1 ? ' has' : 's have'} a query bond type that MATTER LAB cannot represent; ${queryBonds === 1 ? 'it was' : 'they were'} imported as single.`);
  }

  // Atoms without a stated valence carry implicit hydrogens in the molfile convention; make them explicit.
  const hydrogens = addHydrogens(editor, unmarked);
  if (hydrogens.length > 0) {
    warnings.push(
      `${hydrogens.length} implicit hydrogen${hydrogens.length === 1 ? ' was' : 's were'} made explicit at idealised positions. Optimise the geometry to refine them.`,
    );
  }
  if (flat2d && parsed.atoms.length > 3) {
    warnings.push('The file holds flat 2D drawing coordinates, not a 3D structure. Optimise the geometry to obtain a three-dimensional shape.');
  }
  return { scene: editor.commit('Import molfile').scene, name, warnings };
}

function parseMolBlock(lines: string[], start: number): { result: ImportResult; end: number } {
  const counts = lines[start + 3];
  if (counts === undefined) throw new MoleculeParseError('The molfile is too short: the counts line is missing.');
  const name = (lines[start] ?? '').trim();
  const dimension = (lines[start + 1] ?? '').slice(20, 22).toUpperCase();
  let parsed: { atoms: ParsedAtom[]; bonds: ParsedBond[]; end: number };
  if (counts.includes('V3000')) parsed = parseV3000(lines, start + 4);
  else {
    const atomCount = Number(counts.slice(0, 3));
    const bondCount = Number(counts.slice(3, 6));
    if (!Number.isInteger(atomCount) || !Number.isInteger(bondCount) || counts.slice(0, 6).trim() === '') {
      throw new MoleculeParseError(`Molfile line ${start + 4}: could not read the atom and bond counts.`);
    }
    parsed = parseV2000(lines, start + 4, atomCount, bondCount);
  }
  const flat = dimension === '2D' || (dimension !== '3D' && parsed.atoms.every((a) => a.z === 0));
  return { result: buildScene(parsed, name, flat), end: parsed.end };
}

/** Reads an MDL molfile (V2000 or V3000). Charges, isotopes and aromatic bonds are preserved. */
export function fromMolfile(text: string): ImportResult {
  return parseMolBlock(text.split(/\r?\n/), 0).result;
}

export interface SdfRecord extends ImportResult {
  /** Data fields attached to the record (`> <NAME>` blocks). */
  readonly data: Readonly<Record<string, string>>;
}

/** Reads every record of an SD file. */
export function fromSDF(text: string): SdfRecord[] {
  const lines = text.split(/\r?\n/);
  const records: SdfRecord[] = [];
  let start = 0;
  while (start < lines.length) {
    if (lines.slice(start).every((l) => l.trim() === '')) break;
    const { result, end } = parseMolBlock(lines, start);
    const data: Record<string, string> = {};
    // A block without "M  END" stops at the record separator itself.
    let i = lines[end]?.startsWith('$$$$') ? end : end + 1;
    for (; i < lines.length && !lines[i]!.startsWith('$$$$'); i++) {
      const field = /^>.*<([^>]+)>/.exec(lines[i]!);
      if (!field) continue;
      const values: string[] = [];
      for (i++; i < lines.length && lines[i]!.trim() !== '' && !lines[i]!.startsWith('$$$$'); i++) values.push(lines[i]!);
      data[field[1]!] = values.join('\n');
      if (lines[i]?.startsWith('$$$$')) break;
    }
    records.push({ ...result, data });
    start = i + 1;
  }
  return records;
}

export function toSDF(records: ReadonlyArray<{ scene: Scene; name?: string; data?: Readonly<Record<string, string>> }>): string {
  return records
    .map((r) => {
      const fields = Object.entries(r.data ?? {})
        .map(([key, value]) => `>  <${key}>\n${value}\n`)
        .join('\n');
      return `${toMolfile(r.scene, { name: r.name })}${fields}${fields ? '\n' : ''}$$$$\n`;
    })
    .join('');
}
