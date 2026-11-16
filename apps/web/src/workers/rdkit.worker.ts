import initRDKitModule from '@rdkit/rdkit';
import type { MainModule, Mol } from '@rdkit/rdkit';
import wasmUrl from '@rdkit/rdkit/RDKit_minimal.wasm?url';
import { serve } from '../science/rpc';

/**
 * RDKit (compiled to WebAssembly) in its own thread. It is the independent second opinion on every
 * structure: MATTER LAB's own rule-based checks say what looks wrong, RDKit says whether a mature
 * cheminformatics toolkit accepts the structure, and gives it canonical identifiers.
 */

/** What RDKit makes of a structure. Atom and bond indices follow the order of the molfile given. */
export interface ChemAnalysis {
  readonly ok: boolean;
  readonly rdkitVersion: string;
  /** RDKit's own messages when it rejects the structure. */
  readonly errors: readonly string[];
  /** What RDKit remarked on while reading the structure and writing its identifiers; it did not reject it for these. */
  readonly warnings: readonly string[];
  /** Canonical SMILES with hydrogens implicit. */
  readonly smiles: string | null;
  readonly inchi: string | null;
  readonly inchiKey: string | null;
  readonly aromaticAtoms: readonly number[];
  readonly aromaticBonds: readonly number[];
  readonly rings: ReadonlyArray<readonly number[]>;
  /** Atoms RDKit treats as radical centres, with their number of unpaired electrons. */
  readonly radicals: ReadonlyArray<{ readonly atom: number; readonly electrons: number }>;
  readonly descriptors: Readonly<Record<string, number>> | null;
}

/**
 * The configurations RDKit finds in a structure, as Cahn-Ingold-Prelog labels. Labels do not
 * depend on how the atoms are numbered, so two descriptions of one compound can be compared by
 * them. Atom indices follow the order of the structure given.
 */
export interface StereoTags {
  /** Stereocentres with a definite configuration: R or S (r or s for pseudo-asymmetric atoms). */
  readonly centres: ReadonlyArray<{ readonly atom: number; readonly label: string }>;
  /** Atoms that could be stereocentres but whose configuration is not stated. */
  readonly unspecified: readonly number[];
  /** Double bonds with a definite arrangement: E or Z. */
  readonly doubleBonds: ReadonlyArray<{ readonly a: number; readonly b: number; readonly label: string }>;
}

export interface SmilesResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
  /** Molfile with every hydrogen explicit and a flat 2D layout; `null` when the SMILES is not valid or the structure is larger than was asked to be drawn. */
  readonly molblock: string | null;
  /** Canonical SMILES of the structure as RDKit reads it. */
  readonly smiles: string | null;
  /** Standard InChIKey of the structure as RDKit reads it. */
  readonly inchiKey: string | null;
  /** Number of atoms of `molblock`, hydrogens included. */
  readonly atomCount: number;
  /** The configurations the SMILES states, with the atom indices of `molblock`. */
  readonly stereo: StereoTags | null;
}

export interface SearchEntry {
  readonly id: string;
  readonly smiles: string;
}

export interface SearchHit {
  readonly id: string;
  /** Tanimoto similarity of Morgan fingerprints (radius 2, 2048 bits); present for similarity searches. */
  readonly similarity?: number;
  /** Atoms of the entry matched by the query; present for substructure searches. */
  readonly matchedAtoms?: readonly number[];
}

export interface SearchResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly hits: readonly SearchHit[];
  /** Entries RDKit could not read, which were therefore not searched. */
  readonly skipped: readonly string[];
}

let modulePromise: Promise<MainModule> | null = null;
let errorLog: { get_buffer(): string; clear_buffer(): void } | null = null;
let warningLog: { get_buffer(): string; clear_buffer(): void } | null = null;

function rdkit(): Promise<MainModule> {
  modulePromise ??= initRDKitModule({ locateFile: () => wasmUrl }).then((module) => {
    // Both logs are captured: what RDKit has to say is returned with each result instead of being
    // printed to the console, where nobody would connect it with the structure it is about.
    errorLog = module.set_log_capture('rdApp.error');
    warningLog = module.set_log_capture('rdApp.warning');
    return module;
  });
  return modulePromise;
}

function drain(log: { get_buffer(): string; clear_buffer(): void } | null): string[] {
  if (!log) return [];
  const text = log.get_buffer();
  log.clear_buffer();
  return text
    .split('\n')
    .map((line) => line.replace(/^\[\d\d:\d\d:\d\d\]\s*/, '').trim())
    .filter((line) => line.length > 0);
}

/** RDKit's pending error messages, without their timestamps. */
function drainErrors(): string[] {
  return drain(errorLog);
}

/** RDKit's pending warnings, each once. */
function drainWarnings(): string[] {
  return [...new Set(drain(warningLog))];
}

function withMol<T>(mol: Mol | null, use: (mol: Mol) => T): T | null {
  if (!mol) return null;
  try {
    return mol.is_valid() ? use(mol) : null;
  } finally {
    mol.delete();
  }
}

