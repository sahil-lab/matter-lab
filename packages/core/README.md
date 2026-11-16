# @matterlab/core

The shared model of MATTER LAB: what an atom, a bond and a scene are, how a scene is edited and
undone, the reference data for elements and nuclides, rule-based chemistry on top of it, and the file
formats. Pure TypeScript with no dependencies; it runs in the browser, in Web Workers and in Node.
Every other package and the web application depend on it, and it depends on nothing.

Units are fixed here and used everywhere: positions in ångström, masses in unified atomic mass
units, angles in degrees at the interface (radians inside `vec3`), charges in elementary charges.

```ts
import { EMPTY_HISTORY, EMPTY_SCENE, addHydrogens, editScene, exportMolecule, hillFormula, recordPatch, undo, validateScene } from '@matterlab/core';

// One undoable edit: a carbon atom, completed with hydrogens.
const { scene, patch } = editScene(EMPTY_SCENE, 'Add methane', (editor) => {
  const carbon = editor.addAtom({ protons: 6, position: [0, 0, 0] });
  addHydrogens(editor, [carbon]);
});

hillFormula(scene, undefined, 'plain'); // 'CH4'
validateScene(scene).ok;                // true
exportMolecule('xyz', scene, 'methane'); // the XYZ file as text

const history = recordPatch(EMPTY_HISTORY, patch);
undo(scene, history)!.scene.atoms.size; // 0
```

## The model (`types.ts`)

| Type | What it is |
| --- | --- |
| `Atom` | `id`, `protons` (1 to 118; this alone fixes the element), `neutrons` (`null` means no isotope is specified, so the natural mixture and the standard atomic weight apply), `electrons` (charge = protons − electrons), `position` |
| `Bond` | `id`, the two atom ids `a` and `b`, `order`: 1, 2, 3 or 1.5 for an aromatic bond |
| `Scene` | Immutable: a map of atoms, a map of bonds, and the next free ids. Ids are never reused within a scene |
| `ScenePatch` | A labelled, reversible description of one edit: atoms and bonds added, removed and changed (each change with its `before` and `after`) |

## Editing and history (`scene/`)

- `editScene(scene, label, fn)` runs `fn` against a `SceneEditor` and returns `{ scene, patch }`.
  The editor offers `addAtom`, `updateAtom`, `moveAtom`, `removeAtom` (which removes the atom's
  bonds), `addBond`, `setBondOrder`, `removeBond`, and read access to the state being built.
  It throws `SceneEditError` for changes that cannot exist: a proton count outside 1 to 118,
  particle counts that are not whole numbers, a non-finite position, a bond from an atom to itself
  or to a missing atom. Bonding a pair that is already bonded changes the order of the existing
  bond, so a pair never carries two bonds.
- `applyPatch`, `invertPatch`, `isEmptyPatch`, `patchChangesTopology`.
- History is two stacks of patches, not copies of scenes: `recordPatch`, `undo`, `redo`
  (`EMPTY_HISTORY`, `DEFAULT_HISTORY_LIMIT` = 500 steps). Undo restores the previous scene exactly.
- Queries: `getAdjacency` and `neighborsOf` (cached per scene; a patch that keeps the bonding graph
  hands the table on to the next scene), `bondBetween`, `fragmentOf`, `fragments`, `sideOfBond`,
  `isBondInRing`, `boundingSphere`, `sortedAtoms`, `sortedBonds`.

## Reference data (`elements/`, `isotopes/`, `constants.ts`)

- `ELEMENTS`, `getElement`, `findElement`, `elementBySymbol`: all 118 elements with name, symbol,
  period, group, block, category, standard state, standard atomic weight, ground-state electron
  configuration, electronegativity, first ionisation energy, electron affinity, oxidation states,
  melting and boiling points, density, covalent and van der Waals radii, the valences RDKit's model
  permits, and the display colour (Jmol convention). Values a source does not give are `null`;
  predicted values are flagged. `ELEMENT_DATA_SOURCES` names the sources and which fields each one
  supplies.
- `getIsotopes`, `findIsotope`, `isotopeMass`, `naturalIsotopes`, `representativeIsotope`,
  `formatHalfLife`, `describeStability`: 3,383 ground-state nuclides with mass, abundance, half-life
  and decay mode. `ISOTOPE_DATA_SOURCE` is their provenance.
- Physical constants (CODATA 2018) and unit conversions.

Both tables are generated files. They are rebuilt from the snapshots in `tools/data/sources` with
`npm run data:elements` and `npm run data:isotopes`; do not edit them by hand.

