import { isAtomicNumber } from '../elements';
import { MAX_ELECTRONS, MAX_NEUTRONS } from '../scene/editor';
import { sortedAtoms, sortedBonds } from '../scene/queries';
import type { Atom, Bond, BondOrder, Scene } from '../types';
import { BOND_ORDERS } from '../types';

export const SCENE_FORMAT = 'matterlab.scene';
export const SCENE_FORMAT_VERSION = 1;

/** The JSON shape of a saved scene. Coordinates are in angstrom; `n: null` means no isotope is specified. */
export interface SerializedScene {
  readonly format: typeof SCENE_FORMAT;
  readonly version: number;
  readonly units: { readonly length: 'angstrom' };
  readonly atoms: ReadonlyArray<{ id: number; p: number; n: number | null; e: number; x: number; y: number; z: number }>;
  readonly bonds: ReadonlyArray<{ id: number; a: number; b: number; order: number }>;
  readonly nextAtomId: number;
  readonly nextBondId: number;
}

/** Thrown when a file is not a readable MATTER LAB scene. The message says what is wrong and where. */
export class SceneFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SceneFormatError';
  }
}

export function serializeScene(scene: Scene): SerializedScene {
  return {
    format: SCENE_FORMAT,
    version: SCENE_FORMAT_VERSION,
    units: { length: 'angstrom' },
    atoms: sortedAtoms(scene).map((a) => ({
      id: a.id,
      p: a.protons,
      n: a.neutrons,
      e: a.electrons,
      x: a.position[0],
      y: a.position[1],
      z: a.position[2],
    })),
    bonds: sortedBonds(scene).map((b) => ({ id: b.id, a: b.a, b: b.b, order: b.order })),
    nextAtomId: scene.nextAtomId,
    nextBondId: scene.nextBondId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integer(value: unknown, what: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new SceneFormatError(`${what} must be a whole number between ${min} and ${max}.`);
  }
  return value;
}

function finite(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new SceneFormatError(`${what} must be a finite number.`);
  return value;
}

/**
 * Rebuilds a scene from saved JSON, checking every field. Invalid input is rejected with a
 * `SceneFormatError` rather than loaded in a damaged state.
 */
export function deserializeScene(data: unknown): Scene {
  if (!isRecord(data)) throw new SceneFormatError('The file does not contain a scene object.');
  if (data.format !== SCENE_FORMAT) throw new SceneFormatError('This is not a MATTER LAB scene file.');
  const version = integer(data.version, 'The scene format version', 1, Number.MAX_SAFE_INTEGER);
  if (version > SCENE_FORMAT_VERSION) {
    throw new SceneFormatError(
      `This scene was saved by a newer version of MATTER LAB (format ${version}); this version reads up to format ${SCENE_FORMAT_VERSION}.`,
    );
  }
  if (isRecord(data.units) && data.units.length !== undefined && data.units.length !== 'angstrom') {
    throw new SceneFormatError(`Unsupported length unit "${String(data.units.length)}"; expected angstrom.`);
  }
  if (!Array.isArray(data.atoms) || !Array.isArray(data.bonds)) {
    throw new SceneFormatError('The scene must contain "atoms" and "bonds" lists.');
  }

  const atoms = new Map<number, Atom>();
  data.atoms.forEach((raw: unknown, i: number) => {
    const at = `Atom entry ${i + 1}`;
    if (!isRecord(raw)) throw new SceneFormatError(`${at} is not an object.`);
    const id = integer(raw.id, `${at}: id`, 1, Number.MAX_SAFE_INTEGER);
    if (atoms.has(id)) throw new SceneFormatError(`${at}: id ${id} is used more than once.`);
    if (typeof raw.p !== 'number' || !isAtomicNumber(raw.p)) {
      throw new SceneFormatError(`${at}: proton count ${String(raw.p)} is not a known element (1-118).`);
    }
    const neutrons = raw.n === null || raw.n === undefined ? null : integer(raw.n, `${at}: neutron count`, 0, MAX_NEUTRONS);
    atoms.set(id, {
      id,
      protons: raw.p,
      neutrons,
      electrons: integer(raw.e, `${at}: electron count`, 0, MAX_ELECTRONS),
      position: [finite(raw.x, `${at}: x`), finite(raw.y, `${at}: y`), finite(raw.z, `${at}: z`)],
    });
  });

  const bonds = new Map<number, Bond>();
  const pairs = new Set<string>();
  data.bonds.forEach((raw: unknown, i: number) => {
    const at = `Bond entry ${i + 1}`;
    if (!isRecord(raw)) throw new SceneFormatError(`${at} is not an object.`);
    const id = integer(raw.id, `${at}: id`, 1, Number.MAX_SAFE_INTEGER);
    if (bonds.has(id)) throw new SceneFormatError(`${at}: id ${id} is used more than once.`);
    const a = integer(raw.a, `${at}: first atom`, 1, Number.MAX_SAFE_INTEGER);
    const b = integer(raw.b, `${at}: second atom`, 1, Number.MAX_SAFE_INTEGER);
    if (a === b) throw new SceneFormatError(`${at} bonds atom ${a} to itself.`);
    if (!atoms.has(a) || !atoms.has(b)) throw new SceneFormatError(`${at} refers to an atom that is not in the file.`);
    const pair = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (pairs.has(pair)) throw new SceneFormatError(`${at}: atoms ${a} and ${b} are bonded more than once.`);
    pairs.add(pair);
    if (typeof raw.order !== 'number' || !BOND_ORDERS.includes(raw.order as BondOrder)) {
      throw new SceneFormatError(`${at}: bond order ${String(raw.order)} is not one of 1, 1.5, 2, 3.`);
    }
    bonds.set(id, { id, a, b, order: raw.order as BondOrder });
  });

  // Never trust stored counters to be ahead of the ids actually in use.
  const maxAtom = Math.max(0, ...atoms.keys());
  const maxBond = Math.max(0, ...bonds.keys());
  const storedNextAtom = typeof data.nextAtomId === 'number' && Number.isInteger(data.nextAtomId) ? data.nextAtomId : 0;
  const storedNextBond = typeof data.nextBondId === 'number' && Number.isInteger(data.nextBondId) ? data.nextBondId : 0;
  return {
    atoms,
    bonds,
    nextAtomId: Math.max(storedNextAtom, maxAtom + 1),
    nextBondId: Math.max(storedNextBond, maxBond + 1),
  };
}
