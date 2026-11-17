import { describe, expect, it, vi } from 'vitest';
import { isBeyondCullDistance, SceneResourceManager } from './SceneResourceManager';

describe('SceneResourceManager', () => {
  it('creates a value once and reuses it for the same key', () => {
    const manager = new SceneResourceManager();
    const create = vi.fn(() => ({ handle: 'geometry' }));
    const dispose = vi.fn();
    const a = manager.acquire('bench-top', create, dispose);
    const b = manager.acquire('bench-top', create, dispose);
    expect(a).toBe(b);
    expect(create).toHaveBeenCalledTimes(1);
    expect(manager.refCount('bench-top')).toBe(2);
  });

  it('only disposes once every acquirer has released it', () => {
    const manager = new SceneResourceManager();
    const dispose = vi.fn();
    manager.acquire('tex', () => 'value', dispose);
    manager.acquire('tex', () => 'value', dispose);
    manager.release('tex');
    expect(dispose).not.toHaveBeenCalled();
    expect(manager.has('tex')).toBe(true);
    manager.release('tex');
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(manager.has('tex')).toBe(false);
  });

  it('releasing an unknown key is a harmless no-op', () => {
    const manager = new SceneResourceManager();
    expect(() => manager.release('never-acquired')).not.toThrow();
  });

  it('reports a ref-count of zero for a key that was never acquired', () => {
    const manager = new SceneResourceManager();
    expect(manager.refCount('nope')).toBe(0);
  });

  it('tracks the number of distinct cached keys', () => {
    const manager = new SceneResourceManager();
    manager.acquire('a', () => 1, () => {});
    manager.acquire('b', () => 2, () => {});
    manager.acquire('a', () => 1, () => {});
    expect(manager.size).toBe(2);
  });

  it('disposeAll disposes every entry exactly once, however many times it was acquired', () => {
    const manager = new SceneResourceManager();
    const disposeA = vi.fn();
    const disposeB = vi.fn();
    manager.acquire('a', () => 1, disposeA);
    manager.acquire('a', () => 1, disposeA);
    manager.acquire('b', () => 2, disposeB);
    manager.disposeAll();
    expect(disposeA).toHaveBeenCalledTimes(1);
    expect(disposeB).toHaveBeenCalledTimes(1);
    expect(manager.size).toBe(0);
  });

  it('a fresh create after disposal makes a new value', () => {
    const manager = new SceneResourceManager();
    let counter = 0;
    const create = () => ++counter;
    manager.acquire('a', create, () => {});
    manager.release('a');
    const second = manager.acquire('a', create, () => {});
    expect(second).toBe(2);
  });
});

describe('isBeyondCullDistance', () => {
  const bands: readonly [number, number] = [5, 15];

  it('does not cull anything within the LOD bands', () => {
    expect(isBeyondCullDistance(14, bands)).toBe(false);
  });

  it('culls once well past the far band', () => {
    expect(isBeyondCullDistance(15 * 2.5 + 1, bands)).toBe(true);
  });

  it('respects a custom cull multiplier', () => {
    expect(isBeyondCullDistance(20, bands, 1)).toBe(true);
    expect(isBeyondCullDistance(20, bands, 10)).toBe(false);
  });
});