## Chemistry (`chem/`)

| Function | What it does | Evidence level of the result |
| --- | --- | --- |
| `describeAtom` | Symbol, isotope label, charge, mass and its basis, and notes: hypothetical nuclide, radioactive, short-lived, bare nucleus, unusual charge and others | reference data where the nuclide is evaluated, rule-based otherwise |
| `atomMass`, `molecularMass` | Mass from the nuclide or the standard atomic weight, corrected for the electron count | reference; for a nuclide outside the evaluated data the mass number is used and the result says so |
| `electronConfiguration` | Ground-state configuration: tabulated for neutral atoms, by the textbook rules for ions | reference or rule-based, stated in the result |
| `analyseValences`, `allowedValences`, `kekulize` | The valence model, which mirrors RDKit's, and assignment of aromatic bonds | rule-based |
| `addHydrogens`, `adjustHydrogens`, `removeHydrogens` | Fill open valences at idealised positions | rule-based |
| `composition`, `hillFormula`, `formatFormula` | Formulae in Hill order | exact |
| `idealBondLength`, `perceiveBonds` | Typical lengths from covalent radii; bonds inferred from distances | rule-based |
| `validateScene` | A `ValidationReport` of issues with severity, code, message and the atoms and bonds concerned: valence exceeded or open, overlapping atoms, stretched or compressed bonds, close unbonded contacts, several fragments, net charge. Close pairs are found with a uniform grid, so the cost stays near-linear | rule-based |

`validateScene(scene).ok` means the drawing is well-formed by these rules. It does not mean that the
compound is stable or can be made.

## Geometry (`geom/`, `vec3.ts`)

`measurePoints` (distance, angle or dihedral from two, three or four points), `angleDegrees`,
`dihedralDegrees`, and the edits `translateAtoms`, `rotateAtoms`, `setDistance`, `setAngle` and
`setDihedral`. The three setters move the last-named atom together with everything attached beyond
it, as a rigid part, when that part can be separated; when the bond is in a ring only the atom (for
a dihedral, its branch) moves. They return `{ ok: false, reason }` for input that has no answer,
such as a dihedral over three atoms in a line.

## File formats (`io/`)

`importMolecules(format, text)` and `exportMolecule(format, scene, name)` for the formats in
`FILE_FORMATS`; `detectFileFormat(fileName, text)` chooses one. Each entry of `FILE_FORMATS` states
what the format keeps and what it loses, and the application shows that text before exporting.

| Format | Keeps | Loses |
| --- | --- | --- |
| `matterlab` (JSON, `serializeScene` / `deserializeScene`) | everything | nothing |
| `mol`, `sdf` (V2000, and V3000 above 999 atoms or bonds; both are read) | atoms, coordinates, bonds and orders, charges, specified isotopes | aromatic bonds are written as alternating single and double bonds; coordinates are rounded to 0.0001 Å |
| `xyz` | element and position | bonds, charges, isotopes; bonds are inferred again from distances on import |
| `pdb` | atoms, coordinates, bonds, double and triple orders through repeated CONECT records | isotopes, aromatic bond orders |

Unreadable input throws `MoleculeParseError`, which names the line and what was expected there, or
`SceneFormatError` for the native format.
`toMolfile(scene, { dimensions: 2 })` marks a flat drawing as such, so that a reader does not take
its coordinates for a geometry.

## Evidence and provenance (`provenance.ts`)

`EvidenceLevel` is one of `reference`, `computed`, `rule-based`, `illustrative`, `user-input` and
`unsupported`; `EVIDENCE_LEVELS` holds the label and the description shown in the interface.
`Provenance` (source, version, citations, URL, retrieval date, licence, notes), `Citation` and
`Quantity` (value, unit, uncertainty, evidence, provenance) are the shapes every engine uses for its
results. `JobStatus` is the life cycle shared by every asynchronous calculation: `queued`,
`running`, `succeeded`, `failed`, `cancelled`, `unsupported`.

## Examples (`examples/`)

`EXAMPLES`, `findExample`, `exampleScene`, `insertExample`: sixteen small molecules. Their
coordinates are computed geometries (RDKit ETKDG embedding relaxed with MMFF94), generated by
`tools/data/build_examples.py`; `EXAMPLE_PROVENANCE` records the RDKit version and the date.

## Tests

`vitest run --project core` runs the seven files in `test/`: atom bookkeeping and electron
configurations, valence, hydrogens and validation, elements, isotopes, geometry, file formats, and
scene editing with patches, history and queries.
