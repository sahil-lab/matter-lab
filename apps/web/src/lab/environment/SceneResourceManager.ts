/**
 * GPU resource lifecycle and on-demand visibility. `SceneResourceManager` is a small
 * reference-counted cache: several stations can share one geometry/material/texture instance
 * (e.g. a bench material, a generated environment map) and it is disposed exactly when the last
 * user releases it, rather than per-component or never.
 */
import { createContext, useContext, useEffect, useRef } from 'react';

interface Entry {
  readonly value: unknown;
  refCount: number;
  readonly dispose: (value: unknown) => void;
}

export class SceneResourceManager {
  private readonly entries = new Map<string, Entry>();

  /** Returns the cached value for `key`, creating it (and setting its ref-count to 1) if absent; otherwise increments the ref-count. */
  acquire<T>(key: string, create: () => T, dispose: (value: T) => void): T {
    const existing = this.entries.get(key);
    if (existing) {
      existing.refCount++;
      return existing.value as T;
    }
    const value = create();
    this.entries.set(key, { value, refCount: 1, dispose: dispose as (value: unknown) => void });
    return value;
  }

  /** Decrements `key`'s ref-count, disposing and evicting it once nothing holds it any longer. */
  release(key: string): void {
    const existing = this.entries.get(key);
    if (!existing) return;
    existing.refCount--;
    if (existing.refCount <= 0) {
      existing.dispose(existing.value);
      this.entries.delete(key);
    }
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  refCount(key: string): number {
    return this.entries.get(key)?.refCount ?? 0;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Disposes everything regardless of ref-count. Called when the environment itself unmounts. */
  disposeAll(): void {
    for (const entry of this.entries.values()) entry.dispose(entry.value);
    this.entries.clear();
  }
}

/** One manager per mounted environment, disposed automatically on unmount. */
export function useSceneResourceManager(): SceneResourceManager {
  const ref = useRef<SceneResourceManager | null>(null);
  if (!ref.current) ref.current = new SceneResourceManager();
  useEffect(() => {
    const manager = ref.current;
    return () => manager?.disposeAll();
  }, []);
  return ref.current;
}

/**
 * `LabWorld` provides the environment's one `SceneResourceManager` on this context, so apparatus
 * content Agent 03/04 render inside a station (glTF geometries/materials/textures shared across
 * stations) can acquire/release through the same cache instead of each creating its own.
 */
export const SceneResourceContext = createContext<SceneResourceManager | null>(null);

export function useSceneResources(): SceneResourceManager {
  const manager = useContext(SceneResourceContext);
  if (!manager) throw new Error('useSceneResources() must be called within <LabWorld>, which provides the SceneResourceContext');
  return manager;
}

/**
 * Beyond this multiple of the far LOD band, an object contributes little enough to the image that
 * it can be skipped (not drawn at all) rather than drawn at its lowest level of detail.
 */
const DEFAULT_CULL_MULTIPLIER = 2.5;

/** Whether something `distanceM` from the camera is far enough to cull entirely, not just reduce in detail. */
export function isBeyondCullDistance(distanceM: number, lodDistancesM: readonly [number, number], cullMultiplier: number = DEFAULT_CULL_MULTIPLIER): boolean {
  return distanceM > lodDistancesM[1] * cullMultiplier;
}
