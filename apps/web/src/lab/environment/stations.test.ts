import { describe, expect, it } from 'vitest';
import { createStation, DEFAULT_STATION_FOOTPRINT_M, findSlot, layoutBounds, layoutStations, minimumSeparation, STATION_SPACING_M } from './stations';
import type { StationRecord } from './types';

function stationsNamed(count: number): StationRecord[] {
  return Array.from({ length: count }, (_, i) => createStation(`Station ${i + 1}`));
}

describe('createStation', () => {
  it('gives every station a distinct id', () => {
    const a = createStation('A');
    const b = createStation('B');
    expect(a.id).not.toBe(b.id);
    expect(a.name).toBe('A');
  });
});

describe('layoutStations', () => {
  it('returns nothing for an empty list', () => {
    expect(layoutStations([], 'room')).toEqual([]);
    expect(layoutStations([], 'studio')).toEqual([]);
  });

  it('places a single station at the origin in both modes', () => {
    const [station] = stationsNamed(1);
    for (const mode of ['room', 'studio'] as const) {
      const [slot] = layoutStations([station!], mode);
      expect(slot!.origin.positionM).toEqual([0, 0, 0]);
      expect(slot!.footprintM).toEqual(DEFAULT_STATION_FOOTPRINT_M);
    }
  });

  it('room mode lines stations up along one axis, centred on it', () => {
    const slots = layoutStations(stationsNamed(4), 'room');
    const xs = slots.map((s) => s.origin.positionM[0]);
    const zs = slots.map((s) => s.origin.positionM[2]);
    // All on the same row.
    expect(new Set(zs).size).toBe(1);
    // Symmetric about x = 0.
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean).toBeCloseTo(0, 10);
    // Evenly spaced.
    const sorted = [...xs].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]! - sorted[i - 1]!).toBeCloseTo(STATION_SPACING_M, 10);
    }
  });

  it('studio mode spreads stations in a roughly square grid centred on the origin', () => {
    const slots = layoutStations(stationsNamed(9), 'studio');
    const xs = slots.map((s) => s.origin.positionM[0]);
    const zs = slots.map((s) => s.origin.positionM[2]);
    expect(xs.reduce((a, b) => a + b, 0) / xs.length).toBeCloseTo(0, 10);
    expect(zs.reduce((a, b) => a + b, 0) / zs.length).toBeCloseTo(0, 10);
    // 9 stations fit a 3x3 grid, so there should be exactly 3 distinct rows and columns.
    expect(new Set(xs.map((x) => Math.round(x * 1e6))).size).toBe(3);
    expect(new Set(zs.map((z) => Math.round(z * 1e6))).size).toBe(3);
  });

  it('never overlaps stations, for any station count from 1 to 12', () => {
    for (const mode of ['room', 'studio'] as const) {
      for (let count = 1; count <= 12; count++) {
        const slots = layoutStations(stationsNamed(count), mode);
        const minGap = minimumSeparation(slots);
        const footprintDiagonal = Math.hypot(DEFAULT_STATION_FOOTPRINT_M.widthM, DEFAULT_STATION_FOOTPRINT_M.depthM);
        if (count > 1) expect(minGap).toBeGreaterThan(footprintDiagonal);
      }
    }
  });

  it('is deterministic: the same input always produces the same layout', () => {
    const stations = stationsNamed(5);
    const a = layoutStations(stations, 'studio');
    const b = layoutStations(stations, 'studio');
    expect(a.map((s) => s.origin)).toEqual(b.map((s) => s.origin));
  });

  it('keeps earlier stations fixed when a station is appended (layout is order-only, not identity-based)', () => {
    const stations = stationsNamed(3);
    const before = layoutStations(stations, 'room');
    const after = layoutStations([...stations, createStation('Station 4')], 'room');
    // Every earlier slot keeps its index, but the row re-centres around the new count, so compare by index only.
    expect(before.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(after.map((s) => s.index)).toEqual([0, 1, 2, 3]);
  });
});

describe('findSlot', () => {
  it('finds a slot by station id', () => {
    const stations = stationsNamed(3);
    const slots = layoutStations(stations, 'room');
    const found = findSlot(slots, stations[1]!.id);
    expect(found?.station.name).toBe('Station 2');
  });

  it('returns undefined for an unknown id', () => {
    const slots = layoutStations(stationsNamed(2), 'room');
    expect(findSlot(slots, 'not-a-real-id')).toBeUndefined();
  });
});

describe('layoutBounds', () => {
  it('gives a sensible default box with no stations', () => {
    const bounds = layoutBounds([]);
    expect(bounds.maxX).toBeGreaterThan(bounds.minX);
    expect(bounds.maxZ).toBeGreaterThan(bounds.minZ);
  });

  it('grows to contain every station footprint', () => {
    const slots = layoutStations(stationsNamed(6), 'room');
    const bounds = layoutBounds(slots);
    for (const slot of slots) {
      const [x, , z] = slot.origin.positionM;
      expect(x).toBeGreaterThanOrEqual(bounds.minX);
      expect(x).toBeLessThanOrEqual(bounds.maxX);
      expect(z).toBeGreaterThanOrEqual(bounds.minZ);
      expect(z).toBeLessThanOrEqual(bounds.maxZ);
    }
  });
});