const MORGAN = JSON.stringify({ radius: 2, nBits: 2048 });

/** RDKit writes its labels in brackets: "(R)", "(E)", and "(?)" for a centre left unspecified. */
function stereoOf(mol: Mol): StereoTags {
  const tags = JSON.parse(mol.get_stereo_tags()) as { CIP_atoms?: Array<[number, string]>; CIP_bonds?: Array<[number, number, string]> };
  const bare = (label: string): string => label.replace(/[()]/g, '');
  const atoms = (tags.CIP_atoms ?? []).map(([atom, label]) => ({ atom, label: bare(label) }));
  return {
    centres: atoms.filter((entry) => /^[RSrs]$/.test(entry.label)),
    unspecified: atoms.filter((entry) => !/^[RSrs]$/.test(entry.label)).map((entry) => entry.atom),
    doubleBonds: (tags.CIP_bonds ?? []).map(([a, b, label]) => ({ a, b, label: bare(label) })).filter((entry) => /^[EZ]$/.test(entry.label)),
  };
}

function popcount(bytes: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    let b = bytes[i]!;
    b = b - ((b >> 1) & 0x55);
    b = (b & 0x33) + ((b >> 2) & 0x33);
    n += (b + (b >> 4)) & 0x0f;
  }
  return n;
}

function tanimoto(a: Uint8Array, b: Uint8Array): number {
  let both = 0;
  for (let i = 0; i < a.length; i++) {
    let v = a[i]! & b[i]!;
    v = v - ((v >> 1) & 0x55);
    v = (v & 0x33) + ((v >> 2) & 0x33);
    both += (v + (v >> 4)) & 0x0f;
  }
  const either = popcount(a) + popcount(b) - both;
  return either === 0 ? 0 : both / either;
}

const fingerprintCache = new Map<string, Uint8Array | null>();

function fingerprintOf(module: MainModule, smiles: string): Uint8Array | null {
  let fp = fingerprintCache.get(smiles);
  if (fp === undefined) {
    fp = withMol(module.get_mol(smiles), (mol) => new Uint8Array(mol.get_morgan_fp_as_uint8array(MORGAN) as Uint8Array));
    drainErrors();
    fingerprintCache.set(smiles, fp);
  }
  return fp;
}

