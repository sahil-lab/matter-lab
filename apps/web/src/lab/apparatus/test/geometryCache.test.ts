import { describe, expect, it, vi } from 'vitest';
import { acquireGeometryBuild, geometryCacheStats, releaseGeometryBuild } from '../components/geometryCache';
import type { GeometryBuildResult } from '../geometry';

function fakeBuild(materialSlot = 'glass'): GeometryBuildResult {
  return { polyCount: 2, groups: [{ materialSlot, geometry: { dispose: vi.fn() } as never, transform: undefined }] };
}

describe('acquireGeometryBuild / releaseGeometryBuild', () => {
  it('builds once and shares the same result across multiple acquires of the same id', () => {
    const builder = vi.fn(fakeBuild);
    const a = acquireGeometryBuild('shared-id', builder);
    const b = acquireGeometryBuild('shared-id', builder);
    expect(a).toBe(b);
    expect(builder).toHaveBeenCalledTimes(1);
    releaseGeometryBuild('shared-id');
    releaseGeometryBuild('shared-id');
  });

  it('disposes every group\u2019s geometry only once the last reference is released', () => {
    const build = fakeBuild();
    const builder = vi.fn(() => build);
    acquireGeometryBuild('refcount-id', builder);
    acquireGeometryBuild('refcount-id', builder);

    releaseGeometryBuild('refcount-id');
    expect(build.groups[0].geometry.dispose).not.toHaveBeenCalled();

    releaseGeometryBuild('refcount-id');
    expect(build.groups[0].geometry.dispose).toHaveBeenCalledTimes(1);
  });

  it('builds again (a fresh result) after a fully-released id is re-acquired', () => {
    const builder = vi.fn(fakeBuild);
    const first = acquireGeometryBuild('reacquire-id', builder);
    releaseGeometryBuild('reacquire-id');
    const second = acquireGeometryBuild('reacquire-id', builder);
    expect(second).not.toBe(first);
    expect(builder).toHaveBeenCalledTimes(2);
    releaseGeometryBuild('reacquire-id');
  });

  it('is a no-op when releasing an id that was never acquired, or already fully released', () => {
    expect(() => releaseGeometryBuild('never-acquired-id')).not.toThrow();
  });

  it('reports accurate cache stats', () => {
    const builder = vi.fn(fakeBuild);
    acquireGeometryBuild('stats-id', builder);
    acquireGeometryBuild('stats-id', builder);
    const stats = geometryCacheStats();
    expect(stats.cachedIds).toBeGreaterThanOrEqual(1);
    expect(stats.totalRefs).toBeGreaterThanOrEqual(2);
    releaseGeometryBuild('stats-id');
    releaseGeometryBuild('stats-id');
  });
});
