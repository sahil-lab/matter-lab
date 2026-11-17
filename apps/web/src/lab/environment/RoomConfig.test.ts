import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ENVIRONMENT_SETTINGS,
  DEFAULT_LIGHTING_PRESET,
  deserializeEnvironment,
  LIGHTING_PRESETS,
  roomDimensionsFor,
  serializeEnvironment,
} from './RoomConfig';
import type { EnvironmentSettings } from './RoomConfig';
import type { PlanBounds } from './stations';

const HEX = /^#[0-9a-f]{6}$/i;

describe('roomDimensionsFor', () => {
  it('has a sensible minimum size for a single small station', () => {
    const bounds: PlanBounds = { minX: -0.6, maxX: 0.6, minZ: -0.35, maxZ: 0.35 };
    const room = roomDimensionsFor(bounds);
    expect(room.widthM).toBeGreaterThanOrEqual(5);
    expect(room.depthM).toBeGreaterThanOrEqual(5);
    expect(room.heightM).toBeGreaterThan(2);
  });

  it('grows with the station layout, keeping margin around it', () => {
    const narrow = roomDimensionsFor({ minX: -0.6, maxX: 0.6, minZ: -0.35, maxZ: 0.35 });
    const wide = roomDimensionsFor({ minX: -5, maxX: 5, minZ: -0.35, maxZ: 0.35 });
    expect(wide.widthM).toBeGreaterThan(narrow.widthM);
    expect(wide.widthM).toBeGreaterThan(10 + 1); // the stations alone are already 10m wide
  });
});

describe('LIGHTING_PRESETS', () => {
  it('has exactly the three required presets, each matching its own id', () => {
    expect(Object.keys(LIGHTING_PRESETS).sort()).toEqual(['daylight-lab', 'night-lab', 'studio-neutral']);
    for (const [key, preset] of Object.entries(LIGHTING_PRESETS)) expect(preset.id).toBe(key);
  });

  it('uses valid CSS hex colours', () => {
    for (const preset of Object.values(LIGHTING_PRESETS)) {
      expect(preset.keyColor).toMatch(HEX);
      expect(preset.ambientColor).toMatch(HEX);
      expect(preset.rimColor).toMatch(HEX);
      expect(preset.backgroundColor).toMatch(HEX);
      expect(preset.floorColor).toMatch(HEX);
      expect(preset.wallColor).toMatch(HEX);
    }
  });

  it('keeps the bloom threshold close to white, so highlights read as bright rather than glowing', () => {
    for (const preset of Object.values(LIGHTING_PRESETS)) {
      expect(preset.bloomThreshold).toBeGreaterThan(0.85);
      expect(preset.bloomThreshold).toBeLessThanOrEqual(1);
    }
  });

  it('the night preset is dimmer overall than the daylight preset', () => {
    expect(LIGHTING_PRESETS['night-lab'].ambientIntensity).toBeLessThan(LIGHTING_PRESETS['daylight-lab'].ambientIntensity);
    expect(LIGHTING_PRESETS['night-lab'].keyIntensity).toBeLessThan(LIGHTING_PRESETS['daylight-lab'].keyIntensity);
  });

  it('every mode has a valid default preset', () => {
    expect(LIGHTING_PRESETS[DEFAULT_LIGHTING_PRESET.room]).toBeDefined();
    expect(LIGHTING_PRESETS[DEFAULT_LIGHTING_PRESET.studio]).toBeDefined();
  });
});

describe('serializeEnvironment / deserializeEnvironment', () => {
  it('round-trips the default settings', () => {
    const round = deserializeEnvironment(serializeEnvironment(DEFAULT_ENVIRONMENT_SETTINGS));
    expect(round).toEqual(DEFAULT_ENVIRONMENT_SETTINGS);
  });

  it('round-trips a fully populated settings object, bookmarks included', () => {
    const settings: EnvironmentSettings = {
      schemaVersion: 1,
      mode: 'studio',
      lightingPresetId: 'night-lab',
      qualityId: 'quality',
      activeStationId: 'station-2',
      camera: {
        mode: 'inspect',
        pose: { position: [1, 2, 3], target: [0, 1, 0], zoom: 1.5, projection: 'perspective' },
        bookmarks: [{ id: 'bm-1', name: 'Endpoint', mode: 'inspect', position: [0, 1, 2], target: [0, 1, 0], zoom: 1, projection: 'perspective' }],
      },
      gridVisible: false,
      introPlayed: true,
    };
    expect(deserializeEnvironment(serializeEnvironment(settings))).toEqual(settings);
  });

  it('falls back to defaults for missing, null or non-object input', () => {
    expect(deserializeEnvironment(undefined)).toEqual(DEFAULT_ENVIRONMENT_SETTINGS);
    expect(deserializeEnvironment(null)).toEqual(DEFAULT_ENVIRONMENT_SETTINGS);
    expect(deserializeEnvironment('garbage')).toEqual(DEFAULT_ENVIRONMENT_SETTINGS);
    expect(deserializeEnvironment(42)).toEqual(DEFAULT_ENVIRONMENT_SETTINGS);
    expect(deserializeEnvironment({})).toEqual(DEFAULT_ENVIRONMENT_SETTINGS);
  });

  it('defaults only the fields that are invalid, keeping the rest', () => {
    const result = deserializeEnvironment({ mode: 'studio', qualityId: 'not-a-real-quality', gridVisible: 'yes' });
    expect(result.mode).toBe('studio');
    expect(result.qualityId).toBe(DEFAULT_ENVIRONMENT_SETTINGS.qualityId);
    expect(result.gridVisible).toBe(DEFAULT_ENVIRONMENT_SETTINGS.gridVisible);
  });

  it('drops a malformed camera pose instead of accepting partial data', () => {
    const result = deserializeEnvironment({ camera: { mode: 'orbit', pose: { position: [1, 2], target: [0, 0, 0], zoom: 1, projection: 'perspective' } } });
    expect(result.camera.pose).toBeNull();
    expect(result.camera.mode).toBe('orbit');
  });

  it('filters out malformed bookmarks but keeps valid ones', () => {
    const result = deserializeEnvironment({
      camera: {
        bookmarks: [
          { id: 'ok', name: 'Good', mode: 'orbit', position: [0, 0, 0], target: [0, 0, 0], zoom: 1, projection: 'perspective' },
          { id: 'bad', name: 'Missing fields' },
          'not even an object',
        ],
      },
    });
    expect(result.camera.bookmarks).toHaveLength(1);
    expect(result.camera.bookmarks[0]?.id).toBe('ok');
  });

  it('never throws on deeply malformed input', () => {
    expect(() => deserializeEnvironment({ camera: 'not-an-object', activeStationId: 42, mode: {} })).not.toThrow();
  });
});
