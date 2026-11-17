/**
 * Scene-quality presets for the lab environment: LOD distances, shadow strategy, device-pixel
 * ratio range and which post-processing passes run. This is a sibling policy to
 * `render/quality.ts` (which tunes the molecular-editor stage) rather than a dependency on it, so
 * the two scenes can be tuned independently; only the generic, state-free device probe is shared.
 */
import type { DeviceInfo } from '../../render/quality';
import type { SceneQualityId } from './types';

export interface ShadowSettings {
  /** Shadow-map resolution (square) for the key light; `false` disables real-time shadow maps entirely. */
  readonly mapSize: number;
  readonly radius: number;
}

export interface SceneQualitySettings {
  readonly id: SceneQualityId;
  readonly label: string;
  readonly description: string;
  readonly dpr: readonly [number, number];
  /** `false` on the Efficient preset: contact shadows alone are cheaper and read well at a distance. */
  readonly realtimeShadows: ShadowSettings | false;
  readonly contactShadowSamples: number;
  readonly postprocessing: boolean;
  readonly bloom: boolean;
  readonly ambientOcclusion: boolean;
  /** Resolution of the generated (procedural) HDRI cubemap used for reflections and ambient light. */
  readonly environmentResolution: number;
  /**
   * Distance bands (metres, from the camera) for level-of-detail swaps: within the first number,
   * apparatus should show full detail; within the second, reduced detail; beyond it, minimal detail.
   */
  readonly lodDistancesM: readonly [number, number];
  /** How many stations besides the active one stay mounted; 0 means "no cap, keep everything loaded". */
  readonly maxLoadedStations: number;
}

export const SCENE_QUALITY: Readonly<Record<SceneQualityId, SceneQualitySettings>> = {
  efficient: {
    id: 'efficient',
    label: 'Efficient',
    description: 'Contact shadows only, no post-processing. For integrated graphics.',
    dpr: [0.75, 1.25],
    realtimeShadows: false,
    contactShadowSamples: 8,
    postprocessing: false,
    bloom: false,
    ambientOcclusion: false,
    environmentResolution: 128,
    lodDistancesM: [4, 10],
    maxLoadedStations: 2,
  },
  balanced: {
    id: 'balanced',
    label: 'Balanced',
    description: 'Soft real-time shadows, restrained bloom and ambient occlusion.',
    dpr: [0.8, 1.5],
    realtimeShadows: { mapSize: 1024, radius: 3 },
    contactShadowSamples: 12,
    postprocessing: true,
    bloom: true,
    ambientOcclusion: true,
    environmentResolution: 256,
    lodDistancesM: [6, 16],
    maxLoadedStations: 4,
  },
  quality: {
    id: 'quality',
    label: 'Quality',
    description: 'Full-resolution shadows and reflections for capable GPUs.',
    dpr: [1, 2],
    realtimeShadows: { mapSize: 2048, radius: 4 },
    contactShadowSamples: 20,
    postprocessing: true,
    bloom: true,
    ambientOcclusion: true,
    environmentResolution: 512,
    lodDistancesM: [10, 24],
    maxLoadedStations: 0,
  },
};

/** A sensible starting preset for a device; the user's own choice always overrides it. */
export function recommendSceneQuality(device: DeviceInfo): SceneQualityId {
  if (device.software || !device.webgl2 || (device.logicalCores > 0 && device.logicalCores <= 2)) return 'efficient';
  if (/nvidia|geforce|rtx|radeon rx|apple m\d|apple gpu/i.test(device.renderer)) return 'quality';
  return 'balanced';
}

/** Level of detail (0 = full, 1 = reduced, 2 = minimal) for something at `distanceM` from the camera. */
export function lodLevelForDistance(distanceM: number, lodDistancesM: readonly [number, number]): 0 | 1 | 2 {
  if (distanceM <= lodDistancesM[0]) return 0;
  if (distanceM <= lodDistancesM[1]) return 1;
  return 2;
}

/**
 * Whether a station at `index` should have its contents mounted, given which station (if any) is
 * active. The active station and its immediate neighbours stay loaded; the rest are released
 * on-demand. A non-positive `maxLoaded` disables the cap (every station stays loaded).
 */
export function shouldLoadStation(index: number, activeIndex: number | null, maxLoaded: number): boolean {
  if (maxLoaded <= 0) return true;
  if (activeIndex === null) return index < maxLoaded;
  return Math.abs(index - activeIndex) < maxLoaded;
}
