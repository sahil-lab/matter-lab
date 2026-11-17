/**
 * PBR illumination: a key + rim directional pair, hemisphere ambient, a procedurally generated
 * HDRI (light shapes, not a photograph — see `render/Stage.tsx` for the same technique in the
 * molecular editor, chosen there and here so no licensed image asset is required and the scene
 * renders identically offline), soft contact shadows, and the room shell in room mode. Quality
 * tiers come from `SceneQuality.ts`; mood/palette from `RoomConfig.ts`'s lighting presets.
 */
import { ContactShadows, Environment, Lightformer } from '@react-three/drei';
import { useMemo } from 'react';
import { DoubleSide } from 'three';
import type { LightingPreset, RoomDimensions } from './RoomConfig';
import type { SceneQualitySettings } from './SceneQuality';
import type { EnvironmentMode } from './types';

export interface EnvironmentLightingProps {
  readonly mode: EnvironmentMode;
  readonly preset: LightingPreset;
  readonly quality: SceneQualitySettings;
  readonly roomDimensions: RoomDimensions;
}

function RoomShell({ dimensions, preset }: { dimensions: RoomDimensions; preset: LightingPreset }) {
  const { widthM, depthM, heightM } = dimensions;
  return (
    <group>
      <mesh position={[0, heightM / 2, -depthM / 2]} receiveShadow>
        <planeGeometry args={[widthM, heightM]} />
        <meshStandardMaterial color={preset.wallColor} roughness={0.92} side={DoubleSide} />
      </mesh>
      <mesh position={[-widthM / 2, heightM / 2, 0]} rotation={[0, Math.PI / 2, 0]} receiveShadow>
        <planeGeometry args={[depthM, heightM]} />
        <meshStandardMaterial color={preset.wallColor} roughness={0.92} side={DoubleSide} />
      </mesh>
      <mesh position={[widthM / 2, heightM / 2, 0]} rotation={[0, -Math.PI / 2, 0]} receiveShadow>
        <planeGeometry args={[depthM, heightM]} />
        <meshStandardMaterial color={preset.wallColor} roughness={0.92} side={DoubleSide} />
      </mesh>
    </group>
  );
}

export function EnvironmentLighting({ mode, preset, quality, roomDimensions }: EnvironmentLightingProps) {
  const floorSize = Math.max(roomDimensions.widthM, roomDimensions.depthM) * (mode === 'room' ? 1 : 2.4);
  const shadowRadius = Math.max(roomDimensions.widthM, roomDimensions.depthM) / 2 + 1.5;
  const shadows = quality.realtimeShadows;

  // A stable key: changing only the numbers inside `shadows` must not force React to remount the light.
  const shadowProps = useMemo(
    () =>
      shadows
        ? {
            castShadow: true,
            'shadow-mapSize-width': shadows.mapSize,
            'shadow-mapSize-height': shadows.mapSize,
            'shadow-radius': shadows.radius,
            'shadow-bias': -0.0015,
            'shadow-camera-left': -shadowRadius,
            'shadow-camera-right': shadowRadius,
            'shadow-camera-top': shadowRadius,
            'shadow-camera-bottom': -shadowRadius,
            'shadow-camera-near': 0.5,
            'shadow-camera-far': shadowRadius * 4,
          }
        : { castShadow: false },
    [shadows, shadowRadius],
  );

  return (
    <>
      <color attach="background" args={[preset.backgroundColor]} />
      {preset.fogDensity > 0 && <fogExp2 attach="fog" args={[preset.backgroundColor, preset.fogDensity]} />}

      <hemisphereLight args={[preset.ambientColor, preset.floorColor, preset.ambientIntensity]} />
      <directionalLight position={[4, 6, 3]} intensity={preset.keyIntensity} color={preset.keyColor} {...shadowProps} />
      <directionalLight position={[-5, 3.4, -4]} intensity={preset.rimIntensity} color={preset.rimColor} />

      <Environment resolution={quality.environmentResolution} frames={1} background={false}>
        <color attach="background" args={[preset.backgroundColor]} />
        <Lightformer form="rect" intensity={preset.keyIntensity * 0.7} color={preset.keyColor} position={[0, 6, 2]} scale={[8, 4, 1]} target={[0, 0, 0]} />
        <Lightformer form="rect" intensity={preset.rimIntensity} color={preset.rimColor} position={[-6, 2, -6]} scale={[4, 6, 1]} target={[0, 0, 0]} />
        <Lightformer form="ring" intensity={Math.max(0.3, preset.ambientIntensity * 1.4)} color={preset.ambientColor} position={[0, -4, 5]} scale={6} target={[0, 0, 0]} />
      </Environment>

      {mode === 'room' && <RoomShell dimensions={roomDimensions} preset={preset} />}

      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[floorSize, floorSize]} />
        <meshStandardMaterial color={preset.floorColor} roughness={0.88} metalness={0.02} />
      </mesh>

      <ContactShadows
        position={[0, 0.002, 0]}
        opacity={0.5}
        scale={floorSize}
        blur={2.4}
        far={2.2}
        resolution={Math.max(256, quality.contactShadowSamples * 32)}
        color="#000000"
        frames={shadows ? Infinity : 1}
      />
    </>
  );
}
