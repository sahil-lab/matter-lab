import { atomCharge, atomLabel } from '@matterlab/core';
import type { Scene } from '@matterlab/core';
import {
  CanvasTexture,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  PlaneGeometry,
  SRGBColorSpace,
  ShaderMaterial,
} from 'three';
import type { LabelMode } from '../state/store';
import type { SceneView } from './SceneView';
import { elementColorLinear } from './style';

const COLUMNS = 16;
const ROWS = 16;
const CELL_WIDTH = 128;
const CELL_HEIGHT = 64;
const FONT = '700 40px "Inter Variable", "Inter", system-ui, sans-serif';

/** Glyph styles: light text for dark spheres, dark text for light ones (hydrogen, sulfur, the halogens). */
type Tone = 'light' | 'dark';
const TONES: Readonly<Record<Tone, { fill: string; halo: string; haloWidth: number }>> = {
  light: { fill: '#f6faff', halo: 'rgba(6, 10, 18, 0.88)', haloWidth: 8 },
  dark: { fill: '#0a111d', halo: 'rgba(255, 255, 255, 0.5)', haloWidth: 5 },
};

const toneCache = new Map<number, Tone>();
function toneFor(z: number): Tone {
  let tone = toneCache.get(z);
  if (!tone) {
    const [r, g, b] = elementColorLinear(z);
    tone = 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.42 ? 'dark' : 'light';
    toneCache.set(z, tone);
  }
  return tone;
}

const VERTEX = /* glsl */ `
attribute vec3 aCenter;
attribute float aRadius;
attribute float aHeight;
attribute float aCell;
varying vec2 vUv;

void main() {
  vec4 mv = modelViewMatrix * vec4(aCenter, 1.0);
  // Lift the label to the front of its sphere, towards the viewer, then face it to the screen.
  bool perspective = projectionMatrix[2][3] == -1.0;
  vec3 toViewer = perspective ? normalize(-mv.xyz) : vec3(0.0, 0.0, 1.0);
  mv.xyz += toViewer * (aRadius * 1.04);
  mv.xy += position.xy * vec2(aHeight * ${(CELL_WIDTH / CELL_HEIGHT).toFixed(1)}, aHeight);
  gl_Position = projectionMatrix * mv;
  float column = mod(aCell, ${COLUMNS}.0);
  float row = floor(aCell / ${COLUMNS}.0);
  vUv = vec2((column + uv.x) / ${COLUMNS}.0, 1.0 - (row + 1.0 - uv.y) / ${ROWS}.0);
}`;

const FRAGMENT = /* glsl */ `
uniform sampler2D uAtlas;
varying vec2 vUv;

void main() {
  vec4 texel = texture2D(uAtlas, vUv);
  if (texel.a < 0.03) discard;
  gl_FragColor = texel;
  #include <colorspace_fragment>
}`;

/**
 * Atom labels drawn as GPU-instanced billboards that sample one shared texture atlas, so thousands
 * of labels cost a single draw call. Labels sit on the viewer-facing side of each atom and are
 * hidden by atoms in front of them, which keeps depth relationships honest.
 */
export class LabelLayer {
  readonly object: Mesh;
  private readonly geometry: InstancedBufferGeometry;
  private readonly material: ShaderMaterial;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly texture: CanvasTexture;
  private readonly cells = new Map<string, number>();
  private capacity = 0;
  private ids = new Int32Array(0);
  private count = 0;

  constructor(onReady: () => void) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = COLUMNS * CELL_WIDTH;
    this.canvas.height = ROWS * CELL_HEIGHT;
    this.context = this.canvas.getContext('2d')!;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.minFilter = LinearMipmapLinearFilter;
    this.texture.magFilter = LinearFilter;
    this.texture.anisotropy = 4;

