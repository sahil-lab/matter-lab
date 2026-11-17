/**
 * Restrained post-processing for the Balanced and Quality presets: ambient occlusion for contact
 * depth, bloom that only catches values brighter than the lighting preset's threshold (so glass
 * highlights stay bright rather than glowing, even in the dim `night-lab` preset), AgX tone
 * mapping and a light vignette. Mirrors `render/Effects.tsx`'s structure for the molecular editor.
 */
import { Bloom, EffectComposer, N8AO, SMAA, ToneMapping, Vignette } from '@react-three/postprocessing';
import { ToneMappingMode } from 'postprocessing';
import { HalfFloatType } from 'three';
import type { LightingPreset } from './RoomConfig';
import type { SceneQualitySettings } from './SceneQuality';

export interface LabEffectsProps {
  readonly quality: SceneQualitySettings;
  readonly preset: LightingPreset;
}

export function LabEffects({ quality, preset }: LabEffectsProps) {
  return (
    <EffectComposer enableNormalPass={false} frameBufferType={HalfFloatType} stencilBuffer={false}>
      {quality.ambientOcclusion ? <N8AO aoRadius={0.6} distanceFalloff={1} intensity={1.4} quality="low" halfRes color="#02060a" /> : <></>}
      {quality.bloom ? <Bloom mipmapBlur intensity={0.3} luminanceThreshold={preset.bloomThreshold} luminanceSmoothing={0.1} radius={0.6} /> : <></>}
      <ToneMapping mode={ToneMappingMode.AGX} />
      <SMAA />
      <Vignette offset={0.3} darkness={0.45} />
    </EffectComposer>
  );
}
