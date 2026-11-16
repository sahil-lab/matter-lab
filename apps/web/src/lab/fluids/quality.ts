import type { FluidVisualSettings, ResolvedFluidSettings } from './types';

export function resolveFluidSettings(settings: FluidVisualSettings = {}): ResolvedFluidSettings {
  const lowPower = settings.lowPower === true;
  const reducedMotion = settings.reducedMotion === true;
  const quality = lowPower ? 'low' : settings.quality ?? 'balanced';
  const enabled = settings.enabled !== false;
  const tier = {
    low: { angularSegments: 24, surfaceRings: 4, maxDroplets: 8, motionUpdatesPerS: 15, maxSurfaceAmplitudeM: 0.0002 },
    balanced: { angularSegments: 40, surfaceRings: 6, maxDroplets: 24, motionUpdatesPerS: 30, maxSurfaceAmplitudeM: 0.0004 },
    high: { angularSegments: 64, surfaceRings: 8, maxDroplets: 48, motionUpdatesPerS: 30, maxSurfaceAmplitudeM: 0.0005 },
  }[quality];
  return {
    ...tier, quality, lowPower, reducedMotion, enabled,
    materialMode: lowPower ? 'opacity' : settings.materialMode ?? 'physical',
    maxDroplets: reducedMotion || !enabled ? 0 : tier.maxDroplets,
    motionUpdatesPerS: reducedMotion || lowPower || !enabled ? 0 : tier.motionUpdatesPerS,
    maxSurfaceAmplitudeM: reducedMotion || lowPower || !enabled ? 0 : tier.maxSurfaceAmplitudeM,
  };
}
