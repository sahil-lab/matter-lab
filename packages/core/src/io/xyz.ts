import { perceiveBonds } from '../chem/bonds';
import { composition, formatFormula } from '../chem/formula';
import { elementBySymbol, findElement, getElement } from '../elements';
import { EMPTY_SCENE, SceneEditor } from '../scene/editor';
import { sortedAtoms } from '../scene/queries';
import type { Scene } from '../types';

/** Thrown when a molecule file cannot be read. The message names the line and the problem. */
export class MoleculeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoleculeParseError';
  }
}

export interface ImportResult {
  readonly scene: Scene;
  /** Title or name found in the file, if any. */
  readonly name: string;
  /** Things the user should know about what the format could not express or what was inferred. */
  readonly warnings: readonly string[];
}

const fmt = (v: number, width: number, digits: number) => v.toFixed(digits).padStart(width);

/**
 * Writes an XYZ file (element symbol and Cartesian coordinates in angstrom).
 * XYZ stores no bonds, charges or isotopes, so that information is not preserved.
 */
export function toXYZ(scene: Scene, title = ''): string {
  const atoms = sortedAtoms(scene);
  const total = composition(scene);
  const comment = (title || formatFormula(total, 'plain')).replace(/[\r\n]+/g, ' ');
  const lines = [String(atoms.length), comment];
  for (const atom of atoms) {
    const symbol = getElement(atom.protons).symbol;
    lines.push(`${symbol.padEnd(3)}${fmt(atom.position[0], 14, 6)}${fmt(atom.position[1], 14, 6)}${fmt(atom.position[2], 14, 6)}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Reads the first frame of an XYZ file. Because XYZ carries no connectivity, bonds are inferred from
 * interatomic distances and are all single; the result includes a warning saying so.
 */
export function fromXYZ(text: string): ImportResult {
  const lines = text.split(/\r?\n/);
  let cursor = 0;
  while (cursor < lines.length && lines[cursor]!.trim() === '') cursor++;
  const count = Number(lines[cursor]?.trim());
  if (!Number.isInteger(count) || count < 0) {
    throw new MoleculeParseError(`XYZ line ${cursor + 1}: expected the number of atoms, found "${lines[cursor] ?? ''}".`);
  }
  const name = (lines[cursor + 1] ?? '').trim();
  const first = cursor + 2;
  let available = 0;
  while (available < count && (lines[first + available] ?? '').trim() !== '') available++;
  if (available < count) {
    throw new MoleculeParseError(`XYZ file declares ${count} atoms but contains only ${available} atom line${available === 1 ? '' : 's'}.`);
  }

  const editor = new SceneEditor(EMPTY_SCENE);
  const placed = [];
  for (let i = 0; i < count; i++) {
    const lineNo = first + i + 1;
    const parts = lines[first + i]!.trim().split(/\s+/);
    if (parts.length < 4) throw new MoleculeParseError(`XYZ line ${lineNo}: expected "element x y z".`);
    const token = parts[0]!;
    const element = /^\d+$/.test(token) ? findElement(Number(token)) : elementBySymbol(token);
    if (!element) throw new MoleculeParseError(`XYZ line ${lineNo}: unknown element "${token}".`);
    const [x, y, z] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
    if (![x, y, z].every(Number.isFinite)) throw new MoleculeParseError(`XYZ line ${lineNo}: coordinates must be numbers.`);
    const id = editor.addAtom({ protons: element.z, position: [x, y, z] });
    placed.push({ id, protons: element.z, position: [x, y, z] as const });
  }

  const warnings: string[] = [];
  const bonds = perceiveBonds(placed);
  for (const bond of bonds) editor.addBond(bond.a, bond.b, 1);
  if (count > 1) {
    warnings.push(
      'XYZ files store no bonds. Connectivity was inferred from interatomic distances and every bond was set to single; review the bond orders.',
    );
  }
  const frameTail = lines.slice(first + count).filter((l) => l.trim() !== '');
  if (frameTail.length > 0) warnings.push('The file contains more than one frame; only the first was imported.');

  return { scene: editor.commit('Import XYZ').scene, name, warnings };
}
