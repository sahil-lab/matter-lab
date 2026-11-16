import { describe, expect, it } from 'vitest';
import type { ApparatusInstance } from './contracts';
import { IDENTITY_TRANSFORM } from './contracts';
import type { ApparatusFootprint } from './types';
import { pickApparatus, pickApparatusInBox, rebuildPickIndex, updatePickIndex } from './picking';
import { SpatialIndex } from './spatialIndex';

const SMALL_FOOTPRINT: ApparatusFootprint = { halfExtents: [0.1, 0.1, 0.1], center: [0, 0, 0] };

function instanceAt(id: string, x: number, z: number): ApparatusInstance {
  return {
    id,
    kind: 'BEAKER',
    definitionId: 'beaker.400ml',
    transform: { positionM: [x, 0, z], quaternion: IDENTITY_TRANSFORM.quaternion },
    revision: 1,
    config: {},
    capabilities: ['CONTAINER'],
    stationId: 's1',
  };
}

const source = { getApparatus: () => undefined, getFootprint: () => SMALL_FOOTPRINT };

describe('pickApparatus', () => {
  it('hits the apparatus directly under a straight-down ray', () => {
    const index = new SpatialIndex<string>(0.5);
    rebuildPickIndex(index, [instanceAt('a', 0, 0), instanceAt('b', 3, 3)], source);
    const hit = pickApparatus(index, { origin: [0, 5, 0], direction: [0, -1, 0] });
    expect(hit?.instanceId).toBe('a');
  });

  it('returns null when the ray passes between two instances', () => {
    const index = new SpatialIndex<string>(0.5);
    rebuildPickIndex(index, [instanceAt('a', -1, 0), instanceAt('b', 1, 0)], source);
    const hit = pickApparatus(index, { origin: [0, 5, 0], direction: [0, -1, 0] });
    expect(hit).toBeNull();
  });

  it('picks the nearer of two instances along the same ray', () => {
    const index = new SpatialIndex<string>(0.5);
    index.upsert('near', { min: [-0.1, -0.1, -0.1], max: [0.1, 0.1, 0.1] });
    index.upsert('far', { min: [-0.1, -5.1, -0.1], max: [0.1, -4.9, -0.1] });
    const hit = pickApparatus(index, { origin: [0, 5, 0], direction: [0, -1, 0] });
    expect(hit?.instanceId).toBe('near');
  });

  it('respects maxDistanceM and does not report a hit beyond it', () => {
    const index = new SpatialIndex<string>(0.5);
    rebuildPickIndex(index, [instanceAt('a', 0, 0)], source);
    const hit = pickApparatus(index, { origin: [0, 100, 0], direction: [0, -1, 0] }, 5);
    expect(hit).toBeNull();
  });

  it('updatePickIndex moves a single instance without touching the rest', () => {
    const index = new SpatialIndex<string>(0.5);
    rebuildPickIndex(index, [instanceAt('a', 0, 0), instanceAt('b', 10, 10)], source);
    updatePickIndex(index, instanceAt('a', 10, 0), source);
    expect(pickApparatus(index, { origin: [0, 5, 0], direction: [0, -1, 0] })).toBeNull();
    expect(pickApparatus(index, { origin: [10, 5, 0], direction: [0, -1, 0] })?.instanceId).toBe('a');
    expect(index.size).toBe(2);
  });
});

describe('pickApparatusInBox', () => {
  it('returns every instance inside the region, for marquee selection', () => {
    const index = new SpatialIndex<string>(0.5);
    rebuildPickIndex(index, [instanceAt('a', 0, 0), instanceAt('b', 0.3, 0.3), instanceAt('far', 10, 10)], source);
    const ids = pickApparatusInBox(index, { min: [-1, -1, -1], max: [1, 1, 1] }).sort();
    expect(ids).toEqual(['a', 'b']);
  });
});
