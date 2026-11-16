/**
 * Adaptive quality for `lab/fluids`. Tier names deliberately match the existing app-wide
 * `QualityId` (`render/quality.ts`: `'efficient' | 'balanced' | 'quality'`) so a consumer can pass
 * the user's existing preset straight through, but this module defines its own small structural
 * type rather than importing that file, keeping `lab/fluids` free of a dependency on the rest of
 * the (pre-existing, unrelated-team-owned) render pipeline.
 */

export type FluidQualityTier = 'efficient' | 'balanced' | 'quality';

export interface FluidQualitySettings {
  readonly tier: FluidQualityTier;
  /** Real refraction/transmission for the glass shell; false uses a cheap alpha-blended fallback. */
  readonly glassTransmission: boolean;
  /** Real refraction/transmission for the liquid body; false uses a cheap alpha-blended fallback. */
  readonly liquidTransmission: boolean;
  /** Radial segment count for vessel/liquid lathe geometry. */
  readonly latheRadialSegments: number;
  readonly meniscusRings: number;
  readonly meniscusSegments: number;
  /** Upper bound on simultaneously visible droplets, per stream. */
  readonly maxDroplets: number;
  /** Whether the meniscus surface is re-displaced (swirl/ripple) every frame, or built once and left static. */
  readonly surfaceAnimation: boolean;
}

export const FLUID_QUALITY: Readonly<Record<FluidQualityTier, FluidQualitySettings>> = {
  efficient: {
    tier: 'efficient',
    glassTransmission: false,
    liquidTransmission: false,
    latheRadialSegments: 22,
    meniscusRings: 2,
    meniscusSegments: 16,
    maxDroplets: 10,
    surfaceAnimation: false,
  },
  balanced: {
    tier: 'balanced',
    glassTransmission: true,
    liquidTransmission: false,
    latheRadialSegments: 40,
    meniscusRings: 4,
    meniscusSegments: 24,
    maxDroplets: 24,
    surfaceAnimation: true,
  },
  quality: {
    tier: 'quality',
    glassTransmission: true,
    liquidTransmission: true,
    latheRadialSegments: 64,
    meniscusRings: 6,
    meniscusSegments: 32,
    maxDroplets: 48,
    surfaceAnimation: true,
  },
};

/** The structural subset of `render/quality.ts`'s `DeviceInfo` this module needs. */
export interface FluidDeviceHints {
  readonly webgl2: boolean;
  /** True for CPU rasterizers (SwiftShader, llvmpipe) — transmission's extra render pass is too costly there. */
  readonly software: boolean;
}

/**
 * Resolves the requested tier to concrete settings, demoted to `efficient` regardless of request
 * when the device cannot be trusted with transmission's extra render pass (no WebGL2, or a
 * software rasterizer). This is the module's shader/feature fallback: it never throws and never
 * leaves transmission enabled on a device that cannot afford it.
 */
export function resolveFluidQuality(tier: FluidQualityTier, device?: FluidDeviceHints | null): FluidQualitySettings {
  if (device && (device.software || !device.webgl2)) return FLUID_QUALITY.efficient;
  return FLUID_QUALITY[tier];
}

/** True when the platform requests reduced motion; false (never throws) outside a browser. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Whether continuous idle surface animation (swirl, ripple) should run this frame: the quality
 * tier allows it, the platform has not asked for reduced motion, and there is a reason to animate
 * at all (`agitation > 0`). A still, non-agitated meniscus is built once and never needs per-frame
 * work regardless of these flags, independent of this function.
 */
export function shouldAnimateSurface(settings: FluidQualitySettings, agitation: number, reducedMotion = prefersReducedMotion()): boolean {
  return settings.surfaceAnimation && !reducedMotion && agitation > 0;
}
