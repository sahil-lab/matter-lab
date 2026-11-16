import { EMPTY_SCENE, EXAMPLES, composition, editScene, elementBySymbol, exampleScene, vcentroid, vdist, vsub } from '@matterlab/core';
import type { AtomId, BondOrder, EvidenceLevel, Provenance, Scene, Vec3 } from '@matterlab/core';
import { THERMO_SPECIES, parseFormula } from '@matterlab/reactions';
import type { ParsedFormula, Phase } from '@matterlab/reactions';
import { optimizeScene } from './forcefield';
import { PubChemError, compoundsByName, conformer3d, pubchemProvenance } from './pubchem';
import { SPECIES_MODELS, SPECIES_MODELS_SOURCE } from './speciesModels.generated';
import type { SpeciesModelRecord } from './speciesModels.generated';

/** A 3D model of one chemical species, for display. */
export interface SpeciesStructure {
  /** Centred on the origin. */
  readonly scene: Scene;
  /** Distance from the centre to the farthest atom centre, in angstrom. */
  readonly extent: number;
  readonly origin: 'single-atom' | 'pubchem-3d' | 'pubchem-bonding-uff' | 'example-library';
  readonly evidence: EvidenceLevel;
  readonly provenance: Provenance | null;
  /** One sentence on what the model is and is not. */
  readonly note: string;
}

export type StructureLookup = { readonly ok: true; readonly structure: SpeciesStructure } | { readonly ok: false; readonly reason: string };

export interface SpeciesQuery {
  readonly formula: string;
  readonly phase?: Phase;
  readonly name?: string;
}

function centred(scene: Scene): { scene: Scene; extent: number } {
  const centre = vcentroid([...scene.atoms.values()].map((a) => a.position));
  const { scene: moved } = editScene(scene, 'Centre', (editor) => {
    for (const atom of scene.atoms.values()) editor.updateAtom(atom.id, { position: vsub(atom.position, centre) });
  });
  let extent = 0;
  for (const atom of moved.atoms.values()) extent = Math.max(extent, vdist(atom.position, [0, 0, 0]));
  return { scene: moved, extent };
}

/** True when a model has exactly the composition and charge the formula states. */
function matches(scene: Scene, parsed: ParsedFormula): boolean {
  const found = composition(scene);
  if (found.charge !== parsed.charge) return false;
  const expected = Object.entries(parsed.elements).filter(([, count]) => count > 0);
  if (expected.length !== found.parts.length) return false;
  return expected.every(([symbol, count]) => found.parts.some((part) => part.symbol === symbol && part.count === count));
}

/** Removes every bracketed remark that follows a space, brackets inside it included. */
function stripRemarks(name: string): string {
  let out = '';
  for (let i = 0; i < name.length; i++) {
    if (name[i] === ' ' && name[i + 1] === '(') {
      let depth = 0;
      let j = i + 1;
      for (; j < name.length; j++) {
        if (name[j] === '(') depth++;
        else if (name[j] === ')' && --depth === 0) break;
      }
      i = j;
    } else out += name[i];
  }
  return out;
}

/**
 * The name to look a species up by. Reference-table names carry remarks on the state ("water
 * vapor", "sulfate ion", "ethene (ethylene)") and sometimes a structural formula after a comma;
 * those are dropped. This is the same rule the species library was built with.
 */
export function searchName(name: string): string {
  return stripRemarks(name)
    .replace(/,\s.*$/, '')
    .replace(/\s+(vapor|vapour|ion)$/i, '')
    .trim();
}

/**
 * The name under which the reference table lists this formula. Where a formula has isomers the
 * table's compound is still the one the calculation used, so it is also the one to draw.
 */
function tableName(query: SpeciesQuery): string | undefined {
  const candidates = THERMO_SPECIES.filter((s) => s.formula === query.formula && (!query.phase || s.phase === query.phase));
  const names = new Set(candidates.map((s) => searchName(s.name)));
  return names.size === 1 ? [...names][0] : undefined;
}

/** The structure a species-model record describes, with the record's own coordinates. */
export function speciesModelScene(record: SpeciesModelRecord): Scene {
  return editScene(EMPTY_SCENE, 'Species model', (editor) => {
    const ids: AtomId[] = record.atoms.map(([z, charge, x, y, zc]) => editor.addAtom({ protons: z, charge, position: [x, y, zc] as Vec3 }));
    for (const [a, b, order] of record.bonds) editor.addBond(ids[a]!, ids[b]!, order as BondOrder);
  }).scene;
}

const sceneOf = speciesModelScene;

const cache = new Map<string, Promise<StructureLookup>>();

/**
 * Finds a 3D model for a species. A formula alone does not determine a structure (C2H6O is both
 * ethanol and dimethyl ether), so a name is needed for anything but a single atom; and whatever is
 * found is used only if its composition and charge are exactly those of the formula.
 */
export function resolveStructure(query: SpeciesQuery): Promise<StructureLookup> {
  const key = `${query.formula}|${query.phase ?? ''}|${query.name ?? ''}`;
  let result = cache.get(key);
  if (!result) {
    result = lookup(query);
    cache.set(key, result);
    // A network failure should be retried next time rather than remembered.
    void result.then((r) => {
      if (!r.ok && /reached|busy/.test(r.reason)) cache.delete(key);
    });
  }
  return result;
}

