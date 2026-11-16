import { Environment, Lightformer } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, Vector2 } from 'three';
import type { DirectionalLight, Group, OrthographicCamera, PerspectiveCamera, ShaderMaterial } from 'three';
import type { QualitySettings } from './quality';

const BACKDROP_VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  // Drawn as a screen-filling triangle pair pinned to the far plane.
  gl_Position = vec4(position.xy, 1.0, 1.0);
}`;

const BACKDROP_FRAGMENT = /* glsl */ `
varying vec2 vUv;
uniform vec3 uTop;
uniform vec3 uBottom;
uniform vec3 uGlow;
uniform vec3 uHaze;
uniform vec2 uCenter;
uniform float uAspect;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

void main() {
  vec3 color = mix(uBottom, uTop, smoothstep(0.0, 1.0, vUv.y));
  vec2 p = vUv - uCenter;
  p.x *= uAspect;
  // A soft pool of light behind the subject, plus a fainter, wider haze.
  color += uGlow * exp(-dot(p, p) * 3.0);
  color += uHaze * exp(-dot(p, p) * 0.7);
  // Proportional dither hides gradient banding without showing up as grain in the darks.
  color *= 1.0 + (hash(gl_FragCoord.xy) - 0.5) * 0.05;
  gl_FragColor = vec4(max(color, 0.0), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/** The deep-navy studio backdrop. It is computed in screen space so it is identical in both projections. */
function Backdrop() {
  const material = useRef<ShaderMaterial>(null);
  const uniforms = useMemo(
    () => ({
      uTop: { value: new Color('#0b1322') },
      uBottom: { value: new Color('#05080e') },
      uGlow: { value: new Color('#1d3d6b').multiplyScalar(0.085) },
      uHaze: { value: new Color('#14294a').multiplyScalar(0.075) },
      uCenter: { value: new Vector2(0.5, 0.54) },
      uAspect: { value: 1 },
    }),
    [],
  );
  useFrame(({ size, camera }) => {
    const view = (camera as PerspectiveCamera).view;
    uniforms.uAspect.value = size.width / size.height;
    uniforms.uCenter.value.x = 0.5 - (view?.enabled ? view.offsetX / size.width : 0);
  });
  return (
    <mesh frustumCulled={false} renderOrder={-1000}>
      <planeGeometry args={[2, 2]} />
      <shaderMaterial ref={material} vertexShader={BACKDROP_VERTEX} fragmentShader={BACKDROP_FRAGMENT} uniforms={uniforms} depthWrite={false} fog={false} />
    </mesh>
  );
}

/** Deterministic pseudo-random numbers so the dust field is the same on every launch. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DUST_RADIUS = 1500;

/**
 * A sparse field of distant motes that drifts as the view turns. It gives the eye something to
 * judge rotation against and a sense of depth, and is kept faint on purpose.
 */
function Dust({ count, drift }: { count: number; drift: boolean }) {
  const group = useRef<Group>(null);
  const geometry = useMemo(() => {
    const random = seeded(7);
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const z = random() * 2 - 1;
      const phi = random() * Math.PI * 2;
      const r = Math.sqrt(1 - z * z);
      positions[3 * i] = r * Math.cos(phi) * DUST_RADIUS;
      positions[3 * i + 1] = z * DUST_RADIUS;
      positions[3 * i + 2] = r * Math.sin(phi) * DUST_RADIUS;
      const brightness = 0.12 + 0.5 * random() ** 3;
      colors[3 * i] = 0.62 * brightness;
      colors[3 * i + 1] = 0.78 * brightness;
      colors[3 * i + 2] = brightness;
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(positions, 3));
    g.setAttribute('color', new BufferAttribute(colors, 3));
    return g;
  }, [count]);

  useFrame(({ camera, size, clock }) => {
    const g = group.current;
    if (!g) return;
    g.position.copy(camera.position);
    // In an orthographic view the shell must be scaled to the visible region to stay in frame.
    const ortho = camera as OrthographicCamera;
    g.scale.setScalar(ortho.isOrthographicCamera ? (size.height / ortho.zoom) * 1.3 / DUST_RADIUS : 1);
    if (drift) g.rotation.y = clock.elapsedTime * 0.004;
  });

  return (
    <group ref={group}>
      <points geometry={geometry} frustumCulled={false} renderOrder={-900}>
        <pointsMaterial size={1.7} sizeAttenuation={false} vertexColors transparent depthWrite={false} blending={AdditiveBlending} fog={false} toneMapped={false} />
      </points>
    </group>
  );
}

/** A key light that travels with the camera, so shading reads the same from every angle. */
function KeyLight() {
  const light = useRef<DirectionalLight>(null);
  useFrame(({ camera }) => {
    const l = light.current;
    if (!l) return;
    // Up and to the left of the viewer, slightly in front of the subject.
    l.position.set(-0.55, 0.8, 0.6).applyQuaternion(camera.quaternion).multiplyScalar(60);
    l.target.position.set(0, 0, 0);
    l.target.updateMatrixWorld();
  });
  return <directionalLight ref={light} intensity={1.15} color="#ffffff" />;
}

/**
 * Lighting and atmosphere. The reflections come from a small procedural studio (no image files),
 * with a cool key, a teal under-light and a warm rim that echo the interface palette.
 */
export function Stage({ quality, drift }: { quality: QualitySettings; drift: boolean }) {
  return (
    <>
      <color attach="background" args={['#080d18']} />
      <Backdrop />
      <Dust count={quality.dustParticles} drift={drift} />
      <hemisphereLight args={['#c9dcff', '#0a1220', 0.32]} />
      <KeyLight />
      <Environment resolution={quality.environmentResolution} frames={1} background={false}>
        <color attach="background" args={['#020409']} />
        <Lightformer form="rect" intensity={3.4} color="#e6f0ff" position={[-5, 7, 7]} scale={[9, 7, 1]} target={[0, 0, 0]} />
        <Lightformer form="rect" intensity={1.2} color="#a6d6ff" position={[8, 1, 4]} scale={[5, 9, 1]} target={[0, 0, 0]} />
        <Lightformer form="ring" intensity={1.5} color="#55e2d1" position={[0, -7, -2]} scale={7} target={[0, 0, 0]} />
        <Lightformer form="rect" intensity={2.3} color="#ffb66b" position={[-7, 1.5, -8]} scale={[5, 3, 1]} target={[0, 0, 0]} />
        <Lightformer form="circle" intensity={0.9} color="#8c92fc" position={[6, 6, -7]} scale={5} target={[0, 0, 0]} />
      </Environment>
    </>
  );
}
