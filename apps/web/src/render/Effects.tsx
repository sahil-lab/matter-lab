import { Bloom, EffectComposer, N8AO, Noise, SMAA, ToneMapping, Vignette } from '@react-three/postprocessing';
import { BlendFunction, ToneMappingMode } from 'postprocessing';
import { HalfFloatType } from 'three';
import type { QualitySettings } from './quality';

/**
 * Post-processing for the Balanced and Quality presets (WebGL 2):
 * ambient occlusion for contact depth, bloom that only catches values brighter than white
 * (selection rims and the hottest highlights), AgX tone mapping, anti-aliasing and a light vignette.
 */
export function Effects({ quality }: { quality: QualitySettings }) {
  const ao = quality.ambientOcclusion;
  return (
    <EffectComposer multisampling={quality.msaa} enableNormalPass={false} frameBufferType={HalfFloatType} stencilBuffer={false}>
      {ao ? (
        <N8AO
          aoRadius={1.5}
          distanceFalloff={1.1}
          intensity={ao.intensity}
          quality={ao.quality}
          halfRes={ao.halfRes}
          depthAwareUpsampling
          color="#02060f"
        />
      ) : (
        <></>
      )}
      {quality.bloom ? <Bloom mipmapBlur intensity={0.42} luminanceThreshold={1} luminanceSmoothing={0.12} radius={0.72} /> : <></>}
      <ToneMapping mode={ToneMappingMode.AGX} />
      {quality.msaa === 0 ? <SMAA /> : <></>}
      <Vignette offset={0.26} darkness={0.56} />
      {quality.grain ? <Noise premultiply blendFunction={BlendFunction.SOFT_LIGHT} opacity={0.16} /> : <></>}
    </EffectComposer>
  );
}
