import { parseApparatusDefinition, parseExperimentScene, parseLabContract, parseLabJson } from '@matterlab/contracts';
import type { NodeRunRequest, Observation, RuntimeCheckpoint } from '@matterlab/contracts';
import { ScienceClient, ServiceError } from '../../services/science-client';
import type { Download, Page } from '../../services/science-client';
import type { EquipmentPage, LabCapabilities, ReagentPage, RunEvent, RunResource, SceneDraft, SceneResource, SceneSummary, TemplateResource } from './types';

const BASE = '/api/v1/lab';

function id(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new ServiceError(0, 'INVALID_UUID', 'A canonical laboratory UUID is required.');
  }
  return value;
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ServiceError(0, 'INVALID_RESPONSE', 'Expected a typed laboratory response.');
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new ServiceError(0, 'INVALID_RESPONSE', 'The laboratory response is missing required text metadata.');
  return value;
}

export function parseSceneResource(value: unknown): SceneResource {
  const body = object(value);
  return {
    scene: parseExperimentScene(body.scene),
    runtimeCheckpoint: body.runtimeCheckpoint === null ? null : parseLabContract('RuntimeCheckpoint', body.runtimeCheckpoint),
    title: text(body.title), createdAt: text(body.createdAt), updatedAt: text(body.updatedAt),
  };
}

function parseRunResource(value: unknown): RunResource {
  const body = object(value);
  const input = parseLabContract('NodeRunRequest', body.inputSnapshot);
  const result = body.result === null ? null : parseLabContract('RunResult', body.result);
  const runtimeCheckpoint = body.runtimeCheckpoint === null ? null : parseLabContract('RuntimeCheckpoint', body.runtimeCheckpoint);
  if (body.runId !== input.runId || (result && (result.runId !== body.runId || result.inputHash !== body.inputHash || result.status !== body.status))) {
    throw new ServiceError(0, 'INVALID_RESPONSE', 'Run identity, status or hash does not match the immutable result.');
  }
  if (!['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNSUPPORTED'].includes(String(body.status)) ||
      typeof body.sceneRevision !== 'number' || !Number.isInteger(body.sceneRevision) || body.sceneRevision < 1 ||
      typeof body.cancelRequested !== 'boolean' || !/^[a-f0-9]{64}$/.test(String(body.inputHash))) {
    throw new ServiceError(0, 'INVALID_RESPONSE', 'Invalid run metadata.');
  }
  return { ...body, inputSnapshot: input, result, runtimeCheckpoint } as unknown as RunResource;
}

function write(body: unknown, key?: string, revision?: number): RequestInit {
  if (revision !== undefined && (!Number.isInteger(revision) || revision < 1)) throw new ServiceError(0, 'INVALID_REVISION', 'Use the last confirmed server revision.');
  return {
    method: revision === undefined ? 'POST' : 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}), ...(revision === undefined ? {} : { 'If-Match': `"${revision}"` }) },
    body: JSON.stringify(body),
  };
}

export class LabApiClient {
  constructor(readonly service: ScienceClient) {}

  capabilities(signal?: AbortSignal): Promise<LabCapabilities> {
    return this.service.json(BASE + '/capabilities', { signal });
  }

  async createScene(draft: SceneDraft, key: string = crypto.randomUUID(), signal?: AbortSignal): Promise<SceneResource> {
    parseExperimentScene(draft.scene);
    if (draft.runtimeCheckpoint) parseLabContract('RuntimeCheckpoint', draft.runtimeCheckpoint);
    return parseSceneResource(await this.service.json(BASE + '/scenes', { ...write(draft, key), signal }));
  }

  async getScene(sceneId: string, signal?: AbortSignal): Promise<SceneResource> {
    return parseSceneResource(await this.service.json(`${BASE}/scenes/${id(sceneId)}`, { signal }));
  }

  listScenes(query: { readonly q?: string; readonly limit?: number; readonly offset?: number } = {}, signal?: AbortSignal): Promise<Page<SceneSummary>> {
    const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
    return this.service.json(`${BASE}/scenes?${params}`, { signal });
  }

