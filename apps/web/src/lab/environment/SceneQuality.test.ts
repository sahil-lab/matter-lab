import { describe, expect, it } from 'vitest';
import { lodLevelForDistance, recommendSceneQuality, SCENE_QUALITY, shouldLoadStation } from './SceneQuality';
import type { DeviceInfo } from '../../render/quality';

function device(overrides: Partial<DeviceInfo>): DeviceInfo {
  return {
    renderer: 'Generic GPU',
    vendor: 'Generic',
    webgl2: true,
    webgpuAvailable: false,
    software: false,
    maxTextureSize: 8192,
    logicalCores: 8,
    devicePixelRatio: 1,
    ...overrides,
  };
}

describe('SCENE_QUALITY presets', () => {
  it('defines all three tiers with increasing fidelity', () => {
    expect(Object.keys(SCENE_QUALITY).sort()).toEqual(['balanced', 'efficient', 'quality']);
    expect(SCENE_QUALITY.efficient.realtimeShadows).toBe(false);
    expect(SCENE_QUALITY.balanced.realtimeShadows).not.toBe(false);
    expect(SCENE_QUALITY.quality.environmentResolution).toBeGreaterThan(SCENE_QUALITY.balanced.environmentResolution);
    expect(SCENE_QUALITY.balanced.environmentResolution).toBeGreaterThan(SCENE_QUALITY.efficient.environmentResolution);
  });

  it('every preset id matches its key', () => {
    for (const [key, settings] of Object.entries(SCENE_QUALITY)) {
      expect(settings.id).toBe(key);
    }
  });

  it('the quality preset has no cap on loaded stations', () => {
    expect(SCENE_QUALITY.quality.maxLoadedStations).toBe(0);
  });
});

describe('recommendSceneQuality', () => {
  it('recommends efficient for a software rasteriser', () => {
    expect(recommendSceneQuality(device({ software: true }))).toBe('efficient');
  });
  it('recommends efficient when WebGL 2 is unavailable', () => {
    expect(recommendSceneQuality(device({ webgl2: false }))).toBe('efficient');
  });
  it('recommends efficient on a dual-core machine', () => {
    expect(recommendSceneQuality(device({ logicalCores: 2 }))).toBe('efficient');
  });
  it('recommends quality for a discrete or high-end GPU', () => {
    expect(recommendSceneQuality(device({ renderer: 'NVIDIA GeForce RTX 4060' }))).toBe('quality');
    expect(recommendSceneQuality(device({ renderer: 'Apple M2 GPU' }))).toBe('quality');
  });
  it('recommends balanced otherwise', () => {
    expect(recommendSceneQuality(device({ renderer: 'Intel Iris Xe Graphics' }))).toBe('balanced');
  });
});

describe('lodLevelForDistance', () => {
  const bands: readonly [number, number] = [5, 15];
  it('is full detail within the first band', () => {
    expect(lodLevelForDistance(0, bands)).toBe(0);
    expect(lodLevelForDistance(5, bands)).toBe(0);
  });
  it('is reduced detail in the second band', () => {
    expect(lodLevelForDistance(5.01, bands)).toBe(1);
    expect(lodLevelForDistance(15, bands)).toBe(1);
  });
  it('is minimal detail beyond the second band', () => {
    expect(lodLevelForDistance(15.01, bands)).toBe(2);
    expect(lodLevelForDistance(1000, bands)).toBe(2);
  });
});

describe('shouldLoadStation', () => {
  it('loads everything when the cap is zero or negative', () => {
    expect(shouldLoadStation(50, null, 0)).toBe(true);
    expect(shouldLoadStation(50, 2, -1)).toBe(true);
  });
  it('loads the first `maxLoaded` stations when none is active', () => {
    expect(shouldLoadStation(0, null, 2)).toBe(true);
    expect(shouldLoadStation(1, null, 2)).toBe(true);
    expect(shouldLoadStation(2, null, 2)).toBe(false);
  });
  it('loads the active station and its immediate neighbours', () => {
    expect(shouldLoadStation(5, 5, 2)).toBe(true);
    expect(shouldLoadStation(4, 5, 2)).toBe(true);
    expect(shouldLoadStation(6, 5, 2)).toBe(true);
    expect(shouldLoadStation(7, 5, 2)).toBe(false);
  });
});
