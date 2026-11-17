import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.js';
import { closeContext } from '../src/context.js';
import { authed, buildTestContext, testApp } from './helpers.js';

describe('lab scenes API', () => {
  let ctx: AppContext;
  let app: ReturnType<typeof testApp>;

  beforeAll(async () => {
    ctx = await buildTestContext();
    app = testApp(ctx);
  });

  afterAll(async () => {
    await closeContext(ctx);
  });

  function fullSceneBody(title: string) {
    const stationId = randomUUID();
    const flaskId = randomUUID();
    const buretteId = randomUUID();
    return {
      title,
      stations: [{ id: stationId, name: 'Station 1' }],
      apparatus: [
        {
          id: flaskId,
          kind: 'FLASK',
          definitionId: 'erlenmeyer-flask-250ml',
          transform: { positionM: [0, 0.1, 0.2], quaternion: [0, 0, 0, 1] },
          revision: 0,
          config: {},
          capabilities: ['CONTAINER', 'FLOW_RECEIVER'],
          stationId,
        },
        {
          id: buretteId,
          kind: 'BURETTE',
          definitionId: 'burette-50ml',
          transform: { positionM: [0, 0.5, 0.2], quaternion: [0, 0, 0, 1] },
          revision: 0,
          config: { valveOpenFraction: 0 },
          capabilities: ['CONTAINER', 'FLOW_SOURCE'],
          stationId,
        },
      ],
      connections: [{ id: randomUUID(), from: { instanceId: buretteId, socketId: 'tip' }, to: { instanceId: flaskId, socketId: 'opening' }, kind: 'FLUID', enabled: true }],
      containerStates: {
        [flaskId]: { volumeL: 0.025, species: [{ speciesId: 'HCl(aq)', moles: 0.0025 }], temperatureK: 298.15, mixing: 'WELL_MIXED', modelId: 'ideal-well-mixed-v1' },
        [buretteId]: { volumeL: 0.05, species: [{ speciesId: 'NaOH(aq)', moles: 0.005 }], temperatureK: 298.15, mixing: 'WELL_MIXED', modelId: 'ideal-well-mixed-v1' },
      },
      simulationConfig: { methodId: 'fixed-tick-v1', timeStepS: 0.1 },
    };
  }

  it('rejects requests without an API key', async () => {
    const response = await app.get('/api/v1/lab/scenes');
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('unauthorized');
  });

  it('creates a scene and reopens it with exactly the same state (save/reopen survives exactly)', async () => {
    const body = fullSceneBody(`Test scene ${randomUUID()}`);
    const created = await authed(app.post('/api/v1/lab/scenes')).send(body);
    expect(created.status).toBe(201);
    expect(created.body.revision).toBe(1);
    expect(created.headers.etag).toBe('W/"rev-1"');

    const reopened = await authed(app.get(`/api/v1/lab/scenes/${created.body.id}`));
    expect(reopened.status).toBe(200);
    expect(reopened.body.title).toBe(body.title);
    expect(reopened.body.stations).toEqual(body.stations);
    expect(reopened.body.apparatus).toEqual(body.apparatus);
    expect(reopened.body.connections).toEqual(body.connections);
    expect(reopened.body.containerStates).toEqual(body.containerStates);
    expect(reopened.body.simulationConfig).toEqual(body.simulationConfig);
    expect(reopened.body.revision).toBe(1);
  });

  it('requires If-Match on PATCH and rejects a stale revision with 409', async () => {
    const created = await authed(app.post('/api/v1/lab/scenes')).send(fullSceneBody(`Patch test ${randomUUID()}`));

    const withoutIfMatch = await authed(app.patch(`/api/v1/lab/scenes/${created.body.id}`)).send({ title: 'Renamed' });
    expect(withoutIfMatch.status).toBe(428);

    const staleMatch = await authed(app.patch(`/api/v1/lab/scenes/${created.body.id}`)).set('If-Match', 'W/"rev-999"').send({ title: 'Renamed' });
    expect(staleMatch.status).toBe(409);
    expect(staleMatch.body.code).toBe('revision_conflict');

    const goodMatch = await authed(app.patch(`/api/v1/lab/scenes/${created.body.id}`)).set('If-Match', 'W/"rev-1"').send({ title: 'Renamed' });
    expect(goodMatch.status).toBe(200);
    expect(goodMatch.body.title).toBe('Renamed');
    expect(goodMatch.body.revision).toBe(2);
  });

  it('two concurrently edited revisions do not silently overwrite one another', async () => {
    const created = await authed(app.post('/api/v1/lab/scenes')).send(fullSceneBody(`Concurrency test ${randomUUID()}`));
    const first = await authed(app.patch(`/api/v1/lab/scenes/${created.body.id}`)).set('If-Match', 'W/"rev-1"').send({ title: 'First editor' });
    expect(first.status).toBe(200);
    // A second client that still thinks the scene is at revision 1 (it loaded before the first edit) must fail, not overwrite.
    const second = await authed(app.patch(`/api/v1/lab/scenes/${created.body.id}`)).set('If-Match', 'W/"rev-1"').send({ title: 'Second editor' });
    expect(second.status).toBe(409);
    const final = await authed(app.get(`/api/v1/lab/scenes/${created.body.id}`));
    expect(final.body.title).toBe('First editor');
  });

  it('duplicates a scene with new ids and without cross-linking or mutating the original', async () => {
    const body = fullSceneBody(`Duplicate source ${randomUUID()}`);
    const created = await authed(app.post('/api/v1/lab/scenes')).send(body);

    const duplicate = await authed(app.post(`/api/v1/lab/scenes/${created.body.id}/duplicate`)).send({});
    expect(duplicate.status).toBe(201);
    expect(duplicate.body.id).not.toBe(created.body.id);
    expect(duplicate.body.stations[0].id).not.toBe(body.stations[0].id);
    expect(duplicate.body.apparatus.map((a: { id: string }) => a.id).sort()).not.toEqual(body.apparatus.map((a: { id: string }) => a.id).sort());
    // Same shape (same number of apparatus/connections/species), independently referencing the new ids.
    expect(duplicate.body.apparatus).toHaveLength(body.apparatus.length);
    expect(duplicate.body.connections).toHaveLength(body.connections.length);
    expect(Object.keys(duplicate.body.containerStates)).toHaveLength(Object.keys(body.containerStates).length);

    // Mutating the duplicate must not affect the original.
    await authed(app.patch(`/api/v1/lab/scenes/${duplicate.body.id}`)).set('If-Match', 'W/"rev-1"').send({ apparatus: [], connections: [], containerStates: {} });
    const originalAfter = await authed(app.get(`/api/v1/lab/scenes/${created.body.id}`));
    expect(originalAfter.body.apparatus).toHaveLength(body.apparatus.length);
  });

  it('lists scenes with pagination', async () => {
    const response = await authed(app.get('/api/v1/lab/scenes')).query({ limit: 2, offset: 0 });
    expect(response.status).toBe(200);
    expect(response.body.items.length).toBeLessThanOrEqual(2);
    expect(typeof response.body.total).toBe('number');
  });

  it('404s for an unknown scene id', async () => {
    const response = await authed(app.get(`/api/v1/lab/scenes/${randomUUID()}`));
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('not_found');
  });

  it('rejects a write from a key that only has the lab:read scope', async () => {
    process.env.MATTERLAB_API_KEYS = 'matterlab-dev-key:lab:read,lab:write;matterlab-readonly-key:lab:read';
    const readonlyCtx = await buildTestContext();
    try {
      const readonlyApp = testApp(readonlyCtx);
      const response = await readonlyApp.post('/api/v1/lab/scenes').set('X-MatterLab-Api-Key', 'matterlab-readonly-key').send(fullSceneBody('scoped'));
      expect(response.status).toBe(403);
      expect(response.body.code).toBe('forbidden');
    } finally {
      await closeContext(readonlyCtx);
      delete process.env.MATTERLAB_API_KEYS;
    }
  });
});