  async saveScene(draft: SceneDraft, confirmedRevision: number, signal?: AbortSignal): Promise<SceneResource> {
    const scene = parseExperimentScene({ ...draft.scene, revision: confirmedRevision });
    // Revision changes describe the persistence envelope only. Never mutate the runtime checkpoint.
    return parseSceneResource(await this.service.json(`${BASE}/scenes/${id(scene.id)}`, { ...write({ ...draft, scene }, undefined, confirmedRevision), signal }));
  }

  async duplicateScene(sceneId: string, title?: string, key: string = crypto.randomUUID(), signal?: AbortSignal): Promise<SceneResource> {
    return parseSceneResource(await this.service.json(`${BASE}/scenes/${id(sceneId)}/duplicate`, { ...write(title === undefined ? {} : { title }, key), signal }));
  }

  async replaySavedScene(sceneId: string, confirmedRevision: number, key: string = crypto.randomUUID(), signal?: AbortSignal): Promise<RunResource> {
    return this.runAdditionalSteps(sceneId, confirmedRevision, [], { key, signal });
  }

  async runAdditionalSteps(
    sceneId: string, confirmedRevision: number, steps: NodeRunRequest['steps'],
    options: { readonly key?: string; readonly limits?: NodeRunRequest['limits']; readonly signal?: AbortSignal } = {},
  ): Promise<RunResource> {
    const body = { expectedRevision: confirmedRevision, steps, ...(options.limits ? { limits: options.limits } : {}) };
    return parseRunResource(await this.service.json(`${BASE}/scenes/${id(sceneId)}/runs`, { ...write(body, options.key ?? crypto.randomUUID()), signal: options.signal }));
  }

  async getRun(runId: string, signal?: AbortSignal): Promise<RunResource> {
    return parseRunResource(await this.service.json(`${BASE}/runs/${id(runId)}`, { signal }));
  }

  async cancelRun(runId: string, signal?: AbortSignal): Promise<RunResource> {
    return parseRunResource(await this.service.json(`${BASE}/runs/${id(runId)}/cancel`, { method: 'POST', signal }));
  }

  async observations(runId: string, offset = 0, signal?: AbortSignal): Promise<Page<Observation>> {
    const page = await this.service.json<Page<unknown>>(`${BASE}/runs/${id(runId)}/observations?limit=250&offset=${offset}`, { signal });
    return { ...page, items: page.items.map((observation) => parseLabContract('Observation', observation)) };
  }

  async equipment(q = '', offset = 0, signal?: AbortSignal): Promise<EquipmentPage> {
    const page = await this.service.json<EquipmentPage>(`${BASE}/equipment-definitions?${new URLSearchParams({ q, offset: String(offset), limit: '50' })}`, { signal });
    return { ...page, items: page.items.map(parseApparatusDefinition) };
  }

  reagents(q = '', offset = 0, signal?: AbortSignal): Promise<ReagentPage> {
    return this.service.json(`${BASE}/reagents?${new URLSearchParams({ q, offset: String(offset), limit: '25' })}`, { signal });
  }

  async saveTemplate(sceneId: string, confirmedRevision: number, title: string, kind: 'SCENE' | 'ASSEMBLY', key: string = crypto.randomUUID()): Promise<TemplateResource> {
    const template = await this.service.json<TemplateResource>(BASE + '/templates', write({ sceneId: id(sceneId), expectedRevision: confirmedRevision, title, kind }, key));
    return { ...template, scene: parseExperimentScene(template.scene) };
  }

  async templates(q = '', offset = 0, signal?: AbortSignal): Promise<Page<TemplateResource>> {
    const page = await this.service.json<Page<TemplateResource>>(`${BASE}/templates?${new URLSearchParams({ q, offset: String(offset), limit: '10' })}`, { signal });
    return { ...page, items: page.items.map((template) => ({ ...template, scene: parseExperimentScene(template.scene) })) };
  }