const methods = {
  async version(): Promise<string> {
    return (await rdkit()).version();
  },

  /** Sanitises a structure and derives its identifiers. The molfile must list every hydrogen explicitly. */
  async analyse({ molblock, identifiers = true }: { molblock: string; identifiers?: boolean }): Promise<ChemAnalysis> {
    const module = await rdkit();
    drainErrors();
    drainWarnings();
    const empty = {
      rdkitVersion: module.version(),
      smiles: null,
      inchi: null,
      inchiKey: null,
      aromaticAtoms: [],
      aromaticBonds: [],
      rings: [],
      radicals: [],
      descriptors: null,
    };
    const mol = module.get_mol(molblock, JSON.stringify({ removeHs: false }));
    if (!mol || !mol.is_valid()) {
      mol?.delete();
      const errors = drainErrors();
      return { ...empty, ok: false, errors: errors.length > 0 ? errors : ['RDKit could not read the structure.'], warnings: drainWarnings() };
    }
    try {
      const json = JSON.parse(mol.get_json()) as {
        molecules: Array<{
          atoms: Array<{ nRad?: number }>;
          extensions?: Array<{ name: string; aromaticAtoms?: number[]; aromaticBonds?: number[]; atomRings?: number[][] }>;
        }>;
      };
      const molecule = json.molecules[0]!;
      const representation = molecule.extensions?.find((e) => e.name === 'rdkitRepresentation');
      const radicals: Array<{ atom: number; electrons: number }> = [];
      molecule.atoms.forEach((atom, i) => {
        if (atom.nRad && atom.nRad > 0) radicals.push({ atom: i, electrons: atom.nRad });
      });

      let smiles: string | null = null;
      let inchi: string | null = null;
      let inchiKey: string | null = null;
      let descriptors: Record<string, number> | null = null;
      if (identifiers) {
        // Identifiers are written with implicit hydrogens, which is the convention for all three.
        // Hydrogen isotopes are part of the identity and stay.
        mol.remove_hs_in_place(JSON.stringify({ removeIsotopes: false }));
        smiles = mol.get_smiles() || null;
        // The InChI is derived from the canonical SMILES rather than from the 3D molecule. Reading a
        // 3D structure flags every tetrahedral atom with a handedness, including atoms that are not
        // stereocentres (the bridgeheads of adamantane); canonicalisation drops those, the InChI
        // writer would not.
        const canonical = smiles ? module.get_mol(smiles) : null;
        const source = canonical && canonical.is_valid() ? canonical : mol;
        try {
          inchi = source.get_inchi() || null;
          inchiKey = inchi ? module.get_inchikey_for_inchi(inchi) || null : null;
          descriptors = JSON.parse(source.get_descriptors()) as Record<string, number>;
        } finally {
          canonical?.delete();
        }
      }
      return {
        ok: true,
        rdkitVersion: module.version(),
        errors: drainErrors(),
        warnings: drainWarnings(),
        smiles,
        inchi,
        inchiKey,
        aromaticAtoms: representation?.aromaticAtoms ?? [],
        aromaticBonds: representation?.aromaticBonds ?? [],
        rings: representation?.atomRings ?? [],
        radicals,
        descriptors,
      };
    } finally {
      mol.delete();
    }
  },

  /**
   * Reads a SMILES string and lays it out flat with all hydrogens, ready to be relaxed into 3D.
   * A structure with more than `maxAtoms` atoms is read but not drawn: `molblock` is then `null`.
   */
  async fromSmiles({ smiles, maxAtoms = Infinity }: { smiles: string; maxAtoms?: number }): Promise<SmilesResult> {
    const module = await rdkit();
    drainErrors();
    const failed = { ok: false, molblock: null, smiles: null, inchiKey: null, atomCount: 0, stereo: null } as const;
    const mol = module.get_mol(smiles.trim());
    if (!mol || !mol.is_valid()) {
      mol?.delete();
      const errors = drainErrors();
      return { ...failed, errors: errors.length > 0 ? errors : ['That is not a valid SMILES string.'] };
    }
    try {
      const canonical = mol.get_smiles();
      const inchi = mol.get_inchi();
      const inchiKey = inchi ? module.get_inchikey_for_inchi(inchi) || null : null;
      mol.add_hs_in_place();
      const atomCount = mol.get_num_atoms();
      // Asked for before the drawing is made: what is not a real stereocentre loses its mark here,
      // and so gets no wedge in the drawing either.
      const stereo = stereoOf(mol);
      let molblock: string | null = null;
      if (atomCount <= maxAtoms) {
        mol.set_new_coords(true);
        molblock = mol.get_molblock();
      }
      return { ok: true, errors: drainErrors(), molblock, smiles: canonical, inchiKey, atomCount, stereo };
    } finally {
      mol.delete();
    }
  },

  /** The configurations of a structure given with its coordinates, which is where RDKit reads them from. */
  async stereo({ molblock }: { molblock: string }): Promise<StereoTags | null> {
    const module = await rdkit();
    drainErrors();
    const tags = withMol(module.get_mol(molblock, JSON.stringify({ removeHs: false })), stereoOf);
    drainErrors();
    drainWarnings();
    return tags;
  },

  /** A 2D structure diagram as SVG, for lists and reports. */
  async depict({ smiles, width, height }: { smiles: string; width: number; height: number }): Promise<string | null> {
    const module = await rdkit();
    const svg = withMol(module.get_mol(smiles), (mol) =>
      mol.get_svg_with_highlights(
        JSON.stringify({ width, height, backgroundColour: [0, 0, 0, 0], bondLineWidth: 1.6, addStereoAnnotation: true, clearBackground: false }),
      ),
    );
    drainErrors();
    return svg;
  },

  /**
   * Searches a list of structures. `substructure`: entries that contain the query pattern (SMARTS,
   * or SMILES read as a pattern). `similarity`: Tanimoto similarity of Morgan fingerprints to the
   * query SMILES, highest first.
   */
  async search({ mode, query, library, threshold = 0 }: { mode: 'substructure' | 'similarity'; query: string; library: readonly SearchEntry[]; threshold?: number }): Promise<SearchResult> {
    const module = await rdkit();
    drainErrors();
    const hits: SearchHit[] = [];
    const skipped: string[] = [];

    if (mode === 'similarity') {
      const queryFp = fingerprintOf(module, query.trim());
      if (!queryFp) return { ok: false, errors: ['The query is not a valid SMILES string.'], hits, skipped };
      for (const entry of library) {
        const fp = fingerprintOf(module, entry.smiles);
        if (!fp) {
          skipped.push(entry.id);
          continue;
        }
        const similarity = tanimoto(queryFp, fp);
        if (similarity >= threshold) hits.push({ id: entry.id, similarity });
      }
      hits.sort((a, b) => b.similarity! - a.similarity!);
      return { ok: true, errors: [], hits, skipped };
    }

    const pattern = module.get_qmol(query.trim());
    if (!pattern || !pattern.is_valid()) {
      pattern?.delete();
      const errors = drainErrors();
      return { ok: false, errors: errors.length > 0 ? errors : ['The query is not a valid SMARTS or SMILES pattern.'], hits, skipped };
    }
    try {
      for (const entry of library) {
        const match = withMol(module.get_mol(entry.smiles), (mol) => JSON.parse(mol.get_substruct_match(pattern)) as { atoms?: number[] });
        if (match === null) skipped.push(entry.id);
        else if (match.atoms && match.atoms.length > 0) hits.push({ id: entry.id, matchedAtoms: match.atoms });
      }
      drainErrors();
      return { ok: true, errors: [], hits, skipped };
    } finally {
      pattern.delete();
    }
  },
};

export type RdkitMethods = typeof methods;

serve(methods);
