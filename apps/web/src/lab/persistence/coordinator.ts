import { ServiceError } from '../../services/science-client';
import { LabApiClient } from './client';
import { MemoryDraftCache, localDraft } from './drafts';
import type { DraftCache } from './drafts';
import type { SceneDraft, SceneResource } from './types';

export type PersistenceState =
  | { readonly status: 'idle' }
  | { readonly status: 'saving' }
  | { readonly status: 'saved'; readonly revision: number; readonly at: string }
  | { readonly status: 'local-draft'; readonly reason: string; readonly remoteSave: 'UNCONFIRMED' }
  | { readonly status: 'conflict'; readonly currentRevision?: number; readonly reason: string };

/** Serializes saves without becoming another writer of the experiment/runtime state. */
export class ScenePersistenceCoordinator {
  private revision: number | null;
  private state: PersistenceState = { status: 'idle' };
  private readonly listeners = new Set<(state: PersistenceState) => void>();
  private queued: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private pendingCreate: { readonly draft: SceneDraft; readonly key: string } | null = null;

  constructor(
    private readonly api: LabApiClient,
    readonly sceneId: string,
    confirmedRevision: number | null = null,
    readonly drafts: DraftCache = new MemoryDraftCache(),
  ) { this.revision = confirmedRevision; }

  getState(): PersistenceState { return this.state; }
  getConfirmedRevision(): number | null { return this.revision; }
  subscribe(listener: (state: PersistenceState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private publish(state: PersistenceState) {
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }

  stage(draft: SceneDraft): number {
    if (draft.scene.id !== this.sceneId) throw new Error('Persistence coordinator belongs to another scene.');
    const generation = ++this.generation;
    try {
      this.drafts.write(localDraft(draft, this.revision));
      this.publish({ status: 'local-draft', remoteSave: 'UNCONFIRMED', reason: 'Local changes only; not confirmed in PostgreSQL.' });
    } catch {
      this.publish({ status: 'local-draft', remoteSave: 'UNCONFIRMED', reason: 'Local changes are in memory only; browser draft storage is unavailable.' });
    }
    return generation;
  }

  save(draft: SceneDraft, signal?: AbortSignal): Promise<SceneResource> {
    const generation = this.stage(draft);
    const frozen = localDraft(draft, this.revision);
    const snapshot: SceneDraft = {
      title: frozen.title, scene: frozen.scene, runtimeCheckpoint: frozen.runtimeCheckpoint,
      ...(frozen.learningState === undefined ? {} : { learningState: frozen.learningState }),
    };
    const operation = this.queued.catch(() => undefined).then(async () => {
      if (signal?.aborted) throw new ServiceError(0, 'REQUEST_ABORTED', 'The queued save was cancelled before it was sent.');
      this.publish({ status: 'saving' });
      try {
        let saved: SceneResource;
        if (this.revision === null) {
          this.pendingCreate ??= { draft: snapshot, key: crypto.randomUUID() };
          const pending = this.pendingCreate;
          saved = await this.api.createScene(pending.draft, pending.key, signal);
          this.revision = saved.scene.revision;
          this.pendingCreate = null;
          if (JSON.stringify(pending.draft) !== JSON.stringify(snapshot)) saved = await this.api.saveScene(snapshot, saved.scene.revision, signal);
        } else {
          saved = await this.api.saveScene(snapshot, this.revision, signal);
        }
        this.revision = saved.scene.revision;
        if (generation === this.generation) {
          try { this.drafts.remove(this.sceneId); } catch { /* A stale local draft is never a server write confirmation. */ }
          this.publish({ status: 'saved', revision: saved.scene.revision, at: saved.updatedAt });
        } else {
          this.publish({ status: 'local-draft', remoteSave: 'UNCONFIRMED', reason: `Revision ${saved.scene.revision} saved; newer local changes remain unsaved.` });
        }
        return saved;
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'No remote save was confirmed.';
        if (error instanceof ServiceError && error.status === 409) {
          const details = error.details as { readonly currentRevision?: number } | null;
          this.publish({ status: 'conflict', reason, currentRevision: details?.currentRevision });
        } else {
          this.publish({ status: 'local-draft', remoteSave: 'UNCONFIRMED', reason });
        }
        throw error;
      }
    });
    this.queued = operation;
    return operation;
  }
}