async function lookup(query: SpeciesQuery): Promise<StructureLookup> {
  let parsed: ParsedFormula;
  try {
    parsed = parseFormula(query.formula);
  } catch {
    return { ok: false, reason: 'The formula could not be read.' };
  }
  const elements = Object.entries(parsed.elements).filter(([, count]) => count > 0);
  const atomCount = elements.reduce((sum, [, count]) => sum + count, 0);
  if (atomCount === 0) return { ok: false, reason: 'The electron has no structure to show.' };

  if (atomCount === 1) {
    const element = elementBySymbol(elements[0]![0]);
    if (!element) return { ok: false, reason: 'Unknown element.' };
    const { scene } = editScene(EMPTY_SCENE, 'Atom', (editor) => {
      editor.addAtom({ protons: element.z, charge: parsed.charge, position: [0, 0, 0] as Vec3 });
    });
    const note =
      query.phase === 's'
        ? 'A single atom stands in for the solid, which is an extended lattice of many atoms.'
        : query.phase === 'aq'
          ? 'The ion is shown bare; the water molecules that surround it in solution are not drawn.'
          : 'A single atom or monatomic ion.';
    return { ok: true, structure: { scene, extent: 0, origin: 'single-atom', evidence: 'illustrative', provenance: null, note } };
  }

  // A compound known only as a solid is a lattice (a salt, an oxide, a metal), not a molecule.
  if (query.phase === 's' && !THERMO_SPECIES.some((s) => s.formula === query.formula && s.phase !== 's')) {
    return { ok: false, reason: `${query.formula}(s) is an extended solid, not a collection of separate molecules, so there is no single-molecule model to draw.` };
  }

  const given = query.name ?? tableName(query);
  if (!given) {
    return {
      ok: false,
      reason: `A formula does not determine a structure, and no name is known for ${query.formula}; several compounds can share one formula.`,
    };
  }
  const name = searchName(given);
  const key = name.toLowerCase();

  const record = SPECIES_MODELS.find((r) => r.name === key);
  if (record) {
    const scene = sceneOf(record);
    if (matches(scene, parsed)) {
      const provenance = pubchemProvenance(record.cid, SPECIES_MODELS_SOURCE.retrieved);
      if (record.coordinates === '3d') {
        return {
          ok: true,
          structure: {
            ...centred(scene),
            origin: 'pubchem-3d',
            evidence: 'computed',
            provenance: { ...provenance, notes: 'PubChem3D conformer: a computed model geometry (MMFF94s force field).' },
            note: `PubChem3D conformer of ${record.title} (CID ${record.cid}): a computed model geometry (MMFF94s), not a measured structure.`,
          },
        };
      }
      // PubChem knows the bonding but offers no conformer; the geometry is then computed here.
      try {
        const relaxed = await optimizeScene(scene);
        const { scene: shaped } = editScene(scene, 'Relax', (editor) => {
          for (const [id, position] of relaxed.positions) editor.updateAtom(id, { position });
        });
        return {
          ok: true,
          structure: {
            ...centred(shaped),
            origin: 'pubchem-bonding-uff',
            evidence: 'computed',
            provenance: { ...provenance, notes: `Bonding from PubChem (CID ${record.cid}); geometry optimised with the Universal Force Field.` },
            note: `Bonding of ${record.title} from PubChem (CID ${record.cid}), which has no conformer for it; the shape is a Universal Force Field model geometry, not a measured structure.`,
          },
        };
      } catch (error) {
        return { ok: false, reason: `PubChem has no 3D model of ${name}, and the force field could not build one: ${error instanceof Error ? error.message : 'unknown error'}` };
      }
    }
  }

  const example = EXAMPLES.find((e) => e.name.toLowerCase().replace(/\s+ion$/, '') === key);
  if (example) {
    const scene = exampleScene(example);
    if (matches(scene, parsed)) {
      return {
        ok: true,
        structure: {
          ...centred(scene),
          origin: 'example-library',
          evidence: 'computed',
          provenance: { source: 'MATTER LAB example library', notes: 'ETKDG + MMFF94 geometry computed with RDKit.' },
          note: 'A force-field model geometry (MMFF94), close to but not the same as the measured structure.',
        },
      };
    }
  }

  // Not in the library shipped with the app: ask PubChem directly.
  let withoutConformer = false;
  try {
    for (const compound of await compoundsByName(name, 3)) {
      const structure = await conformer3d(compound.cid);
      if (!structure) {
        withoutConformer = true;
        continue;
      }
      if (!matches(structure.scene, parsed)) continue;
      return {
        ok: true,
        structure: {
          ...centred(structure.scene),
          origin: 'pubchem-3d',
          evidence: 'computed',
          provenance: structure.provenance,
          note: `PubChem3D conformer of ${compound.title} (CID ${compound.cid}): a computed model geometry (MMFF94s), not a measured structure.`,
        },
      };
    }
  } catch (error) {
    if (error instanceof PubChemError) return { ok: false, reason: error.message };
    throw error;
  }
  return {
    ok: false,
    reason: withoutConformer
      ? `PubChem holds no 3D model for ${name}. Salts, metals and many radicals are not single molecules with one conformer.`
      : `No 3D model matching ${query.formula} was found under the name “${name}”.`,
  };
}