    const quad = new PlaneGeometry(1, 1);
    this.geometry = new InstancedBufferGeometry();
    this.geometry.setIndex(quad.getIndex());
    this.geometry.setAttribute('position', quad.getAttribute('position'));
    this.geometry.setAttribute('uv', quad.getAttribute('uv'));
    this.material = new ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: { uAtlas: { value: this.texture } },
      transparent: true,
      depthWrite: false,
      toneMapped: false,
      fog: false,
    });
    this.object = new Mesh(this.geometry, this.material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 10;
    this.object.visible = false;
    this.grow(64);

    // Glyphs drawn before the web font has loaded would use a fallback face, so redraw once it is ready.
    void document.fonts?.load(FONT).then(() => {
      const known = [...this.cells.keys()];
      this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
      known.forEach((key, cell) => this.draw(key, cell));
      this.texture.needsUpdate = true;
      onReady();
    });
  }

  private grow(capacity: number): void {
    this.capacity = capacity;
    this.ids = new Int32Array(capacity);
    const attribute = (itemSize: number) => {
      const a = new InstancedBufferAttribute(new Float32Array(capacity * itemSize), itemSize);
      a.setUsage(DynamicDrawUsage);
      return a;
    };
    this.geometry.setAttribute('aCenter', attribute(3));
    this.geometry.setAttribute('aRadius', attribute(1));
    this.geometry.setAttribute('aHeight', attribute(1));
    this.geometry.setAttribute('aCell', attribute(1));
  }

  /** Draws one atlas cell. The key is the tone's first letter followed by the label text. */
  private draw(key: string, cell: number): void {
    const tone = TONES[key.charCodeAt(0) === 100 /* d */ ? 'dark' : 'light'];
    const text = key.slice(1);
    const ctx = this.context;
    const x = (cell % COLUMNS) * CELL_WIDTH + CELL_WIDTH / 2;
    const y = Math.floor(cell / COLUMNS) * CELL_HEIGHT + CELL_HEIGHT / 2 + 2;
    ctx.font = FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    // A halo in the opposite tone keeps the glyph readable where it overhangs its sphere.
    ctx.lineWidth = tone.haloWidth;
    ctx.strokeStyle = tone.halo;
    ctx.strokeText(text, x, y, CELL_WIDTH - 10);
    ctx.fillStyle = tone.fill;
    ctx.fillText(text, x, y, CELL_WIDTH - 10);
  }

  private cellFor(text: string, tone: Tone): number {
    const key = `${tone === 'dark' ? 'd' : 'l'}${text}`;
    let cell = this.cells.get(key);
    if (cell === undefined) {
      if (this.cells.size >= COLUMNS * ROWS) return 0;
      cell = this.cells.size;
      this.cells.set(key, cell);
      this.draw(key, cell);
      this.texture.needsUpdate = true;
    }
    return cell;
  }

  /** Chooses which atoms are labelled and with what text. Call when atoms, elements or the label mode change. */
  rebuild(scene: Scene, view: SceneView, mode: LabelMode): void {
    if (mode === 'none') {
      this.count = 0;
      this.geometry.instanceCount = 0;
      this.object.visible = false;
      return;
    }
    if (scene.atoms.size > this.capacity) {
      let capacity = this.capacity;
      while (capacity < scene.atoms.size) capacity *= 2;
      this.grow(capacity);
    }
    const cells = this.geometry.getAttribute('aCell').array as Float32Array;
    let n = 0;
    for (const atom of scene.atoms.values()) {
      const plain = atom.protons === 1 || atom.protons === 6;
      if (mode === 'hetero' && plain && atom.neutrons === null && atomCharge(atom) === 0) continue;
      this.ids[n] = atom.id;
      cells[n] = this.cellFor(atomLabel(atom), toneFor(atom.protons));
      n++;
    }
    this.count = n;
    this.geometry.instanceCount = n;
    this.geometry.getAttribute('aCell').needsUpdate = true;
    this.object.visible = n > 0;
    this.reposition(view);
  }

  /** Follows the atoms after they move or change size. */
  reposition(view: SceneView): void {
    if (this.count === 0) return;
    const centers = this.geometry.getAttribute('aCenter').array as Float32Array;
    const radii = this.geometry.getAttribute('aRadius').array as Float32Array;
    const heights = this.geometry.getAttribute('aHeight').array as Float32Array;
    for (let i = 0; i < this.count; i++) {
      const id = this.ids[i]!;
      const p = view.position(id);
      if (!p) continue;
      const r = view.radius(id);
      centers[3 * i] = p[0];
      centers[3 * i + 1] = p[1];
      centers[3 * i + 2] = p[2];
      radii[i] = r;
      heights[i] = Math.min(0.56, Math.max(0.2, r * 0.92));
    }
    this.geometry.getAttribute('aCenter').needsUpdate = true;
    this.geometry.getAttribute('aRadius').needsUpdate = true;
    this.geometry.getAttribute('aHeight').needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}
