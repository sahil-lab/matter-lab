/**
 * A refcounted cache of built geometry, keyed by `proceduralBuilderId`. Many instances of the same
 * apparatus definition (ten identical beakers, say) previously each built and disposed their own
 * private copy of the same `BufferGeometry`s; this cache lets them share one copy, disposing it
 * only once the last consumer releases it. `ApparatusMesh` is the only intended caller.
 */
import type { GeometryBuildResult } from '../geometry';

interface CacheEntry {
  readonly build: GeometryBuildResult;
  refCount: number;
}

const cache = new Map<string, CacheEntry>();

/** Returns the shared `GeometryBuildResult` for `id`, building it via `builder()` only if no other
 * consumer currently holds it. Each call increments a reference count — pair every `acquire` with
 * exactly one later `release` (see `ApparatusMesh`'s `useEffect` cleanup). */
export function acquireGeometryBuild(id: string, builder: () => GeometryBuildResult): GeometryBuildResult {
  let entry = cache.get(id);
  if (!entry) {
    entry = { build: builder(), refCount: 0 };
    cache.set(id, entry);
  }
  entry.refCount += 1;
  return entry.build;
}

/** Releases one reference acquired via `acquireGeometryBuild(id, ...)`. Disposes every group's
 * geometry and evicts the cache entry once the reference count reaches zero. A no-op if `id` is
 * not (or is no longer) cached, so a mismatched extra release cannot throw. */
export function releaseGeometryBuild(id: string): void {
  const entry = cache.get(id);
  if (!entry) return;
  entry.refCount -= 1;
  if (entry.refCount <= 0) {
    for (const group of entry.build.groups) group.geometry.dispose();
    cache.delete(id);
  }
}

/** The number of distinct geometries currently cached, and the total outstanding reference count
 * across them — exposed for tests, not meant for production use. */
export function geometryCacheStats(): { readonly cachedIds: number; readonly totalRefs: number } {
  let totalRefs = 0;
  for (const entry of cache.values()) totalRefs += entry.refCount;
  return { cachedIds: cache.size, totalRefs };
}
