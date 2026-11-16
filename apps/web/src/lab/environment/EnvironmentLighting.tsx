import { useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import { PCFShadowMap, PCFSoftShadowMap } from 'three';
import type { DirectionalLight } from 'three';
import { createProceduralEnvironment } from './proceduralEnvironment';
import { useSceneQuality } from './SceneQuality';
import type { LightingPreset } from './types';

export function EnvironmentLighting({ preset = 'daylight' }: { preset?: LightingPreset }) {
  const get = useThree((state) => state.get);
  const quality = useSceneQuality();
  const key = useRef<DirectionalLight>(null);
  useEffect(() => {
    const { gl, scene, invalidate } = get();
    const previous = { environment: scene.environment, intensity: scene.environmentIntensity, exposure: gl.toneMappingExposure };
    const texture = createProceduralEnvironment(quality.environmentWidth, preset);
    // Both renderers prefilter an equirectangular scene.environment with their own PMREM implementation.
    // Do not run the WebGL PMREMGenerator/EffectComposer against WebGPURenderer.
    scene.environment = texture;
    scene.environmentIntensity = preset === 'evening' ? 0.65 : 0.8;
    gl.toneMappingExposure = preset === 'evening' ? 0.95 : 1;
    gl.shadowMap.enabled = quality.shadowMapSize > 0;
    gl.shadowMap.type = 'isWebGPURenderer' in gl ? PCFShadowMap : PCFSoftShadowMap;
    const light = key.current;
    invalidate();
    return () => {
      if (scene.environment === texture) {
        scene.environment = previous.environment;
        scene.environmentIntensity = previous.intensity;
      }
      gl.toneMappingExposure = previous.exposure;
      texture.dispose();
      light?.shadow.dispose();
      if (light) light.shadow.map = null;
    };
  }, [get, preset, quality]);
  return (
    <group name="lab-original-lighting">
      <hemisphereLight color="#d8ede4" groundColor="#343936" intensity={0.45} />
      <directionalLight
        ref={key} position={[-3.5, 5.5, 2.5]}
        color={preset === 'evening' ? '#ffe4c5' : '#f6f5e9'} intensity={2.6}
        castShadow={quality.shadowMapSize > 0}
        shadow-mapSize-width={quality.shadowMapSize || 512}
        shadow-mapSize-height={quality.shadowMapSize || 512}
        shadow-camera-left={-7} shadow-camera-right={7}
        shadow-camera-top={6} shadow-camera-bottom={-6}
        shadow-camera-near={0.1} shadow-camera-far={20}
        shadow-bias={-0.00012} shadow-normalBias={0.003} shadow-radius={2.5}
      />
      <directionalLight position={[3, 3.8, -4]} color="#c6e5e3" intensity={1.2} />
    </group>
  );
}
