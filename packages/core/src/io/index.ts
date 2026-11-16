import type { Scene } from '../types';
import { fromMolfile, fromSDF, toMolfile, toSDF } from './molfile';
import { SceneFormatError, deserializeScene, serializeScene } from './native';
import { fromPDB, toPDB } from './pdb';
import { MoleculeParseError, fromXYZ, toXYZ } from './xyz';
import type { ImportResult } from './xyz';

export * from './molfile';
export * from './native';
export * from './pdb';
export * from './xyz';

export type FileFormatId = 'matterlab' | 'mol' | 'sdf' | 'xyz' | 'pdb';

export interface FileFormatInfo {
  readonly id: FileFormatId;
  readonly label: string;
  readonly extensions: readonly string[];
  readonly mimeType: string;
  /** What survives a round trip through this format. */
  readonly preserves: string;
  /** What the format cannot express, so the user knows before exporting. */
  readonly loses: string;
}

export const FILE_FORMATS: readonly FileFormatInfo[] = [
  {
    id: 'matterlab',
    label: 'MATTER LAB scene',
    extensions: ['matterlab.json', 'json'],
    mimeType: 'application/json',
    preserves: 'Everything: atoms, isotopes, electron counts, bonds and bond orders, exact coordinates.',
    loses: 'Nothing.',
  },
  {
    id: 'mol',
    label: 'MDL Molfile',
    extensions: ['mol', 'mdl'],
    mimeType: 'chemical/x-mdl-molfile',
    preserves: 'Atoms, coordinates, bonds and bond orders, formal charges, specified isotopes.',
    loses: 'Aromatic bonds are written as alternating single and double bonds. Coordinates are rounded to 0.0001 Å.',
  },
  {
    id: 'sdf',
    label: 'SD file',
    extensions: ['sdf', 'sd'],
    mimeType: 'chemical/x-mdl-sdfile',
    preserves: 'The same as a Molfile, for one or more molecules, plus named data fields.',
    loses: 'Aromatic bonds are written as alternating single and double bonds. Coordinates are rounded to 0.0001 Å.',
  },
  {
    id: 'xyz',
    label: 'XYZ coordinates',
    extensions: ['xyz'],
    mimeType: 'chemical/x-xyz',
    preserves: 'Element and position of every atom.',
    loses: 'Bonds, bond orders, charges and isotopes. Bonds are re-inferred from distances on import.',
  },
  {
    id: 'pdb',
    label: 'Protein Data Bank',
    extensions: ['pdb', 'ent'],
    mimeType: 'chemical/x-pdb',
    preserves: 'Atoms, coordinates (rounded to 0.001 Å), bonds, and double/triple bond orders via repeated CONECT records.',
    loses: 'Isotopes and aromatic bond orders.',
  },
];

export function findFileFormat(id: FileFormatId): FileFormatInfo {
  return FILE_FORMATS.find((f) => f.id === id)!;
}

/** Guesses a file's format from its name, falling back to its content. Returns `null` when unsure. */
export function detectFileFormat(fileName: string, text: string): FileFormatId | null {
  const lower = fileName.toLowerCase();
  for (const format of FILE_FORMATS) {
    if (format.extensions.some((ext) => lower.endsWith(`.${ext}`))) return format.id;
  }
  const head = text.slice(0, 4000);
  const trimmed = head.trimStart();
  if (trimmed.startsWith('{')) return 'matterlab';
  if (/^(ATOM  |HETATM)/m.test(head)) return 'pdb';
  if (/V[23]000/.test(head.split(/\r?\n/).slice(0, 5).join('\n'))) return text.includes('$$$$') ? 'sdf' : 'mol';
  if (/^\s*\d+\s*$/.test(head.split(/\r?\n/)[0] ?? '')) return 'xyz';
  return null;
}

/**
 * Reads molecule files of any supported format. SD files may yield several molecules.
 * Throws `MoleculeParseError` or `SceneFormatError` with a message suitable for showing to the user.
 */
export function importMolecules(format: FileFormatId, text: string): ImportResult[] {
  switch (format) {
    case 'matterlab': {
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new SceneFormatError('The file is not valid JSON.');
      }
      // Accept both a bare scene and a project file that wraps one.
      const candidate =
        typeof json === 'object' && json !== null && 'scene' in json ? (json as { scene: unknown }).scene : json;
      const name =
        typeof json === 'object' && json !== null && typeof (json as { name?: unknown }).name === 'string'
          ? (json as { name: string }).name
          : '';
      return [{ scene: deserializeScene(candidate), name, warnings: [] }];
    }
    case 'mol':
      return [fromMolfile(text)];
    case 'sdf': {
      const records = fromSDF(text);
      if (records.length === 0) throw new MoleculeParseError('The SD file contains no molecules.');
      return records;
    }
    case 'xyz':
      return [fromXYZ(text)];
    case 'pdb':
      return [fromPDB(text)];
  }
}

export function exportMolecule(format: FileFormatId, scene: Scene, name = ''): string {
  switch (format) {
    case 'matterlab':
      return `${JSON.stringify(serializeScene(scene), null, 1)}\n`;
    case 'mol':
      return toMolfile(scene, { name });
    case 'sdf':
      return toSDF([{ scene, name }]);
    case 'xyz':
      return toXYZ(scene, name);
    case 'pdb':
      return toPDB(scene, name);
  }
}
