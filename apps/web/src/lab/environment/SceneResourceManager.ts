export interface DisposableSceneResource { dispose(): void }

/** Only register resources owned by this environment, never another agent's scene subtree. */
export class SceneResourceScope {
  private resources = new Set<DisposableSceneResource>();
  private disposed = false;

  own<T extends DisposableSceneResource>(resource: T): T {
    if (this.disposed) throw new Error('Cannot add a resource to a disposed scene scope.');
    this.resources.add(resource);
    return resource;
  }

  get size(): number { return this.resources.size; }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const errors: unknown[] = [];
    for (const resource of this.resources) {
      try { resource.dispose(); } catch (error) { errors.push(error); }
    }
    this.resources.clear();
    if (errors.length) throw new AggregateError(errors, 'Scene resource disposal failed.');
  }
}

export interface SceneAssetLease<T> {
  readonly ready: Promise<T>;
  release(): void;
}

/** Reference-counted, on-demand loading with late-result cleanup after cancellation/unmount. */
export function createSceneAssetPool<T extends DisposableSceneResource>() {
  interface Entry {
    references: number;
    abort: AbortController;
    ready: Promise<T>;
    value?: T;
  }
  const entries = new Map<string, Entry>();
  return {
    get size(): number { return entries.size; },
    acquire(key: string, load: (signal: AbortSignal) => Promise<T>): SceneAssetLease<T> {
      let entry = entries.get(key);
      if (!entry) {
        const abort = new AbortController();
        const created: Entry = {
          references: 0, abort,
          ready: Promise.resolve().then(() => load(abort.signal)).then((value) => {
            if (created.references === 0) value.dispose();
            else created.value = value;
            return value;
          }, (error: unknown) => {
            if (entries.get(key) === created) entries.delete(key);
            throw error;
          }),
        };
        entry = created;
        entries.set(key, created);
      }
      const acquired = entry;
      acquired.references += 1;
      let released = false;
      return {
        ready: acquired.ready,
        release() {
          if (released) return;
          released = true;
          acquired.references -= 1;
          if (acquired.references === 0) {
            if (entries.get(key) === acquired) entries.delete(key);
            acquired.abort.abort();
            acquired.value?.dispose();
            acquired.value = undefined;
          }
        },
      };
    },
  };
}
