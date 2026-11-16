import { EMPTY_SCENE, SceneEditor, editScene } from '../src';
import type { AtomId, Scene, Vec3 } from '../src';

/** Builds a scene from scratch with a single edit. */
export function build(fn: (editor: SceneEditor) => void): Scene {
  return editScene(EMPTY_SCENE, 'build', fn).scene;
}

/** Small deterministic pseudo-random generator (mulberry32) so property-style tests are reproducible. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function positionOf(scene: Scene, id: AtomId): Vec3 {
  return scene.atoms.get(id)!.position;
}

/** Ids of atoms of element `z`, in creation order. */
export function atomsOfElement(scene: Scene, z: number): AtomId[] {
  return [...scene.atoms.values()]
    .filter((a) => a.protons === z)
    .map((a) => a.id)
    .sort((a, b) => a - b);
}
