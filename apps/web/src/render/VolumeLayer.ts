import {
  BackSide, BoxGeometry, Color, Data3DTexture, DataUtils, DepthTexture, GLSL3, HalfFloatType, InstancedMesh,
  LinearFilter, Matrix4, Mesh, MeshDepthMaterial, NearestFilter, RedFormat, Scene, ShaderMaterial,
  UnsignedIntType, Vector2, Vector3, WebGLRenderTarget,
} from 'three';
import type { Camera, WebGLRenderer } from 'three';
import type { StageCut, StageVolume } from './viewApi';

const vertex = /* glsl */ `
out vec3 vLocal;
void main() {
  vLocal = position + vec3(0.5);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const fragment = /* glsl */ `
precision highp sampler3D;
uniform sampler3D uField;
uniform sampler2D uDepth;
uniform vec3 uDimensions;
uniform vec3 uSize;
uniform vec3 uCamera;
uniform vec3 uDirection;
uniform vec2 uViewport;
uniform mat4 uInverseViewProjection;
uniform mat4 uWorldToLocal;
uniform float uOrtho;
uniform float uMagnitude;
uniform float uReference;
uniform float uOpacity;
uniform vec3 uPositive;
uniform vec3 uNegative;
uniform float uCut;
uniform vec3 uCutNormal;
uniform vec3 uCutPoint;
in vec3 vLocal;
out vec4 fragColor;
#define gl_FragColor fragColor
void main() {
  vec3 direction = uOrtho > 0.5 ? normalize(uDirection) : normalize(vLocal - uCamera);
  vec3 origin = uOrtho > 0.5 ? vLocal - direction * 4.0 : uCamera;
  vec3 inverse = mix(vec3(-1.0), vec3(1.0), greaterThanEqual(direction, vec3(0.0))) / max(abs(direction), vec3(1e-8));
  vec3 a = -origin * inverse;
  vec3 b = (vec3(1.0) - origin) * inverse;
  vec3 nearSide = min(a, b);
  vec3 farSide = max(a, b);
  float first = max(0.0, max(nearSide.x, max(nearSide.y, nearSide.z)));
  float last = min(farSide.x, min(farSide.y, farSide.z));
  float depth = texture(uDepth, gl_FragCoord.xy / uViewport).r;
  if (depth < 0.999999) {
    vec4 world = uInverseViewProjection * vec4(gl_FragCoord.xy / uViewport * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    world /= world.w;
    vec3 opaque = (uWorldToLocal * world).xyz + vec3(0.5);
    last = min(last, dot(opaque - origin, direction));
  }
  if (last <= first || uOpacity <= 0.0) discard;
  float stepSize = (last - first) / 192.0;
  float stepAngstrom = length(uSize * direction) * stepSize;
  vec3 accumulated = vec3(0.0);
  float alpha = 0.0;
  for (int i = 0; i < 192; i++) {
    vec3 samplePoint = origin + direction * (first + (float(i) + 0.5) * stepSize);
    if (uCut > 0.5 && dot(samplePoint - uCutPoint, uCutNormal) > 0.0) continue;
    vec3 uv = (samplePoint * (uDimensions - 1.0) + 0.5) / uDimensions;
    float field = texture(uField, uv).r * uMagnitude;
    float strength = abs(field) / uReference;
    if (strength < 0.002) continue;
    float opacity = 1.0 - exp(-min(strength, 20.0) * uOpacity * stepAngstrom);
    vec3 color = field >= 0.0 ? uPositive : uNegative;
    accumulated += (1.0 - alpha) * opacity * color;
    alpha += (1.0 - alpha) * opacity;
    if (alpha >= 0.985) break;
  }
  if (alpha < 0.002) discard;
  fragColor = vec4(accumulated / max(alpha, 1e-6), alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export function volumeTextureData(volume: StageVolume): { data: Uint16Array; magnitude: number; size: [number, number, number] } {
  const [nx, ny, nz] = volume.dimensions;
  if (![nx, ny, nz].every((n) => Number.isInteger(n) && n >= 2 && n <= 256) || nx * ny * nz !== volume.values.length || volume.values.length > 2_000_000) {
    throw new RangeError('Volume dimensions do not describe a bounded scalar grid.');
  }
  if (!volume.spacing.every((n) => n > 0 && Number.isFinite(n)) || !volume.origin.every(Number.isFinite) || !(volume.referenceValue > 0) || !Number.isFinite(volume.referenceValue) ||
      !Number.isFinite(volume.opacity) || volume.opacity < 0 || volume.opacity > 1) {
    throw new RangeError('Volume coordinates and reference must be finite and calibrated.');
  }
  let magnitude = 0;
  for (const value of volume.values) {
    if (!Number.isFinite(value)) throw new RangeError('The sampled volume contains a non-finite field value.');
    magnitude = Math.max(magnitude, Math.abs(value));
  }
  if (magnitude === 0) magnitude = 1;
  const data = Uint16Array.from(volume.values, (value) => DataUtils.toHalfFloat(value / magnitude));
  return { data, magnitude, size: [(nx - 1) * volume.spacing[0], (ny - 1) * volume.spacing[1], (nz - 1) * volume.spacing[2]] };
}

/** A scientific scalar grid with illustrative optical opacity, clipped by the real atom/bond depth. */
export class VolumeLayer {
  private readonly uniforms = {
    uField: { value: null as Data3DTexture | null }, uDepth: { value: null as DepthTexture | null },
    uDimensions: { value: new Vector3() }, uSize: { value: new Vector3() }, uCamera: { value: new Vector3() },
    uDirection: { value: new Vector3() }, uViewport: { value: new Vector2() },
    uInverseViewProjection: { value: new Matrix4() }, uWorldToLocal: { value: new Matrix4() },
    uOrtho: { value: 0 }, uMagnitude: { value: 1 }, uReference: { value: 0.02 }, uOpacity: { value: 0.6 },
    uPositive: { value: new Color() }, uNegative: { value: new Color() },
    uCut: { value: 0 }, uCutNormal: { value: new Vector3() }, uCutPoint: { value: new Vector3() },
  };
  private readonly material = new ShaderMaterial({
    glslVersion: GLSL3, vertexShader: vertex, fragmentShader: fragment, uniforms: this.uniforms,
    side: BackSide, transparent: true, depthWrite: false, depthTest: false, fog: false,
  });
  readonly object = new Mesh(new BoxGeometry(1, 1, 1), this.material);
  private source: StageVolume | null = null;
  private cut: StageCut | null = null;
  private readonly depthScene = new Scene();
  private readonly depthMaterial = new MeshDepthMaterial();
  private depthTarget: WebGLRenderTarget | null = null;
  private readonly depthMeshes: InstancedMesh[] = [];
  private readonly screenSize = new Vector2();

  constructor() {
    this.object.visible = false;
    this.object.frustumCulled = false;
    this.object.renderOrder = 18;
    this.object.userData.cannotReceiveAO = true;
    this.object.onBeforeRender = (renderer, _scene, camera) => {
      const target = renderer.getRenderTarget();
      if (target) this.uniforms.uViewport.value.set(target.width, target.height);
      else this.uniforms.uViewport.value.copy(renderer.getDrawingBufferSize(this.screenSize));
      const inverse = this.uniforms.uWorldToLocal.value.copy(this.object.matrixWorld).invert();
      this.uniforms.uCamera.value.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(inverse).addScalar(0.5);
      this.uniforms.uDirection.value.set(0, 0, -1).transformDirection(camera.matrixWorld).transformDirection(inverse);
      this.uniforms.uInverseViewProjection.value.copy(camera.matrixWorld).multiply(camera.projectionMatrixInverse);
      this.uniforms.uOrtho.value = camera.projectionMatrix.elements[15] === 1 ? 1 : 0;
      if (this.cut) {
        this.uniforms.uCutPoint.value.set(...this.cut.point).applyMatrix4(inverse).addScalar(0.5);
        // Plane normals transform by the transpose of the local-to-world linear map.
        this.uniforms.uCutNormal.value.set(...this.cut.normal).multiply(this.object.scale);
      }
    };
  }

  set(volume: StageVolume | null) {
    if (!volume) {
      this.object.visible = false;
      this.source = null;
      this.uniforms.uField.value?.dispose();
      this.uniforms.uField.value = null;
      this.depthTarget?.dispose();
      this.depthTarget = null;
      return;
    }
    if (!this.source || this.source.values !== volume.values) {
      const prepared = volumeTextureData(volume);
      this.uniforms.uField.value?.dispose();
      const texture = new Data3DTexture(prepared.data, ...volume.dimensions);
      texture.format = RedFormat;
      texture.type = HalfFloatType;
      texture.minFilter = texture.magFilter = LinearFilter;
      texture.unpackAlignment = 1;
      texture.needsUpdate = true;
      this.uniforms.uField.value = texture;
      this.uniforms.uMagnitude.value = prepared.magnitude;
      this.uniforms.uDimensions.value.set(...volume.dimensions);
      this.uniforms.uSize.value.set(...prepared.size);
      this.object.scale.set(...prepared.size);
      this.object.position.set(...volume.origin).addScaledVector(this.object.scale, 0.5);
      this.object.updateMatrixWorld();
    }
    this.source = volume;
    this.uniforms.uReference.value = volume.referenceValue;
    this.uniforms.uOpacity.value = volume.opacity;
    this.uniforms.uPositive.value.set(volume.colorPositive);
    this.uniforms.uNegative.value.set(volume.colorNegative);
    this.object.visible = true;
  }

  setCut(cut: StageCut | null) {
    this.cut = cut;
    this.uniforms.uCut.value = cut ? 1 : 0;
  }

  prepareDepth(renderer: WebGLRenderer, camera: Camera, sources: readonly InstancedMesh[]) {
    if (!this.object.visible) return;
    renderer.getDrawingBufferSize(this.screenSize);
    if (!this.depthTarget) {
      this.depthTarget = new WebGLRenderTarget(this.screenSize.x, this.screenSize.y, { minFilter: NearestFilter, magFilter: NearestFilter });
      this.depthTarget.depthTexture = new DepthTexture(this.screenSize.x, this.screenSize.y, UnsignedIntType);
    } else if (this.depthTarget.width !== this.screenSize.x || this.depthTarget.height !== this.screenSize.y) {
      this.depthTarget.setSize(this.screenSize.x, this.screenSize.y);
    }
    sources.forEach((source, index) => {
      let mesh = this.depthMeshes[index];
      if (!mesh) {
        mesh = new InstancedMesh(source.geometry, this.depthMaterial, 1);
        mesh.matrixAutoUpdate = false;
        mesh.frustumCulled = false;
        this.depthMeshes[index] = mesh;
        this.depthScene.add(mesh);
      }
      mesh.geometry = source.geometry;
      mesh.instanceMatrix = source.instanceMatrix;
      mesh.count = source.count;
      mesh.matrix.copy(source.matrixWorld);
    });
    for (let index = sources.length; index < this.depthMeshes.length; index++) this.depthMeshes[index]!.count = 0;
    const previous = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    try {
      renderer.setRenderTarget(this.depthTarget);
      renderer.autoClear = true;
      renderer.clear();
      renderer.render(this.depthScene, camera);
      this.uniforms.uDepth.value = this.depthTarget.depthTexture;
    } finally {
      renderer.setRenderTarget(previous);
      renderer.autoClear = autoClear;
    }
  }

  dispose() {
    this.set(null);
    this.object.geometry.dispose();
    this.material.dispose();
    this.depthMaterial.dispose();
    for (const mesh of this.depthMeshes) mesh.dispose();
    this.depthScene.clear();
  }
}
