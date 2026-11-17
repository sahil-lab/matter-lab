/**
 * Loads a glTF/GLB asset into the same `GeometryBuildResult` shape every procedural builder
 * returns, so `ApparatusMesh` renders either kind through one code path. A mesh's own authored
 * material is preserved via `GeometryGroup.material` (taking precedence over the provisional,
 * slot-based palette procedural assets use) — a glTF asset is assumed to already look the way its
 * author intended.
 *
 * No definition in this module uses `source: 'gltf'` yet (everything is procedural); this exists
 * so a future plugin definition can reference a real asset file without any other module changing
 * (brief point 6: "asset loading registry supporting future plugins ... without modifying editor core").
 */
import { Mesh } from 'three';
import type { Material, Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { combineBuildResults, type GeometryBuildResult, type GeometryGroup } from './types';

function collectMeshGroups(root: Object3D): GeometryGroup[] {
  const groups: GeometryGroup[] = [];
  root.updateMatrixWorld(true);
  root.traverse((node) => {
    if (!(node instanceof Mesh)) return;
    // Bake the mesh's full local-to-root transform (including any scale) directly into a cloned
    // geometry's vertices, rather than trying to express it as our position+quaternion-only
    // `Transform` — a glTF node may be non-uniformly scaled, which `Transform` cannot represent.
    const geometry = node.geometry.clone();
    geometry.applyMatrix4(node.matrix);
    const material = (Array.isArray(node.material) ? node.material[0] : node.material) as Material | undefined;
    groups.push({ materialSlot: node.name || 'gltf-default', geometry, material });
  });
  return groups;
}

/** Parses an already-fetched glTF/GLB buffer (or a JSON string for a plain `.gltf`). Kept separate
 * from `loadGltfBuildResult` so it can be unit-tested with an in-memory buffer, without a network
 * fetch — see `test/gltfLoader.test.ts`. */
export function parseGltfBuildResult(data: ArrayBuffer | string, resourcePath = ''): Promise<GeometryBuildResult> {
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(
      data,
      resourcePath,
      (gltf) => resolve(combineBuildResults(collectMeshGroups(gltf.scene))),
      (error) => reject(error instanceof Error ? error : new Error(String(error))),
    );
  });
}

/** Fetches and parses a glTF/GLB asset from a URL (the normal path `ApparatusMesh` uses at
 * runtime). */
export async function loadGltfBuildResult(url: string): Promise<GeometryBuildResult> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch glTF asset "${url}": ${response.status} ${response.statusText}`);
  const buffer = await response.arrayBuffer();
  const resourcePath = url.slice(0, url.lastIndexOf('/') + 1);
  return parseGltfBuildResult(buffer, resourcePath);
}
