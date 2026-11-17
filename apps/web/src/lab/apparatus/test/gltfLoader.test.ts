import { describe, expect, it } from 'vitest';
import { BoxGeometry, Mesh, MeshStandardMaterial, Scene } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { parseGltfBuildResult } from '../geometry/gltfLoader';

// `GLTFExporter`'s binary (.glb) path uses the browser `FileReader` API to turn a `Blob` into an
// `ArrayBuffer`. Node has no global `FileReader`; this minimal, test-only polyfill (backed by
// Node's native `Blob.arrayBuffer()`) lets the test exercise a real exported GLB buffer instead of
// a hand-written fixture that might not resemble one. Production code never needs this — only this
// test file, to *generate* a sample asset to parse.
if (typeof globalThis.FileReader === 'undefined') {
  class NodeFileReaderPolyfill {
    result: ArrayBuffer | null = null;
    onloadend: (() => void) | null = null;
    onerror: ((err: unknown) => void) | null = null;
    readAsArrayBuffer(blob: Blob): void {
      blob
        .arrayBuffer()
        .then((buf) => {
          this.result = buf;
          this.onloadend?.();
        })
        .catch((err) => this.onerror?.(err));
    }
  }
  // @ts-expect-error -- intentionally minimal; only the members GLTFExporter actually uses are implemented.
  globalThis.FileReader = NodeFileReaderPolyfill;
}

/** Exports a simple one-box scene to a real in-memory GLB buffer, so the loader is tested against
 * an actual glTF binary rather than a hand-written fixture that might not resemble one. */
function exportTestBoxGlb(): Promise<ArrayBuffer> {
  const scene = new Scene();
  const mesh = new Mesh(new BoxGeometry(1, 2, 3), new MeshStandardMaterial({ color: '#336699', roughness: 0.4 }));
  mesh.name = 'test-box';
  mesh.position.set(0.5, 0, 0);
  scene.add(mesh);

  return new Promise((resolve, reject) => {
    new GLTFExporter().parse(
      scene,
      (result) => resolve(result as ArrayBuffer),
      (error) => reject(error instanceof Error ? error : new Error(String(error))),
      { binary: true },
    );
  });
}

describe('parseGltfBuildResult', () => {
  it('parses a real exported GLB buffer into a GeometryBuildResult with the expected triangle count', async () => {
    const buffer = await exportTestBoxGlb();
    const result = await parseGltfBuildResult(buffer);
    expect(result.groups).toHaveLength(1);
    expect(result.polyCount).toBe(12); // a box has 6 faces * 2 triangles
  });

  it('preserves the mesh name as materialSlot and the authored material', async () => {
    const buffer = await exportTestBoxGlb();
    const result = await parseGltfBuildResult(buffer);
    const [group] = result.groups;
    expect(group.materialSlot).toBe('test-box');
    expect(group.material).toBeDefined();
  });

  it('bakes the mesh\u2019s local transform into the returned geometry\u2019s vertices', async () => {
    const buffer = await exportTestBoxGlb();
    const result = await parseGltfBuildResult(buffer);
    const [group] = result.groups;
    const position = group.geometry.getAttribute('position');
    // The box (half-width 0.5) was offset by +0.5 on X, so its baked vertices should span [0, 1] on X, not [-0.5, 0.5].
    let minX = Infinity;
    let maxX = -Infinity;
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
    }
    expect(minX).toBeCloseTo(0, 5);
    expect(maxX).toBeCloseTo(1, 5);
  });

  it('rejects with a clear error for a malformed buffer', async () => {
    const garbage = new TextEncoder().encode('not a gltf file').buffer;
    await expect(parseGltfBuildResult(garbage)).rejects.toThrow();
  });
});
