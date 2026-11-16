import {
  BufferAttribute,
  BufferGeometry,
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  DataUtils,
  DoubleSide,
  Group,
  HalfFloatType,
  LinearFilter,
  Matrix4,
  Mesh,
  MeshPhysicalMaterial,
  Plane,
  PlaneGeometry,
  Points,
  RedFormat,
  RGBAFormat,
  SRGBColorSpace,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  Vector3,
} from 'three';
import type { WebGLRenderer } from 'three';
import type { StageCloud, StageCut, StageSlice, StageSurface } from './viewApi';

const SLICE_VERTEX = /* glsl */ `
uniform vec2 uGrid;
varying vec2 vUv;
varying vec2 vRect;
void main() {
  // Samples sit on the corners of the rectangle, texel centres half a texel inside the texture.
  vUv = (uv * (uGrid - 1.0) + 0.5) / uGrid;
  vRect = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SLICE_FRAGMENT = /* glsl */ `
uniform sampler2D uField;
uniform sampler2D uScale;
uniform float uNeutral;
uniform float uContours;
varying vec2 vUv;
varying vec2 vRect;
void main() {
  float t = clamp(texture2D(uField, vUv).r, 0.0, 1.0);
  vec3 color = texture2D(uScale, vec2(t * (255.0 / 256.0) + 0.5 / 256.0, 0.5)).rgb;
  // Distance from the neutral point of the scale, 0..1.
  float away = abs(t - uNeutral) / max(uNeutral, 1.0 - uNeutral);
  if (uContours > 0.0) {
    float level = away * uContours;
    float width = max(fwidth(level), 1e-5);
    float line = 1.0 - smoothstep(0.0, 1.4 * width, abs(fract(level + 0.5) - 0.5));
    // No line at the neutral point, where the plane fades out, and none at the ends of the scale,
    // where everything beyond the scale has the same position and would count as one thick line.
    line *= step(0.5, level) * (1.0 - step(uContours - 0.5, level));
    color = mix(color, vec3(0.012, 0.02, 0.04), 0.5 * line);
  }
  // Where the field is negligible the plane is not drawn, so it never hides the structure for nothing.
  float alpha = smoothstep(0.01, 0.09, away);
  // A hairline around the sampled rectangle shows where the plane is and where its data end.
  vec2 inward = min(vRect, 1.0 - vRect) / max(fwidth(vRect), vec2(1e-6));
  float frame = 1.0 - smoothstep(0.5, 1.6, min(inward.x, inward.y));
  color = mix(color, vec3(0.2, 0.3, 0.4), frame);
  alpha = max(alpha, 0.8 * frame);
  if (alpha < 0.02) discard;
  gl_FragColor = vec4(color, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

const CLOUD_VERTEX = /* glsl */ `
attribute float phase;
uniform float uSize;
uniform float uViewport;
varying float vPhase;
void main() {
  vPhase = phase;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  // A dot has a size in space; this is its diameter in pixels, in either projection.
  gl_PointSize = max(1.6, uSize * projectionMatrix[1][1] * uViewport * 0.5 / gl_Position.w);
}`;

const CLOUD_FRAGMENT = /* glsl */ `
uniform vec3 uPositive;
uniform vec3 uNegative;
uniform float uOpacity;
varying float vPhase;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  gl_FragColor = vec4(vPhase >= 0.0 ? uPositive : uNegative, (1.0 - r2 * r2) * uOpacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** Translucent shells get more opaque towards their silhouette, which is what makes a closed shape readable. */
const RIM = /* glsl */ `
#include <opaque_fragment>
{
  float facing = abs(dot(normalize(vNormal), normalize(vViewPosition)));
  gl_FragColor.a = clamp(gl_FragColor.a + (1.0 - gl_FragColor.a) * 0.6 * pow(1.0 - facing, 2.2), 0.0, 1.0);
}`;

interface SurfaceEntry {
  source: StageSurface;
  readonly geometry: BufferGeometry;
  material: MeshPhysicalMaterial;
  readonly mesh: Mesh;
}

function surfaceMaterial(finish: StageSurface['finish']): MeshPhysicalMaterial {
  const glass = finish === 'glass';
  const material = new MeshPhysicalMaterial({
    side: DoubleSide,
    metalness: 0,
    roughness: glass ? 0.3 : 0.82,
    clearcoat: glass ? 0.5 : 0,
    clearcoatRoughness: 0.3,
    envMapIntensity: glass ? 0.9 : 0.3,
  });
  if (glass) {
    material.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', RIM);
    };
    material.customProgramCacheKey = () => 'matterlab-glass';
  }
  return material;
}

/**
 * Computed fields on the stage: isosurfaces, a cutting plane and dot clouds. It only draws what it
 * is given; which field, at which value and in which colour is decided by the caller, so nothing
 * here can invent a shape.
 */
export class FieldLayer {
  readonly object = new Group();
  private readonly surfaces = new Map<string, SurfaceEntry>();
  private readonly cutPlane = new Plane();
  private cut = false;

  private readonly sliceMaterial = new ShaderMaterial({
    vertexShader: SLICE_VERTEX,
    fragmentShader: SLICE_FRAGMENT,
    uniforms: {
      uField: { value: null },
      uScale: { value: null },
      uGrid: { value: new Vector2(2, 2) },
      uNeutral: { value: 0 },
      uContours: { value: 0 },
    },
    side: DoubleSide,
    // Drawn before the translucent surfaces and written to the depth buffer, so that what lies behind the plane stays hidden.
    transparent: true,
    depthWrite: true,
    fog: false,
  });
  private readonly sliceMesh = new Mesh(new PlaneGeometry(1, 1), this.sliceMaterial);
  private sliceSource: StageSlice | null = null;
  private fieldTexture: DataTexture | null = null;
  private scaleTexture: DataTexture | null = null;

  private readonly cloudMaterial = new ShaderMaterial({
    vertexShader: CLOUD_VERTEX,
    fragmentShader: CLOUD_FRAGMENT,
    uniforms: {
      uSize: { value: 0.06 },
      uViewport: { value: 800 },
      uPositive: { value: new Color() },
      uNegative: { value: new Color() },
      uOpacity: { value: 0.6 },
    },
    transparent: true,
    depthWrite: false,
    fog: false,
  });
  private cloudGeometry = new BufferGeometry();
  private readonly cloudPoints = new Points(this.cloudGeometry, this.cloudMaterial);
  private cloudSource: StageCloud | null = null;

  constructor() {
    this.sliceMesh.matrixAutoUpdate = false;
    this.sliceMesh.frustumCulled = false;
    this.sliceMesh.visible = false;
    this.sliceMesh.renderOrder = 14;
    // The plane's colours are read against a scale, so the ambient-occlusion pass must not darken them.
    this.sliceMesh.userData.cannotReceiveAO = true;
    this.cloudPoints.frustumCulled = false;
    this.cloudPoints.visible = false;
    this.cloudPoints.renderOrder = 16;
    const size = new Vector2();
    this.cloudPoints.onBeforeRender = (renderer: WebGLRenderer) => {
      const target = renderer.getRenderTarget();
      this.cloudMaterial.uniforms.uViewport!.value = target ? target.height : renderer.getDrawingBufferSize(size).y;
    };
    this.object.add(this.sliceMesh, this.cloudPoints);
  }

  setSurfaces(list: readonly StageSurface[]): void {
    const wanted = new Set(list.map((surface) => surface.id));
    for (const [id, entry] of this.surfaces) {
      if (wanted.has(id)) continue;
      this.object.remove(entry.mesh);
      entry.geometry.dispose();
      entry.material.dispose();
      this.surfaces.delete(id);
    }
    list.forEach((surface, order) => {
      let entry = this.surfaces.get(surface.id);
      if (!entry) {
        const geometry = new BufferGeometry();
        const material = surfaceMaterial(surface.finish);
        const mesh = new Mesh(geometry, material);
        entry = { source: { ...surface, positions: new Float32Array(0), colors: undefined }, geometry, material, mesh };
        this.surfaces.set(surface.id, entry);
        this.object.add(mesh);
      }
      const { geometry, mesh } = entry;
      const previous = entry.source;
      if (previous.positions !== surface.positions || previous.indices !== surface.indices || previous.normals !== surface.normals) {
        geometry.setAttribute('position', new BufferAttribute(surface.positions, 3));
        geometry.setAttribute('normal', new BufferAttribute(surface.normals, 3));
        geometry.setIndex(new BufferAttribute(surface.indices, 1));
        geometry.computeBoundingSphere();
      }
      if (previous.colors !== surface.colors || previous.positions !== surface.positions) {
        if (surface.colors) geometry.setAttribute('color', new BufferAttribute(surface.colors, 3));
        else geometry.deleteAttribute('color');
      }
      if (previous.finish !== surface.finish) {
        entry.material.dispose();
        entry.material = surfaceMaterial(surface.finish);
        mesh.material = entry.material;
      }
      const material = entry.material;
      const translucent = surface.opacity < 0.995;
      const usesVertexColors = surface.colors !== undefined;
      if (material.transparent !== translucent || material.vertexColors !== usesVertexColors) material.needsUpdate = true;
      material.transparent = translucent;
      material.depthWrite = !translucent;
      material.opacity = translucent ? surface.opacity : 1;
      material.vertexColors = usesVertexColors;
      material.color.set(usesVertexColors ? '#ffffff' : surface.color);
      this.applyCut(material);
      // Drawn after the cutting plane, in the order given.
      mesh.renderOrder = 20 + order;
      entry.source = surface;
    });
  }

  setSlice(slice: StageSlice | null): void {
    const previous = this.sliceSource;
    this.sliceSource = slice;
    if (!slice) {
      this.sliceMesh.visible = false;
      return;
    }
    const uniforms = this.sliceMaterial.uniforms;
    if (!previous || previous.positions !== slice.positions || previous.columns !== slice.columns || previous.rows !== slice.rows) {
      const texels = new Uint16Array(slice.positions.length);
      for (let i = 0; i < texels.length; i++) {
        const value = slice.positions[i]!;
        texels[i] = DataUtils.toHalfFloat(Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);
      }
      this.fieldTexture?.dispose();
      const texture = new DataTexture(texels, slice.columns, slice.rows, RedFormat, HalfFloatType);
      texture.minFilter = LinearFilter;
      texture.magFilter = LinearFilter;
      texture.wrapS = ClampToEdgeWrapping;
      texture.wrapT = ClampToEdgeWrapping;
      texture.needsUpdate = true;
      this.fieldTexture = texture;
      uniforms.uField!.value = texture;
      (uniforms.uGrid!.value as Vector2).set(slice.columns, slice.rows);
    }
    if (!previous || previous.scale !== slice.scale) {
      this.scaleTexture?.dispose();
      const texture = new DataTexture(slice.scale, 256, 1, RGBAFormat, UnsignedByteType);
      texture.colorSpace = SRGBColorSpace;
      texture.minFilter = LinearFilter;
      texture.magFilter = LinearFilter;
      texture.wrapS = ClampToEdgeWrapping;
      texture.wrapT = ClampToEdgeWrapping;
      texture.needsUpdate = true;
      this.scaleTexture = texture;
      uniforms.uScale!.value = texture;
    }
    uniforms.uNeutral!.value = slice.neutral;
    uniforms.uContours!.value = slice.contours;
    const u = new Vector3(...slice.u).multiplyScalar(slice.width);
    const v = new Vector3(...slice.v).multiplyScalar(slice.height);
    const normal = new Vector3(...slice.u).cross(new Vector3(...slice.v)).normalize();
    this.sliceMesh.matrix.copy(new Matrix4().makeBasis(u, v, normal).setPosition(new Vector3(...slice.center)));
    this.sliceMesh.matrixWorldNeedsUpdate = true;
    this.sliceMesh.visible = true;
  }

  setCloud(cloud: StageCloud | null): void {
    const previous = this.cloudSource;
    this.cloudSource = cloud;
    if (!cloud || cloud.positions.length === 0) {
      this.cloudPoints.visible = false;
      return;
    }
    if (!previous || previous.positions !== cloud.positions || previous.signs !== cloud.signs) {
      // A buffer geometry cannot change size in place, so each cloud gets its own.
      this.cloudGeometry.dispose();
      this.cloudGeometry = new BufferGeometry();
      const count = cloud.positions.length / 3;
      const phase = new Float32Array(count);
      for (let i = 0; i < count; i++) phase[i] = cloud.signs ? cloud.signs[i]! : 1;
      this.cloudGeometry.setAttribute('position', new BufferAttribute(cloud.positions, 3));
      this.cloudGeometry.setAttribute('phase', new BufferAttribute(phase, 1));
      this.cloudPoints.geometry = this.cloudGeometry;
    }
    const uniforms = this.cloudMaterial.uniforms;
    uniforms.uSize!.value = cloud.size;
    uniforms.uOpacity!.value = cloud.opacity;
    (uniforms.uPositive!.value as Color).set(cloud.colorPositive);
    (uniforms.uNegative!.value as Color).set(cloud.colorNegative);
    this.cloudPoints.visible = true;
  }

  setCut(cut: StageCut | null): void {
    this.cut = cut !== null;
    if (cut) {
      // three.js keeps the side the plane's normal points to, so the plane faces the other way.
      const normal = new Vector3(...cut.normal).normalize().negate();
      this.cutPlane.setFromNormalAndCoplanarPoint(normal, new Vector3(...cut.point));
    }
    for (const entry of this.surfaces.values()) this.applyCut(entry.material);
  }

  private applyCut(material: MeshPhysicalMaterial): void {
    const has = material.clippingPlanes !== null && material.clippingPlanes.length > 0;
    if (has !== this.cut) {
      material.clippingPlanes = this.cut ? [this.cutPlane] : null;
      material.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const entry of this.surfaces.values()) {
      entry.geometry.dispose();
      entry.material.dispose();
    }
    this.surfaces.clear();
    this.sliceMesh.geometry.dispose();
    this.sliceMaterial.dispose();
    this.fieldTexture?.dispose();
    this.scaleTexture?.dispose();
    this.cloudGeometry.dispose();
    this.cloudMaterial.dispose();
  }
}