  async instantiateTemplate(templateId: string, title?: string, key: string = crypto.randomUUID(), signal?: AbortSignal): Promise<SceneResource> {
    return parseSceneResource(await this.service.json(`${BASE}/templates/${id(templateId)}/instantiate`, { ...write(title === undefined ? {} : { title }, key), signal }));
  }

  exportScene(sceneId: string, format: 'json' | 'xlsx', runId?: string, signal?: AbortSignal): Promise<Download> {
    const query = new URLSearchParams({ format, ...(runId ? { runId: id(runId) } : {}) });
    return this.service.download(`${BASE}/scenes/${id(sceneId)}/export?${query}`, `matterlab-lab-${sceneId}.${format}`, signal);
  }

  async *events(runId: string, options: { readonly after?: number; readonly signal?: AbortSignal } = {}): AsyncGenerator<RunEvent> {
    const response = await this.service.response(`${BASE}/runs/${id(runId)}/events`, {
      signal: options.signal,
      headers: { Accept: 'text/event-stream', 'Last-Event-ID': String(options.after ?? 0) },
    }, 65_000);
    if (!response.headers.get('Content-Type')?.toLowerCase().startsWith('text/event-stream')) {
      await response.body?.cancel();
      throw new ServiceError(0, 'INVALID_EVENT_STREAM', 'The service did not return laboratory SSE progress.');
    }
    if (!response.body) throw new ServiceError(0, 'EMPTY_EVENT_STREAM', 'The laboratory event stream has no body.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let last = options.after ?? 0;
    try {
      while (true) {
        const chunk = await reader.read();
        buffer = (buffer + decoder.decode(chunk.value, { stream: !chunk.done })).replace(/\r\n/g, '\n');
        if (buffer.length > 256 * 1024) throw new ServiceError(0, 'INVALID_EVENT_STREAM', 'A progress event exceeded the buffer limit.');
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const lines = event.split('\n');
          const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
          if (!data) continue;
          const parsed = object(JSON.parse(data));
          const eventId = Number(lines.find((line) => line.startsWith('id:'))?.slice(3).trim());
          if (!Number.isSafeInteger(eventId) || eventId !== parsed.sequence || eventId < 1) throw new ServiceError(0, 'INVALID_EVENT_STREAM', 'A progress event had an invalid sequence.');
          if (eventId <= last) continue;
          if (!['QUEUED', 'RUNNING', 'CANCELLING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'UNSUPPORTED'].includes(String(parsed.status))) {
            throw new ServiceError(0, 'INVALID_EVENT_STREAM', 'Unknown run progress status.');
          }
          last = eventId;
          yield parsed as unknown as RunEvent;
        }
        if (chunk.done) return;
      }
    } finally {
      try { await reader.cancel(); } finally { reader.releaseLock(); }
    }
  }
}

export function importSceneDraft(json: string): SceneDraft {
  if (new TextEncoder().encode(json).byteLength > 8 * 1024 * 1024) throw new ServiceError(0, 'IMPORT_TOO_LARGE', 'JSON draft imports are limited to 8 MiB.');
  const body = object(JSON.parse(json, (key: string, value: unknown) => {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new ServiceError(0, 'INVALID_JSON', 'Unsafe JSON object key.');
    return value;
  }));
  if (body.format === 'matterlab-lab-notebook' || body.format === 'matterlab-local-draft') {
    if (body.schemaVersion !== 1) throw new ServiceError(0, 'UNSUPPORTED_SCHEMA_VERSION', 'Only laboratory schema version 1 is supported.');
    const scene = parseExperimentScene(body.scene);
    const checkpoint: RuntimeCheckpoint | null = body.runtimeCheckpoint === null ? null : parseLabContract('RuntimeCheckpoint', body.runtimeCheckpoint);
    return { title: text(body.title), scene, runtimeCheckpoint: checkpoint };
  }
  return { title: 'Imported laboratory draft', scene: parseLabJson('ExperimentScene', json), runtimeCheckpoint: null };
}
