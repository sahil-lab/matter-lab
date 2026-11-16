import { EMPTY_SCENE, SceneEditor } from '../scene/editor';
import type { AtomId, BondOrder, Scene, Vec3 } from '../types';
import { EXAMPLE_RECORDS } from './examples.generated';
import type { ExampleRecord } from './types';

export { EXAMPLE_PROVENANCE } from './examples.generated';
export type { ExampleRecord } from './types';

/** Built-in molecules. Their geometries are computed (MMFF94 via RDKit); see `EXAMPLE_PROVENANCE`. */
export const EXAMPLES: readonly ExampleRecord[] = EXAMPLE_RECORDS;

export function findExample(id: string): ExampleRecord | undefined {
  return EXAMPLES.find((e) => e.id === id);
}

/** Adds an example molecule to an editor, shifted by `offset`, and returns the ids of its atoms. */
export function insertExample(editor: SceneEditor, example: ExampleRecord, offset: Vec3 = [0, 0, 0]): AtomId[] {
  const ids = example.atoms.map((a) =>
    editor.addAtom({
      protons: a[0]!,
      charge: a[1]!,
      position: [a[2]! + offset[0], a[3]! + offset[1], a[4]! + offset[2]],
    }),
  );
  for (const b of example.bonds) editor.addBond(ids[b[0]!]!, ids[b[1]!]!, b[2] as BondOrder);
  return ids;
}

/** A fresh scene containing just the example molecule. */
export function exampleScene(example: ExampleRecord): Scene {
  const editor = new SceneEditor(EMPTY_SCENE);
  insertExample(editor, example);
  return editor.commit(`Load ${example.name}`).scene;
}
