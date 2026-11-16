import { editScene, fromMolfile, getElement, hillFormula, sortedAtoms } from '@matterlab/core';
import type { AtomId, Scene, Vec3 } from '@matterlab/core';
import type { StereoTags } from '../workers/rdkit.worker';
import { analyseScene, sceneStereo, smilesToMolblock } from './chem';
import { UnsupportedStructureError, optimizeScene } from './forcefield';
import { centredScene } from './library';
import type { StructureModel } from './library';
import { conformer3d } from './pubchem';
import type { PubChemCompound } from './pubchem';
import { configurationErrors, flipDoubleBond, invertCentre, wedgeHeights } from './stereoRepair';
import type { Positions } from './stereoRepair';

/**
 * Building a 3D model from a SMILES string.
 *
 * A SMILES string says which atoms are bonded and, where it is marked, the configuration of
 * stereocentres and double bonds; it says nothing about where the atoms are. RDKit reads the
 * string and makes a flat drawing with every hydrogen. The Universal Force Field then relaxes the
 * drawing into three dimensions. A force field keeps whatever configuration its starting geometry
 * happens to have, so the result is compared with the SMILES centre by centre, wrong ones are
 * inverted and the model is relaxed again, until it has the configuration that was asked for. A
 * model that cannot be brought there is not returned.
 */

/** Largest structure, hydrogens included, that is built from a SMILES string. */
export const BUILD_ATOM_LIMIT = 400;
const MAX_REPAIR_ROUNDS = 6;

/** The model could not be built; `details` say why, in RDKit's or the force field's own words where there are any. */
export class BuildError extends Error {
  constructor(
    message: string,
    readonly details: readonly string[] = [],
  ) {
    super(message);
    this.name = 'BuildError';
  }
}

export interface BuiltModel extends StructureModel {
  /** Canonical SMILES of the structure as RDKit reads the input. */
  readonly smiles: string;
  readonly atomCount: number;
  /** Whether the final relaxation converged to a minimum of the force field. */
  readonly converged: boolean;
  /** Stereocentres and double bonds whose configuration the SMILES states; the model has all of them as stated. */
  readonly specified: { readonly centres: number; readonly doubleBonds: number };
  /** Possible stereocentres and double bonds the SMILES leaves open; the model has one of the possibilities. */
  readonly unspecified: { readonly centres: number; readonly doubleBonds: number };
  /** Configurations that came out wrong from the first relaxation and were inverted. */
  readonly corrected: number;
}

export interface BuildOptions {
  readonly signal?: AbortSignal;
  /** Called with a few words on what is being done. */
  readonly onStage?: (stage: string) => void;
}

const pair = (a: number, b: number): string => (a < b ? `${a}-${b}` : `${b}-${a}`);

function withPositions(scene: Scene, positions: ReadonlyMap<AtomId, Vec3>): Scene {
  return editScene(scene, 'Place', (editor) => {
    for (const [id, position] of positions) editor.moveAtom(id, position);
  }).scene;
}

