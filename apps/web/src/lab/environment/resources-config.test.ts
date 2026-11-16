import { describe, expect, it, vi } from 'vitest';
import { defaultEnvironmentSnapshot, parseEnvironmentSnapshot, serializeEnvironmentSnapshot, stationLayoutAnchors } from './RoomConfig';
import { createSceneAssetPool, SceneResourceScope } from './SceneResourceManager';
import { IDENTITY_LAB_TRANSFORM } from './coordinates';
import { DEFAULT_CAMERA_VIEW } from './cameraMath';

describe('render-only environment serialization', () => {
  it('round-trips layouts/bookmarks and discards any simulation truth supplied as unknown fields', () => {
    const source = {
      ...defaultEnvironmentSnapshot(), mode: 'studio',
      bookmarks: [{ id: 'bookmark-a', name: 'Station A', view: DEFAULT_CAMERA_VIEW }],
      benchLayout: [{ instanceId: 'bench-a', stationId: 'station-a', transform: IDENTITY_LAB_TRANSFORM }],
      containerStates: { flask: { volumeL: 10 } }, observations: [{ pH: 7 }],
    };
    const before = JSON.stringify(source);
    const parsed = parseEnvironmentSnapshot(source);
    expect(parseEnvironmentSnapshot(JSON.parse(serializeEnvironmentSnapshot(parsed)))).toEqual(parsed);
    expect(parsed).not.toHaveProperty('containerStates');
    expect(parsed).not.toHaveProperty('observations');
    expect(JSON.stringify(source)).toBe(before);
  });

  it('rejects angstrom scenes, bad versions, nonfinite cameras and duplicate or unbounded layout entries', () => {
    const base = defaultEnvironmentSnapshot();
    expect(() => parseEnvironmentSnapshot({ ...base, units: 'angstrom' })).toThrow();
    expect(() => parseEnvironmentSnapshot({ ...base, schemaVersion: 2 })).toThrow();
    expect(() => parseEnvironmentSnapshot({ ...base, view: { ...base.view, positionM: [NaN, 2, 3] } })).toThrow();
    const entry = { instanceId: 'same-bench', stationId: 'a', transform: IDENTITY_LAB_TRANSFORM };
    expect(() => parseEnvironmentSnapshot({ ...base, benchLayout: [entry, entry] })).toThrow(/Duplicate/);
    expect(() => parseEnvironmentSnapshot({ ...base, benchLayout: Array(33).fill(entry) })).toThrow();
  });

  it('suggests separate station anchor transforms without creating scene IDs or apparatus state', () => {
    const anchors = stationLayoutAnchors(4);
    expect(anchors).toHaveLength(4);
    expect(new Set(anchors.map((anchor) => JSON.stringify(anchor.positionM))).size).toBe(4);
    expect(anchors.every((anchor) => anchor.positionM[1] === 0)).toBe(true);
    expect(() => stationLayoutAnchors(9)).toThrow();
  });
});

describe('environment resource lifetimes', () => {
  it('disposes a shared resource once and completes cleanup even when another disposer throws', () => {
    const scope = new SceneResourceScope();
    const first = { dispose: vi.fn() };
    const last = { dispose: vi.fn() };
    scope.own(first);
    scope.own(first);
    scope.own({ dispose() { throw new Error('failed disposal'); } });
    scope.own(last);
    expect(() => scope.dispose()).toThrow(AggregateError);
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(last.dispose).toHaveBeenCalledOnce();
    scope.dispose();
    expect(first.dispose).toHaveBeenCalledOnce();
  });

  it('loads assets only on demand, shares pending loads and frees them after the last lease', async () => {
    const pool = createSceneAssetPool<{ dispose(): void }>();
    const asset = { dispose: vi.fn() };
    const load = vi.fn(async () => asset);
    expect(load).not.toHaveBeenCalled();
    const a = pool.acquire('lighting-rig', load);
    const b = pool.acquire('lighting-rig', load);
    expect(await a.ready).toBe(await b.ready);
    expect(load).toHaveBeenCalledOnce();
    a.release();
    a.release();
    expect(asset.dispose).not.toHaveBeenCalled();
    b.release();
    expect(asset.dispose).toHaveBeenCalledOnce();
    expect(pool.size).toBe(0);
  });

  it('disposes an asset that arrives after its final lease was released', async () => {
    const pool = createSceneAssetPool<{ dispose(): void }>();
    let resolve!: (asset: { dispose(): void }) => void;
    let signal: AbortSignal | undefined;
    const lease = pool.acquire('late', (abortSignal) => {
      signal = abortSignal;
      return new Promise((complete) => { resolve = complete; });
    });
    await Promise.resolve();
    lease.release();
    expect(signal?.aborted).toBe(true);
    const asset = { dispose: vi.fn() };
    resolve(asset);
    await lease.ready;
    expect(asset.dispose).toHaveBeenCalledOnce();
    expect(pool.size).toBe(0);
  });

  it('evicts failed loads so a retry is independent of stale lease releases', async () => {
    const pool = createSceneAssetPool<{ dispose(): void }>();
    const failed = pool.acquire('retry', async () => { throw new Error('unavailable'); });
    await expect(failed.ready).rejects.toThrow('unavailable');
    const asset = { dispose: vi.fn() };
    const retry = pool.acquire('retry', async () => asset);
    await retry.ready;
    failed.release();
    expect(pool.size).toBe(1);
    expect(asset.dispose).not.toHaveBeenCalled();
    retry.release();
    expect(asset.dispose).toHaveBeenCalledOnce();
  });
});
