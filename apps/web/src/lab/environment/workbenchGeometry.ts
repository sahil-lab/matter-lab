import { Box3, BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { BufferGeometry, Material } from 'three';
import { WORKBENCH_METRICS } from './coordinates';
import { SceneResourceScope } from './SceneResourceManager';
import type { LabBoundsM, SceneQualityPreset, WorldPointM } from './types';

export function createWorkbenchModel(quality: SceneQualityPreset = 'balanced', accent = '#8dac9d') {
  const resources = new SceneResourceScope();
  const group = new Group();
  group.name = 'Workbench';
  const material = (color: string, roughness: number, metalness = 0.05) =>
    resources.own(new MeshStandardMaterial({ color, roughness, metalness }));
  const porcelain = material('#cbd2cb', 0.32);
  const frame = material('#192b2b', 0.45, 0.55);
  const cabinet = material('#304441', 0.68);
  const hardware = material('#aaa087', 0.3, 0.75);
  const stripe = material(accent, 0.5, 0.3);
  const unitBox = resources.own(new BoxGeometry(1, 1, 1));
  function part(name: string, position: WorldPointM, size: WorldPointM, surface: Material, geometry: BufferGeometry = unitBox) {
    const mesh = new Mesh(geometry, surface);
    mesh.name = name;
    mesh.position.set(...position);
    mesh.scale.set(...size);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    return mesh;
  }
  const slabGeometry: BufferGeometry = quality === 'low' ? unitBox : resources.own(
    new RoundedBoxGeometry(
      WORKBENCH_METRICS.widthM, WORKBENCH_METRICS.slabThicknessM, WORKBENCH_METRICS.depthM,
      quality === 'high' ? 3 : 2, 0.01,
    ),
  );
  part(
    WORKBENCH_METRICS.socketId, [0, 0.9 - 0.055 / 2, 0],
    quality === 'low' ? [2.4, 0.055, 1.05] : [1, 1, 1], porcelain, slabGeometry,
  ).userData = { placementSurface: 'tabletop', localSurfaceHeightM: 0.9 };
  part('underframe', [0, 0.7875, 0], [2.25, 0.115, 0.94], frame);
  for (const x of [-1.055, 1.055]) {
    for (const z of [-0.4075, 0.4075]) {
      part('leg', [x, 0.4375, z], [0.075, 0.815, 0.075], frame);
      part('foot', [x, 0.015, z], [0.092, 0.03, 0.092], frame);
    }
  }
  part('back-stretcher', [0, 0.24, -0.4075], [2.11, 0.07, 0.055], frame);
  part('cabinet', [-0.64, 0.425, 0], [0.66, 0.65, 0.8], cabinet);
  if (quality !== 'low') {
    for (const y of [0.205, 0.414, 0.623]) {
      part('drawer', [-0.64, y, 0.413], [0.608, 0.187, 0.022], cabinet);
      part('drawer-pull', [-0.64, y + 0.037, 0.439], [0.26, 0.014, 0.028], hardware);
    }
    part('identity-rail', [0.62, 0.8, 0.474], [0.8, 0.016, 0.008], stripe);
  }
  group.updateMatrixWorld(true);
  return { group, dispose: () => resources.dispose() };
}

/** CPU geometry measurement, not an inferred scale or a chemical calibration. */
export function measureWorkbenchModel(quality: SceneQualityPreset = 'balanced'): {
  boundsM: LabBoundsM; tabletopHeightM: number; triangles: number; meshes: number;
} {
  const model = createWorkbenchModel(quality);
  try {
    const bounds = new Box3().setFromObject(model.group, true);
    const tabletop = model.group.getObjectByName(WORKBENCH_METRICS.socketId)!;
    const tabletopHeightM = new Box3().setFromObject(tabletop, true).max.y;
    let triangles = 0;
    let meshes = 0;
    model.group.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      meshes += 1;
      triangles += (object.geometry.index?.count ?? object.geometry.getAttribute('position').count) / 3;
    });
    return { boundsM: { minM: bounds.min.toArray(), maxM: bounds.max.toArray() }, tabletopHeightM, triangles, meshes };
  } finally { model.dispose(); }
}
