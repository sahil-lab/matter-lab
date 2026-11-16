import { EXAMPLES, editScene, exampleScene, findExample, vcentroid, vsub } from '@matterlab/core';
import type { Scene } from '@matterlab/core';
import { analyseScene } from './chem';
import { optimizeScene } from './forcefield';
import { pubchemUrl } from './pubchem';
import { SPECIES_MODELS } from './speciesModels.generated';
import { speciesModelScene } from './structures';

/**
 * The structures that ship with the application: the example molecules and the species models of
 * the Reaction Laboratory. This is what "the built-in library" means wherever it is searched.
 */

export interface LibraryEntry {
  /** `example:<id>` for an example molecule, `pubchem:<cid>` for a species model. */
  readonly id: string;
  readonly name: string;
  readonly inchiKey: string | null;
  /** Canonical SMILES, or `null` when RDKit cannot read the record (it is then not searched by structure). */
  readonly smiles: string | null;
  readonly url?: string;
}

let library: Promise<LibraryEntry[]> | null = null;

async function buildLibrary(): Promise<LibraryEntry[]> {
  const entries = new Map<string, LibraryEntry>();
  for (const example of EXAMPLES) {
    const analysis = await analyseScene(exampleScene(example));
    entries.set(analysis.inchiKey ?? `example:${example.id}`, { id: `example:${example.id}`, name: example.name, inchiKey: analysis.inchiKey, smiles: analysis.ok ? analysis.smiles : null });
  }
  for (const record of SPECIES_MODELS) {
    // A compound that is also a built-in example is one record, not two.
    if (entries.has(record.inchiKey)) continue;
    let smiles: string | null = null;
    try {
      // Where PubChem has no conformer the coordinates are a flat drawing: bonding only, no shape to read anything from.
      const analysis = await analyseScene(speciesModelScene(record), true, record.coordinates === '2d');
      smiles = analysis.ok ? analysis.smiles : null;
    } catch {
      smiles = null;
    }
    // The key is the one PubChem publishes for the record.
    entries.set(record.inchiKey, { id: `pubchem:${record.cid}`, name: record.title, inchiKey: record.inchiKey, smiles, url: pubchemUrl(record.cid) });
  }
  return [...entries.values()];
}

/** Every structure of the built-in library, with the identifiers it is searched by. Worked out once per session. */
export function localLibrary(): Promise<LibraryEntry[]> {
  if (!library) {
    library = buildLibrary();
    library.catch(() => {
      library = null;
    });
  }
  return library;
}

/** A 3D model ready to be placed in the Architect, with what should be said about where it comes from. */
export interface StructureModel {
  /** Centred on the origin. */
  readonly scene: Scene;
  readonly name: string;
  /** What the model is and is not, most important first. */
  readonly notes: readonly string[];
}

/** The same structure with its centre of positions at the origin. */
export function centredScene(scene: Scene): Scene {
  if (scene.atoms.size === 0) return scene;
  const centre = vcentroid([...scene.atoms.values()].map((atom) => atom.position));
  return editScene(scene, 'Centre', (editor) => {
    for (const atom of scene.atoms.values()) editor.moveAtom(atom.id, vsub(atom.position, centre));
  }).scene;
}

/** The 3D model of a library entry. Species PubChem has no conformer for are relaxed with the force field first. */
export async function libraryModel(id: string): Promise<StructureModel> {
  if (id.startsWith('example:')) {
    const example = findExample(id.slice('example:'.length));
    if (!example) throw new Error('That example is no longer in the library.');
    return {
      scene: centredScene(exampleScene(example)),
      name: example.name,
      notes: ['From the example library: a force-field model geometry (ETKDG + MMFF94, computed with RDKit), close to but not the same as a measured structure.'],
    };
  }
  const record = SPECIES_MODELS.find((r) => `pubchem:${r.cid}` === id);
  if (!record) throw new Error('That structure is no longer in the library.');
  const scene = speciesModelScene(record);
  if (record.coordinates === '3d') {
    return {
      scene: centredScene(scene),
      name: record.title,
      notes: [`PubChem3D conformer of ${record.title} (CID ${record.cid}): a computed model geometry (MMFF94s), not a measured structure.`],
    };
  }
  // PubChem knows the bonding but offers no conformer; the shape is then computed here.
  const relaxed = await optimizeScene(scene);
  const shaped = editScene(scene, 'Relax', (editor) => {
    for (const [atomId, position] of relaxed.positions) editor.moveAtom(atomId, position);
  }).scene;
  return {
    scene: centredScene(shaped),
    name: record.title,
    notes: [`Bonding of ${record.title} from PubChem (CID ${record.cid}), which has no conformer for it; the shape is a Universal Force Field model geometry, not a measured structure.`],
  };
}
