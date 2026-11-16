import { afterEach, describe, expect, it } from 'vitest';
import { editScene, exampleScene, findExample, neighborsOf, serializeScene } from '@matterlab/core';
import { InstancedMesh } from 'three';
import { SceneView } from './SceneView';
import { MODE_STYLES } from './style';

const views: SceneView[] = [];
const makeView = () => {
  const view = new SceneView({ sphereDetail: 1, cylinderSegments: 6, clearcoat: 0 });
  views.push(view);
  return view;
};
afterEach(() => {
  for (const view of views) view.dispose();
  views.length = 0;
});

describe('skeletal representation', () => {
  it('hides ordinary C-H geometry without removing atoms, isotopes or O-H bonds', () => {
    const ethanol = findExample('ethanol');
    if (!ethanol) throw new Error('The ethanol fixture is missing.');
    const scene = exampleScene(ethanol);
    const before = JSON.stringify(serializeScene(scene));
    const view = makeView();
    view.sync(scene, null);
    view.setStyle(MODE_STYLES.skeletal);
    const data = view.pickData();
    const mesh = view.object.children[0];
    if (!(mesh instanceof InstancedMesh)) throw new Error('The atom mesh is missing.');
    const hidden: number[] = [];
    for (const atom of scene.atoms.values()) {
      const carbonHydrogen = atom.protons === 1 && neighborsOf(scene, atom.id).some((n) => scene.atoms.get(n.atomId)?.protons === 6);
      if (carbonHydrogen) {
        hidden.push(atom.id);
        expect(view.radius(atom.id)).toBe(0);
        const index = data.atomIds.indexOf(atom.id);
        expect(mesh.instanceMatrix.array[index * 16]).toBe(0);
      } else {
        expect(view.radius(atom.id)).toBeGreaterThan(0);
      }
    }
    expect(hidden).toHaveLength(5);
    for (const bond of scene.bonds.values()) {
      const radius = data.bondRadii[data.bondIds.indexOf(bond.id)]!;
      if (hidden.includes(bond.a) || hidden.includes(bond.b)) expect(radius).toBe(0);
      else expect(radius).toBeGreaterThan(0);
    }
    const isotope = editScene(scene, 'Deuterium', (editor) => editor.updateAtom(hidden[0]!, { neutrons: 1 }));
    view.sync(isotope.scene, isotope.patch);
    expect(view.radius(hidden[0]!)).toBeGreaterThan(0);
    expect(JSON.stringify(serializeScene(scene))).toBe(before);
  });

  it('refreshes neighboring hydrogen visibility when carbon changes to nitrogen', () => {
    const methane = findExample('methane');
    if (!methane) throw new Error('The methane fixture is missing.');
    const scene = exampleScene(methane);
    const view = makeView();
    view.sync(scene, null);
    view.setStyle(MODE_STYLES.skeletal);
    const carbon = [...scene.atoms.values()].find((atom) => atom.protons === 6)!;
    const hydrogens = neighborsOf(scene, carbon.id).map((neighbor) => neighbor.atomId);
    for (const id of hydrogens) expect(view.radius(id)).toBe(0);
    const ammonium = editScene(scene, 'Ammonium', (editor) => editor.updateAtom(carbon.id, { protons: 7, electrons: 6 }));
    view.sync(ammonium.scene, ammonium.patch);
    for (const id of hydrogens) expect(view.radius(id)).toBeGreaterThan(0);
    for (let i = 0; i < view.pickData().bondCount; i++) expect(view.pickData().bondRadii[i]).toBeGreaterThan(0);
  });

  it('restores every atom and bond when returning to ball and stick', () => {
    const benzene = findExample('benzene');
    if (!benzene) throw new Error('The benzene fixture is missing.');
    const view = makeView();
    view.sync(exampleScene(benzene), null);
    view.setStyle(MODE_STYLES.skeletal);
    expect([...view.pickData().atomRadii].filter((radius) => radius > 0)).toHaveLength(6);
    view.setStyle(MODE_STYLES['ball-stick']);
    const data = view.pickData();
    for (let i = 0; i < data.atomCount; i++) expect(data.atomRadii[i]).toBeGreaterThan(0);
    for (let i = 0; i < data.bondCount; i++) expect(data.bondRadii[i]).toBeGreaterThan(0);
  });
});
