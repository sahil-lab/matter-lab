import { LAB_CONTRACT_VERSION, parseExperimentScene } from '@matterlab/contracts';
import type { RuntimeCheckpoint } from '@matterlab/contracts';
import { describe, expect, it, vi } from 'vitest';
import { ScienceClient } from '../../services/science-client';
import { LabApiClient, importSceneDraft } from './client';
import { ScenePersistenceCoordinator } from './coordinator';
import { LocalDraftCache, MemoryDraftCache, localDraft } from './drafts';
import type { RunResource, SceneDraft, SceneResource } from './types';

const sceneId = '00000000-0000-4000-8000-000000000001';
const stationId = '00000000-0000-4000-8000-000000000002';
const runId = '00000000-0000-4000-8000-000000000003';
const time = '2026-11-16T12:00:00Z';

function draft(): SceneDraft {
  return {
    title: 'Saved trial',
    scene: parseExperimentScene({
      id: sceneId, revision: 0, schemaVersion: 1, stations: [{ id: stationId, name: 'First station' }],
      apparatus: [], connections: [], containerStates: {}, simulationConfig: { methodId: 'aqueous-acid-base-ideal-v1', timeStepS: 0.1 },
      viewport: { positionM: [1, 2, 3] },
    }),
    runtimeCheckpoint: null,
  };
}

function saved(value = draft(), revision = 1): SceneResource {
  return { ...value, scene: { ...value.scene, revision }, createdAt: time, updatedAt: time };
}

function checkpoint(value = draft()): RuntimeCheckpoint {
  return {
    schemaVersion: 1, contractVersion: LAB_CONTRACT_VERSION, runtimeVersion: '1.0.0', methodVersion: '1.0.0', inputHash: 'a'.repeat(64),
    initialScene: value.scene,
    snapshot: {
      schemaVersion: 1, runId, revision: 0, scene: value.scene, stationStates: {
        [stationId]: { stationId, epoch: 0, status: 'PREPARING', simulationTimeS: 0, tick: 0, speed: 1 },
      }, apparatusStates: {}, transferTotals: [], observations: [], lastSequence: 0,
    },
    steps: [], completedStepCount: 0, events: [],
  };
}

function queuedRun(): RunResource {
  return {
    runId, sceneId, sceneRevision: 3, status: 'QUEUED', inputHash: 'a'.repeat(64), result: null, runtimeCheckpoint: null,
    inputSnapshot: { schemaVersion: 1, runId, contractVersion: LAB_CONTRACT_VERSION, runtimeVersion: '1.0.0', methodVersion: '1.0.0', initialScene: draft().scene, steps: [] },
    failureCode: null, cancelRequested: false, createdAt: time, startedAt: null, completedAt: null, unitsPolicy: {}, catalogSnapshot: {}, runnerSha256: null, artifacts: [],
  };
}

