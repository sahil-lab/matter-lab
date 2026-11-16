import { BufferAttribute, BufferGeometry, CanvasTexture, DoubleSide, MeshBasicMaterial, SRGBColorSpace } from 'three';

const GLYPHS = '0123456789.mL -';
const COLUMNS = 16;
const CELL = 64;
let shared: { material: MeshBasicMaterial; texture: CanvasTexture; references: number } | null = null;

export const APPARATUS_LABEL_TEXTURE_BYTES = COLUMNS * CELL * CELL * 4;

/** A single small numeric atlas is shared by all apparatus, not a canvas per graduation. */
export function acquireApparatusLabels(): { material: MeshBasicMaterial; release(): void } {
  if (!shared) {
    const canvas = document.createElement('canvas');
    canvas.width = COLUMNS * CELL;
    canvas.height = CELL;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not create the apparatus graduation labels.');
    context.font = '600 48px monospace';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = '#ffffff';
    for (let i = 0; i < GLYPHS.length; i++) context.fillText(GLYPHS[i]!, (i + 0.5) * CELL, CELL / 2);
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    const material = new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, side: DoubleSide, toneMapped: false, alphaTest: 0.05 });
    shared = { material, texture, references: 0 };
  }
  const entry = shared;
  entry.references++;
  let released = false;
  return {
    material: entry.material,
    release() {
      if (released) return;
      released = true;
      if (--entry.references === 0) {
        entry.material.dispose();
        entry.texture.dispose();
        if (shared === entry) shared = null;
      }
    },
  };
}

export function apparatusTextGeometry(text: string, heightM: number): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const width = heightM * 0.68;
  for (let i = 0; i < text.length; i++) {
    const glyph = GLYPHS.indexOf(text[i]!);
    if (glyph < 0) throw new Error(`Unsupported apparatus label character: ${text[i]}`);
    const left = (i - text.length / 2) * width;
    positions.push(left, -heightM / 2, 0, left + width, -heightM / 2, 0, left + width, heightM / 2, 0, left, heightM / 2, 0);
    normals.push(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1);
    uvs.push(glyph / COLUMNS, 0, (glyph + 1) / COLUMNS, 0, (glyph + 1) / COLUMNS, 1, glyph / COLUMNS, 1);
    const start = i * 4;
    indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex(indices);
  return geometry;
}
