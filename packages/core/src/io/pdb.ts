import { atomCharge } from '../chem/atom';
import { perceiveBonds } from '../chem/bonds';
import { elementBySymbol, getElement } from '../elements';
import type { ElementInfo } from '../elements';
import { EMPTY_SCENE, SceneEditor } from '../scene/editor';
import { sortedAtoms, sortedBonds } from '../scene/queries';
import type { AtomId, BondOrder, Scene } from '../types';
import { MoleculeParseError } from './xyz';
import type { ImportResult } from './xyz';

/**
 * Works out the element of a PDB atom. The element columns (77-78) are authoritative when present;
 * otherwise the atom name is used, where a two-letter symbol starts in column 13 and a one-letter
 * symbol in column 14 (so " CA " is an alpha carbon and "CA  " is calcium).
 */
function elementOf(line: string): ElementInfo | undefined {
  const explicit = line.slice(76, 78).trim();
  if (explicit) {
    const element = elementBySymbol(explicit);
    if (element) return element;
  }
  const name = line.slice(12, 16);
  const first = name[0] ?? ' ';
  if (first !== ' ' && !/\d/.test(first)) {
    const hydrogenStyle = first === 'H' && name.trim().length === 4;
    const two = hydrogenStyle ? undefined : elementBySymbol(name.slice(0, 2).trim());
    return two ?? elementBySymbol(first);
  }
  const letters = name.trim().replace(/^\d+/, '');
  return letters ? elementBySymbol(letters[0]!) : undefined;
}

function chargeOf(line: string): number {
  const m = /^(\d)([+-])$/.exec(line.slice(78, 80).trim());
  return m ? Number(m[1]) * (m[2] === '+' ? 1 : -1) : 0;
}

/**
 * Reads the first model of a PDB file. Bonds come from CONECT records where present and are
 * otherwise inferred from interatomic distances (as single bonds), because PDB files do not list
 * the bonds within standard residues.
 */
export function fromPDB(text: string): ImportResult {
  const editor = new SceneEditor(EMPTY_SCENE);
  const bySerial = new Map<number, AtomId>();
  const placed: Array<{ id: AtomId; protons: number; position: readonly [number, number, number] }> = [];
  const conect = new Map<string, number>();
  const titles: string[] = [];
  let modelClosed = false;
  let hydrogens = 0;

  text.split(/\r?\n/).forEach((line, i) => {
    const record = line.slice(0, 6);
    if (record === 'ENDMDL') modelClosed = true;
    else if (record === 'TITLE ' || record === 'COMPND' || record === 'HEADER') titles.push(line.slice(10).trim());
    else if ((record === 'ATOM  ' || record === 'HETATM') && !modelClosed) {
      const altLoc = line[16] ?? ' ';
      if (altLoc !== ' ' && altLoc !== 'A' && altLoc !== '1') return;
      const element = elementOf(line);
      if (!element) throw new MoleculeParseError(`PDB line ${i + 1}: could not determine the element of atom "${line.slice(12, 16).trim()}".`);
      const position = [Number(line.slice(30, 38)), Number(line.slice(38, 46)), Number(line.slice(46, 54))] as const;
      if (!position.every(Number.isFinite) || line.slice(30, 54).trim() === '') {
        throw new MoleculeParseError(`PDB line ${i + 1}: could not read the atom coordinates.`);
      }
      const id = editor.addAtom({ protons: element.z, charge: chargeOf(line), position });
      const serial = Number(line.slice(6, 11));
      if (Number.isInteger(serial)) bySerial.set(serial, id);
      placed.push({ id, protons: element.z, position });
      if (element.z === 1) hydrogens++;
    } else if (record === 'CONECT') {
      const from = Number(line.slice(6, 11));
      for (let c = 11; c + 5 <= Math.max(line.length, 31) && c < 31; c += 5) {
        const to = Number(line.slice(c, c + 5));
        if (!line.slice(c, c + 5).trim() || !Number.isInteger(from) || !Number.isInteger(to)) continue;
        // Each bond is normally listed from both ends, and a multiple bond repeats the partner.
        if (from < to) conect.set(`${from}:${to}`, (conect.get(`${from}:${to}`) ?? 0) + 1);
        else if (!conect.has(`${to}:${from}`)) conect.set(`${to}:${from}`, 0);
      }
    }
  });

  if (placed.length === 0) throw new MoleculeParseError('The PDB file contains no ATOM or HETATM records.');

  const warnings: string[] = [];
  for (const bond of perceiveBonds(placed)) editor.addBond(bond.a, bond.b, 1);
  let explicit = 0;
  for (const [pair, repeats] of conect) {
    const [s1, s2] = pair.split(':').map(Number);
    const a = bySerial.get(s1!);
    const b = bySerial.get(s2!);
    if (a === undefined || b === undefined || a === b) continue;
    editor.addBond(a, b, Math.min(3, Math.max(1, repeats)) as BondOrder);
    explicit++;
  }
  warnings.push(
    explicit > 0
      ? `${explicit} bond${explicit === 1 ? '' : 's'} came from CONECT records; the rest were inferred from interatomic distances as single bonds. Review the bond orders.`
      : 'The file lists no bonds. Connectivity was inferred from interatomic distances and every bond was set to single; review the bond orders.',
  );
  if (hydrogens === 0 && placed.length > 1) {
    warnings.push('The file contains no hydrogen atoms, as is usual for crystal structures. Valences will appear incomplete until hydrogens are added.');
  }
  if (modelClosed && /\nMODEL /.test(text.slice(text.indexOf('ENDMDL')))) {
    warnings.push('The file contains several models; only the first was imported.');
  }

  return { scene: editor.commit('Import PDB').scene, name: titles.join(' ').trim(), warnings };
}