async function relax(scene: Scene, signal: AbortSignal | undefined): Promise<{ scene: Scene; converged: boolean }> {
  try {
    const outcome = await optimizeScene(scene, { ...(signal ? { signal } : {}) });
    return { scene: withPositions(scene, outcome.positions), converged: outcome.result.converged };
  } catch (error) {
    if (error instanceof UnsupportedStructureError) throw new BuildError('The Universal Force Field, which gives the model its shape, cannot treat this structure.', error.reasons);
    throw error;
  }
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Builds a 3D model of the structure a SMILES string describes. Throws `BuildError` when it cannot. */
export async function buildFromSmiles(input: string, options: BuildOptions = {}): Promise<BuiltModel> {
  const stage = options.onStage ?? (() => {});
  const text = input.trim();
  if (text.length === 0) throw new BuildError('Type a SMILES string first.');

  stage('reading the SMILES');
  const parsed = await smilesToMolblock(text, BUILD_ATOM_LIMIT);
  if (!parsed.ok || !parsed.smiles || !parsed.stereo) throw new BuildError('RDKit cannot read this as a SMILES string.', parsed.errors);
  if (parsed.atomCount > BUILD_ATOM_LIMIT) {
    throw new BuildError(`With its hydrogens the structure has ${parsed.atomCount.toLocaleString('en-US')} atoms; models are built from SMILES for up to ${BUILD_ATOM_LIMIT}.`, [
      'A force field started from a flat drawing gives poor shapes for molecules this large. Import a file with 3D coordinates instead.',
    ]);
  }
  if (!parsed.molblock) throw new BuildError('RDKit could not make a drawing of the structure to start from.', parsed.errors);

  let flat: Scene;
  try {
    flat = fromMolfile(parsed.molblock).scene;
  } catch (error) {
    throw new BuildError('The drawing RDKit made of the structure could not be read back.', [error instanceof Error ? error.message : String(error)]);
  }
  const atoms = sortedAtoms(flat);
  // Every later step relies on the atoms being the ones RDKit numbered, in its order.
  if (atoms.length !== parsed.atomCount) {
    throw new BuildError('This kind of structure cannot be built from SMILES here.', [
      'Read back from the drawing it has a different number of atoms than the SMILES describes. That happens for radicals and for unusual valences, whose missing hydrogens are filled in.',
    ]);
  }
  const ids = atoms.map((atom) => atom.id);
  const heights = wedgeHeights(parsed.molblock, atoms.length);
  const lifted = withPositions(flat, new Map(atoms.map((atom, i) => [atom.id, [atom.position[0], atom.position[1], heights[i]!] as Vec3])));

  stage('relaxing the geometry');
  let relaxed = await relax(lifted, options.signal);
  const read = async (scene: Scene): Promise<StereoTags> => {
    const tags = await sceneStereo(scene);
    if (!tags) throw new BuildError('RDKit does not accept the model that was built, so its configuration cannot be checked.');
    return tags;
  };
  let model = await read(relaxed.scene);
  let corrected = 0;
  let rounds = 0;
  while (rounds < MAX_REPAIR_ROUNDS) {
    const wrong = configurationErrors(parsed.stereo, model);
    if (wrong.centres.length + wrong.doubleBonds.length === 0) break;
    const positions: Positions = new Map(sortedAtoms(relaxed.scene).map((atom) => [atom.id, atom.position]));
    let changed = 0;
    for (const index of wrong.centres) if (invertCentre(relaxed.scene, positions, ids[index]!)) changed++;
    for (const [a, b] of wrong.doubleBonds) if (flipDoubleBond(relaxed.scene, positions, ids[a]!, ids[b]!)) changed++;
    // Nothing that is wrong can be put right by moving groups of atoms: atoms and bonds held on all sides by rings.
    if (changed === 0) break;
    rounds++;
    corrected += changed;
    stage(`correcting ${plural(changed, 'configuration')}`);
    relaxed = await relax(withPositions(relaxed.scene, positions), options.signal);
    model = await read(relaxed.scene);
  }

  const wrong = configurationErrors(parsed.stereo, model);
  if (wrong.centres.length + wrong.doubleBonds.length > 0) {
    const where = [
      ...wrong.centres.map((index) => `${getElement(atoms[index]!.protons).symbol} (atom ${index + 1} of the structure)`),
      ...wrong.doubleBonds.map(([a, b]) => `the double bond between atoms ${a + 1} and ${b + 1}`),
    ];
    throw new BuildError('A model with the configuration this SMILES asks for could not be built, so none is offered.', [
      `${rounds === 0 ? 'The model' : `After ${plural(rounds, 'round')} of corrections the model still`} differs from the SMILES at: ${where.join('; ')}.${rounds < MAX_REPAIR_ROUNDS ? ' These are held by rings on all sides, where a configuration cannot be changed by moving groups of atoms.' : ''}`,
      'Look the compound up by name instead: PubChem’s models have the stated configuration. Or remove the stereo marks from the SMILES to get a model whose configuration is left open.',
    ]);
  }

  // Last, the model as a whole must be the compound that was asked for.
  const analysis = await analyseScene(relaxed.scene);
  if (!analysis.ok) throw new BuildError('RDKit does not accept the model that was built.', analysis.errors);
  const skeleton = (key: string | null): string | null => (key ? key.slice(0, 14) : null);
  if (!skeleton(parsed.inchiKey) || skeleton(analysis.inchiKey) !== skeleton(parsed.inchiKey)) {
    throw new BuildError('The model that was built is not the compound the SMILES describes, so it is not offered.', [
      `The SMILES is read as ${parsed.smiles}; the model is read as ${analysis.smiles ?? 'an unreadable structure'}.`,
    ]);
  }

  const asked = new Set(parsed.stereo.doubleBonds.map((entry) => pair(entry.a, entry.b)));
  const openBonds = model.doubleBonds.filter((entry) => !asked.has(pair(entry.a, entry.b))).length;
  const openCentres = parsed.stereo.unspecified.length;
  const notes = ['Built from the SMILES: RDKit supplies the bonding, the Universal Force Field the shape. It is one model geometry, the minimum nearest to a flat drawing, not a measured structure and not necessarily the most stable conformer.'];
  const stated = parsed.stereo.centres.length + parsed.stereo.doubleBonds.length;
  if (stated > 0) {
    notes.push(
      `The SMILES states ${[parsed.stereo.centres.length > 0 ? plural(parsed.stereo.centres.length, 'stereocentre') : '', parsed.stereo.doubleBonds.length > 0 ? plural(parsed.stereo.doubleBonds.length, 'double-bond arrangement') : ''].filter(Boolean).join(' and ')}; the model was checked to have ${stated === 1 ? 'it' : 'all of them'} as stated.`,
    );
  }
  if (openCentres + openBonds > 0) {
    notes.push(
      `The SMILES leaves ${[openCentres > 0 ? plural(openCentres, 'possible stereocentre') : '', openBonds > 0 ? plural(openBonds, 'double bond') : ''].filter(Boolean).join(' and ')} open; the model shows one of the possible arrangements, chosen by nothing in particular.`,
    );
  }
  if (!relaxed.converged) notes.push('The force field did not converge, so the shape is not at a minimum. Optimise the geometry again once it is open.');

  return {
    scene: centredScene(relaxed.scene),
    name: hillFormula(relaxed.scene, undefined, 'plain'),
    notes,
    smiles: parsed.smiles,
    atomCount: atoms.length,
    converged: relaxed.converged,
    specified: { centres: parsed.stereo.centres.length, doubleBonds: parsed.stereo.doubleBonds.length },
    unspecified: { centres: openCentres, doubleBonds: openBonds },
    corrected,
  };
}

/**
 * A 3D model of a compound found on PubChem: its PubChem3D conformer where there is one, and
 * otherwise a model built here from the SMILES PubChem gives for it.
 */
export async function pubchemModel(compound: PubChemCompound, options: BuildOptions = {}): Promise<StructureModel> {
  options.onStage?.('asking PubChem for its 3D model');
  const structure = await conformer3d(compound.cid);
  if (structure) {
    return {
      scene: centredScene(structure.scene),
      name: compound.title,
      notes: [`PubChem3D conformer of ${compound.title} (CID ${compound.cid}): a computed model geometry (MMFF94s force field), not a measured structure.`],
    };
  }
  if (!compound.smiles) throw new BuildError(`PubChem holds neither a 3D model nor a SMILES for ${compound.title} (CID ${compound.cid}).`);
  const built = await buildFromSmiles(compound.smiles, options);
  return { scene: built.scene, name: compound.title, notes: [`PubChem holds no 3D model of ${compound.title} (CID ${compound.cid}); this one was built here from the SMILES PubChem gives for it.`, ...built.notes] };
}
