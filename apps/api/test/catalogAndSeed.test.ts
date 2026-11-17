import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.js';
import { closeContext } from '../src/context.js';
import { seedAll } from '../src/seed/run.js';
import { authed, buildTestContext, testApp } from './helpers.js';

describe('equipment/reagent catalogs, templates and seed data', () => {
  let ctx: AppContext;
  let app: ReturnType<typeof testApp>;

  beforeAll(async () => {
    ctx = await buildTestContext();
    app = testApp(ctx);
    await seedAll(ctx.db); // ensure the equipment/reagent catalog exists before the catalog-reading tests run
  });

  afterAll(async () => {
    await closeContext(ctx);
  });

  it('serves the seeded equipment catalog with one current (non-retired) version per key', async () => {
    const response = await authed(app.get('/api/v1/lab/equipment-definitions'));
    expect(response.status).toBe(200);
    const keys = (response.body.items as { key: string }[]).map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length); // no duplicate "current" rows for the same key
    expect(keys).toContain('burette-50ml');
    const burette = (response.body.items as { key: string; evidence: string; capabilities: string[] }[]).find((d) => d.key === 'burette-50ml')!;
    expect(burette.evidence).toBe('UNVERIFIED'); // honestly labelled placeholder, never claimed as measured
    expect(burette.capabilities).toContain('CONTAINER');
  });

  it('filters equipment definitions by kind and capability', async () => {
    const byKind = await authed(app.get('/api/v1/lab/equipment-definitions')).query({ kind: 'BURETTE' });
    expect((byKind.body.items as { kind: string }[]).every((d) => d.kind === 'BURETTE')).toBe(true);
    const byCapability = await authed(app.get('/api/v1/lab/equipment-definitions')).query({ capability: 'PH_SENSOR' });
    expect((byCapability.body.items as { capabilities: string[] }[]).every((d) => d.capabilities.includes('PH_SENSOR'))).toBe(true);
  });

  it('serves the curated reagent catalog linked to the existing compound catalogue', async () => {
    const response = await authed(app.get('/api/v1/lab/reagents'));
    expect(response.status).toBe(200);
    const hcl = (response.body.items as { speciesId: string; scienceCompoundId: string | null }[]).find((r) => r.speciesId === 'HCl(aq)');
    expect(hcl).toBeDefined();
    // Resolved against the real compounds table at seed time (see services/science seed data), not a guess.
    expect(hcl!.scienceCompoundId).not.toBeNull();
  });

  it('creates, reads and lists templates', async () => {
    const name = `Clamp stand assembly ${randomUUID()}`;
    const apparatusId = randomUUID();
    const created = await authed(app.post('/api/v1/lab/templates')).send({
      name,
      apparatus: [
        {
          id: apparatusId,
          kind: 'STAND',
          definitionId: 'stand-standard',
          transform: { positionM: [0, 0, 0], quaternion: [0, 0, 0, 1] },
          revision: 0,
          config: {},
          capabilities: ['MOUNT', 'MOUNTABLE'],
          stationId: randomUUID(),
        },
      ],
      connections: [],
    });
    expect(created.status).toBe(201);
    const fetched = await authed(app.get(`/api/v1/lab/templates/${created.body.id}`));
    expect(fetched.body.name).toBe(name);
    const list = await authed(app.get('/api/v1/lab/templates'));
    expect((list.body.items as { id: string }[]).some((t) => t.id === created.body.id)).toBe(true);
  });

  it('seeds the titration station and blank station scenes idempotently, with no observations/runs created by seeding itself', async () => {
    const first = await seedAll(ctx.db);
    const second = await seedAll(ctx.db);
    // Whichever run actually created them, by the second call both sample scenes must exist and not be duplicated.
    const scenes = await authed(app.get('/api/v1/lab/scenes')).query({ limit: 500 });
    const seeded = (scenes.body.items as { title: string }[]).filter((s) => s.title === 'Titration Station (seed)' || s.title === 'Blank Station (seed)');
    expect(seeded.length).toBe(2);
    expect(first.scenesCreated.length + second.scenesCreated.length).toBeLessThanOrEqual(2);

    const titrationScene = (await authed(app.get('/api/v1/lab/scenes')).query({ limit: 500 })).body.items.find((s: { title: string }) => s.title === 'Titration Station (seed)');
    const fullScene = await authed(app.get(`/api/v1/lab/scenes/${titrationScene.id}`));
    // Seeding itself never submits a run (no fake scientific results shipped with seed data): re-seeding must not
    // change the run count, whatever it already was (another test/manual session may have run this scene for real).
    const before = await authed(app.get(`/api/v1/lab/scenes/${titrationScene.id}/runs`));
    await seedAll(ctx.db);
    const after = await authed(app.get(`/api/v1/lab/scenes/${titrationScene.id}/runs`));
    expect(after.body.total).toBe(before.body.total);
    expect(Object.keys(fullScene.body.containerStates).length).toBeGreaterThan(0);
  });
});