describe('typed laboratory persistence', () => {
  it('patches the durable revision without mutating checkpoint/hash inputs', async () => {
    const original = draft();
    const cp = checkpoint(original);
    const input = { ...original, runtimeCheckpoint: cp };
    const before = JSON.stringify(input);
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => Response.json(saved(JSON.parse(String(init?.body)) as SceneDraft, 4)));
    const api = new LabApiClient(new ScienceClient({ fetch: fetcher }));
    const result = await api.saveScene(input, 3);
    const init = fetcher.mock.calls[0]?.[1];
    const payload = JSON.parse(String(init?.body)) as SceneDraft;
    expect(new Headers(init?.headers).get('If-Match')).toBe('"3"');
    expect(payload.scene.revision).toBe(3);
    expect(payload.runtimeCheckpoint).toEqual(cp);
    expect(result.scene.revision).toBe(4);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('replays the saved checkpoint without resending already-recorded steps', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json(queuedRun()));
    const api = new LabApiClient(new ScienceClient({ fetch: fetcher }));
    await api.replaySavedScene(sceneId, 3, 'repeatable-job');
    const init = fetcher.mock.calls[0]?.[1];
    expect(JSON.parse(String(init?.body))).toEqual({ expectedRevision: 3, steps: [] });
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('repeatable-job');
  });

  it('keeps failed remote saves explicitly local and detects optimistic conflicts', async () => {
    const cache = new MemoryDraftCache();
    const fetcher = vi.fn().mockResolvedValue(Response.json({ code: 'REVISION_CONFLICT', detail: 'Changed by another editor', details: { currentRevision: 3 } }, { status: 409 }));
    const coordinator = new ScenePersistenceCoordinator(new LabApiClient(new ScienceClient({ fetch: fetcher })), sceneId, 1, cache);
    await expect(coordinator.save(draft())).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(coordinator.getState()).toMatchObject({ status: 'conflict', currentRevision: 3 });
    expect(coordinator.getConfirmedRevision()).toBe(1);
    expect(cache.read(sceneId)?.remoteSave).toBe('UNCONFIRMED');
  });

  it('retries an ambiguous create with identical payload/key before saving newer edits', async () => {
    let call = 0;
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      call++;
      if (call === 1) throw new TypeError('Response lost');
      return Response.json(saved(JSON.parse(String(init?.body)) as SceneDraft, call === 2 ? 1 : 2));
    });
    const cache = new MemoryDraftCache();
    const coordinator = new ScenePersistenceCoordinator(new LabApiClient(new ScienceClient({ fetch: fetcher })), sceneId, null, cache);
    await expect(coordinator.save(draft())).rejects.toMatchObject({ code: 'SERVICE_OFFLINE' });
    expect(coordinator.getState()).toMatchObject({ status: 'local-draft', remoteSave: 'UNCONFIRMED' });
    const result = await coordinator.save({ ...draft(), title: 'Newer local title' });
    const [first, retry, patch] = fetcher.mock.calls.map((entry) => entry[1]);
    expect(first?.body).toBe(retry?.body);
    expect(new Headers(first?.headers).get('Idempotency-Key')).toBe(new Headers(retry?.headers).get('Idempotency-Key'));
    expect(patch?.method).toBe('PATCH');
    expect(new Headers(patch?.headers).get('If-Match')).toBe('"1"');
    expect(result.title).toBe('Newer local title');
    expect(coordinator.getState()).toMatchObject({ status: 'saved', revision: 2 });
    expect(cache.read(sceneId)).toBeNull();
  });

  it('never marks edits made during an in-flight save as remotely saved', async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn(async () => new Promise<Response>((resolve) => { finish = resolve; }));
    const cache = new MemoryDraftCache();
    const coordinator = new ScenePersistenceCoordinator(new LabApiClient(new ScienceClient({ fetch: fetcher })), sceneId, null, cache);
    const saving = coordinator.save(draft());
    await Promise.resolve();
    await Promise.resolve();
    coordinator.stage({ ...draft(), title: 'Unsaved edit during request' });
    finish(Response.json(saved()));
    await saving;
    expect(coordinator.getState()).toMatchObject({ status: 'local-draft', remoteSave: 'UNCONFIRMED' });
    expect(cache.read(sceneId)?.title).toBe('Unsaved edit during request');
  });

  it('roundtrips a JSON draft without importing result claims and partitions opted-in cache', () => {
    const value: SceneDraft = {
      ...draft(), runtimeCheckpoint: checkpoint(), learningState: { schemaVersion: 1, kind: 'MATTERLAB_LEARNING_STATE', attempts: [] },
      editorState: { schemaVersion: 1, sceneId, activeStationId: stationId, selectedIds: [], lockedIds: [], groups: [], mode: 'select', snapM: 0.01, angleStepDeg: 15, initialTransforms: {} },
    };
    const archive = JSON.stringify({ format: 'matterlab-lab-notebook', schemaVersion: 1, ...value, runs: [{ fraudulent: 'ignored' }] });
    expect(importSceneDraft(archive)).toEqual(value);
    const values = new Map<string, string>();
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, data: string) => { values.set(key, data); }, removeItem: (key: string) => { values.delete(key); } };
    const ownerA = new LocalDraftCache(storage, 'owner-a@service');
    const ownerB = new LocalDraftCache(storage, 'owner-b@service');
    ownerA.write(localDraft(value, 1));
    expect(ownerA.read(sceneId)?.scene).toEqual(value.scene);
    expect(ownerA.read(sceneId)?.learningState).toEqual(value.learningState);
    expect(ownerA.read(sceneId)?.editorState).toEqual(value.editorState);
    expect(ownerB.read(sceneId)).toBeNull();
    expect([...values.values()].every((text) => !text.includes('Authorization') && !text.includes('Bearer'))).toBe(true);
  });

  it('reads authenticated reconnectable SSE, preserving sequence and CRLF chunk boundaries', async () => {
    const chunks = [
      'id: 1\r\nevent: status\r\ndata: {"sequence":1,"status":"RUNNING"}\r',
      '\n\r\nid: 2\r\nevent: status\r\ndata: {"sequence":2,"status":"CANCELLED"}\r\n\r\n',
    ];
    const body = new ReadableStream<Uint8Array>({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } });
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
    const api = new LabApiClient(new ScienceClient({ fetch: fetcher, token: () => 'memory-only' }));
    const received = [];
    for await (const event of api.events(runId, { after: 1 })) received.push(event);
    expect(received).toEqual([{ sequence: 2, status: 'CANCELLED' }]);
    const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
    expect(headers.get('Last-Event-ID')).toBe('1');
    expect(headers.get('Authorization')).toBe('Bearer memory-only');
  });
});
