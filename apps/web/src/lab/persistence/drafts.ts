import { parseExperimentScene, parseLabContract } from '@matterlab/contracts';
import type { DraftRecord, SceneDraft } from './types';

export interface DraftCache {
  read(sceneId: string): DraftRecord | null;
  write(draft: DraftRecord): void;
  remove(sceneId: string): void;
}

function verified(value: unknown): DraftRecord {
  if (!value || typeof value !== 'object') throw new Error('Invalid local draft');
  const record = value as DraftRecord;
  if (record.format !== 'matterlab-local-draft' || record.schemaVersion !== 1 || record.remoteSave !== 'UNCONFIRMED' ||
      typeof record.title !== 'string' || typeof record.savedLocallyAt !== 'string' ||
      (record.baseRevision !== null && (!Number.isInteger(record.baseRevision) || record.baseRevision < 1))) throw new Error('Invalid local draft');
  return {
    format: 'matterlab-local-draft', schemaVersion: 1, remoteSave: 'UNCONFIRMED',
    title: record.title, savedLocallyAt: record.savedLocallyAt, baseRevision: record.baseRevision,
    scene: parseExperimentScene(record.scene),
    runtimeCheckpoint: record.runtimeCheckpoint === null ? null : parseLabContract('RuntimeCheckpoint', record.runtimeCheckpoint),
  };
}

export function localDraft(draft: SceneDraft, baseRevision: number | null): DraftRecord {
  return verified({ ...draft, format: 'matterlab-local-draft', schemaVersion: 1, remoteSave: 'UNCONFIRMED', baseRevision, savedLocallyAt: new Date().toISOString() });
}

/** Default cache: session memory. Persistent browser storage is opt-in through LocalDraftCache. */
export class MemoryDraftCache implements DraftCache {
  private readonly records = new Map<string, DraftRecord>();
  read(sceneId: string): DraftRecord | null { return this.records.get(sceneId) ?? null; }
  write(draft: DraftRecord): void { const record = verified(draft); this.records.set(record.scene.id, record); }
  remove(sceneId: string): void { this.records.delete(sceneId); }
}

/** Scope is a nonsecret account+service namespace, never a token. Only typed draft data is stored. */
export class LocalDraftCache implements DraftCache {
  private readonly prefix: string;
  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, scope: string) {
    if (!scope.trim()) throw new Error('A nonsecret account/service draft namespace is required.');
    this.prefix = `matterlab:lab:draft:${encodeURIComponent(scope)}:`;
  }
  read(sceneId: string): DraftRecord | null {
    const text = this.storage.getItem(this.prefix + sceneId);
    if (text === null) return null;
    const record = verified(JSON.parse(text));
    if (record.scene.id !== sceneId) throw new Error('Local draft identity mismatch');
    return record;
  }
  write(draft: DraftRecord): void {
    const record = verified(draft);
    this.storage.setItem(this.prefix + record.scene.id, JSON.stringify(record));
  }
  remove(sceneId: string): void { this.storage.removeItem(this.prefix + sceneId); }
}
