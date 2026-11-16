import { describe, expect, it } from 'vitest';
import { SpatialIndex } from './spatialIndex';

describe('SpatialIndex', () => {
  it('finds an entry whose box overlaps the query box', () => {
    const index = new SpatialIndex<string>(0.5);
    index.upsert('a', { min: [0, 0, 0], max: [0.2, 0.2, 0.2] });
    index.upsert('b', { min: [5, 5, 5], max: [5.2, 5.2, 5.2] });
    expect(index.queryBox({ min: [-1, -1, -1], max: [1, 1, 1] })).toEqual(['a']);
  });

  it('removes an entry so it no longer matches any query', () => {
    const index = new SpatialIndex<string>(0.5);
    index.upsert('a', { min: [0, 0, 0], max: [0.2, 0.2, 0.2] });
    index.remove('a');
    expect(index.queryBox({ min: [-1, -1, -1], max: [1, 1, 1] })).toEqual([]);
    expect(index.size).toBe(0);
  });

  it('upsert replaces a prior entry instead of duplicating it across cells', () => {
    const index = new SpatialIndex<string>(0.5);
    index.upsert('a', { min: [0, 0, 0], max: [0.2, 0.2, 0.2] });
    index.upsert('a', { min: [10, 10, 10], max: [10.2, 10.2, 10.2] });
    expect(index.size).toBe(1);
    expect(index.queryBox({ min: [-1, -1, -1], max: [1, 1, 1] })).toEqual([]);
    expect(index.queryBox({ min: [9, 9, 9], max: [11, 11, 11] })).toEqual(['a']);
  });

  it('a box spanning many cells is still found by a query touching only one of them', () => {
    const index = new SpatialIndex<string>(0.5);
    index.upsert('bench', { min: [-2, 0, -1], max: [2, 0.1, 1] });
    expect(index.queryBox({ min: [1.8, 0, 0.8], max: [2.2, 0.2, 1.2] })).toEqual(['bench']);
  });

  it('queryNear finds entries within a radius of a point', () => {
    const index = new SpatialIndex<string>(0.5);
    index.upsert('near', { min: [0, 0, 0], max: [0.1, 0.1, 0.1] });
    index.upsert('far', { min: [9, 9, 9], max: [9.1, 9.1, 9.1] });
    expect(index.queryNear([0, 0, 0], 0.5)).toEqual(['near']);
  });

  it('remains correct for 150 scattered entries (selection at scene sizes the brief calls out)', () => {
    const index = new SpatialIndex<number>(0.5);
    for (let i = 0; i < 150; i++) {
      const x = (i % 15) * 0.3;
      const z = Math.floor(i / 15) * 0.3;
      index.upsert(i, { min: [x, 0, z], max: [x + 0.1, 0.1, z + 0.1] });
    }
    expect(index.size).toBe(150);
    // A query box around entry 37's known position should find exactly that entry.
    const x37 = (37 % 15) * 0.3;
    const z37 = Math.floor(37 / 15) * 0.3;
    expect(index.queryBox({ min: [x37 - 0.01, -1, z37 - 0.01], max: [x37 + 0.11, 1, z37 + 0.11] })).toEqual([37]);
  });
});