/**
 * Writes a PDB file with one HETATM record per atom and CONECT records for the bonds (a multiple
 * bond repeats its partner). Aromatic bonds are written once, and isotopes are not representable.
 */
export function toPDB(scene: Scene, title = ''): string {
  const atoms = sortedAtoms(scene);
  if (atoms.length > 99999) throw new RangeError('PDB files cannot hold more than 99,999 atoms.');
  const serial = new Map<AtomId, number>(atoms.map((a, i) => [a.id, i + 1]));
  const lines: string[] = [];
  if (title) lines.push(`TITLE     ${title.replace(/[\r\n]+/g, ' ').slice(0, 70)}`);

  const counters = new Map<string, number>();
  atoms.forEach((atom, i) => {
    const symbol = getElement(atom.protons).symbol.toUpperCase();
    const n = (counters.get(symbol) ?? 0) + 1;
    counters.set(symbol, n);
    const stem = symbol.length === 1 ? ` ${symbol}` : symbol;
    const name = (stem.length + String(n).length <= 4 ? `${stem}${n}` : stem).padEnd(4);
    const q = atomCharge(atom);
    const charge = q === 0 || Math.abs(q) > 9 ? '  ' : `${Math.abs(q)}${q > 0 ? '+' : '-'}`;
    const [x, y, z] = atom.position;
    lines.push(
      `HETATM${String(i + 1).padStart(5)} ${name} UNL A   1    ${x.toFixed(3).padStart(8)}${y.toFixed(3).padStart(8)}${z.toFixed(3).padStart(8)}  1.00  0.00          ${symbol.padStart(2)}${charge}`,
    );
  });

  const partners = new Map<number, number[]>();
  for (const bond of sortedBonds(scene)) {
    const a = serial.get(bond.a)!;
    const b = serial.get(bond.b)!;
    const repeats = bond.order === 2 ? 2 : bond.order === 3 ? 3 : 1;
    for (const [from, to] of [
      [a, b],
      [b, a],
    ] as const) {
      const list = partners.get(from) ?? [];
      for (let r = 0; r < repeats; r++) list.push(to);
      partners.set(from, list);
    }
  }
  for (const [from, list] of [...partners.entries()].sort((x, y) => x[0] - y[0])) {
    for (let i = 0; i < list.length; i += 4) {
      lines.push(`CONECT${String(from).padStart(5)}${list.slice(i, i + 4).map((s) => String(s).padStart(5)).join('')}`);
    }
  }
  lines.push('END');
  return `${lines.join('\n')}\n`;
}
