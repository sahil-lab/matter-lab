import { useMemo } from 'react';
import { useReducedMotion } from '../environment/CameraModes';
import { useSceneQuality } from '../environment/SceneQuality';
import { resolveFluidSettings } from './quality';
import type { FluidVisualSettings } from './types';

export function useFluidSettings(settings?: FluidVisualSettings) {
  const scene = useSceneQuality();
  const reducedMotion = useReducedMotion(settings?.reducedMotion);
  const quality = settings?.quality ?? scene.preset;
  return useMemo(() => resolveFluidSettings({
    quality, reducedMotion, lowPower: settings?.lowPower,
    materialMode: settings?.materialMode, enabled: settings?.enabled,
  }), [quality, reducedMotion, settings?.lowPower, settings?.materialMode, settings?.enabled]);
}
