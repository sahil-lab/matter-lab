import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.js';
import { closeContext } from '../src/context.js';
import { authed, buildTestContext, testApp } from './helpers.js';

function titrationSceneBody(title: string, analyteSpeciesId = 'HCl(aq)', titrantSpeciesId = 'NaOH(aq)') {
  const stationId = randomUUID();
  const flaskId = randomUUID();
  const buretteId = randomUUID();
  return {
    title,
    stationId,
    flaskId,
    buretteId,
    body: {
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
      connections: [],
      containerStates: {
        [flaskId]: { volumeL: 0.025, species: [{ speciesId: analyteSpeciesId, moles: 0.1 * 0.025 }], temperatureK: 298.15, mixing: 'WELL_MIXED', modelId: 'ideal-well-mixed-v1' },
        [buretteId]: { volumeL: 0.05, species: [{ speciesId: titrantSpeciesId, moles: 0.1 * 0.05 }], temperatureK: 298.15, mixing: 'WELL_MIXED', modelId: 'ideal-well-mixed-v1' },
      },
      simulationConfig: { methodId: 'fixed-tick-v1', timeStepS: 0.1 },
    },
  };
}

function transferActions(flaskId: string, buretteId: string, stepsML: number[]) {
  let t = 0;
  return stepsML.map((mL) => {
    t += 1;
    return { actionId: randomUUID(), atSimulationS: t, targetInstanceId: flaskId, type: 'TRANSFER' as const, payload: { sourceInstanceId: buretteId, deliveredVolumeL: mL / 1000 } };
  });
}

async function waitForTerminal(app: ReturnType<typeof testApp>, runId: string, timeoutMs = 10_000): Promise<{ status: number; body: Record<string, unknown> & { status: string } }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const response = await authed(app.get(`/api/v1/lab/runs/${runId}`));
    const status = (response.body as { status: string }).status;
    if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNSUPPORTED'].includes(status)) return response as { status: number; body: Record<string, unknown> & { status: string } };
    if (Date.now() > deadline) throw new Error(`run ${runId} did not reach a terminal status within ${timeoutMs}ms (last status ${status})`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('lab runs API (strong-acid/strong-base titration)', () => {
  let ctx: AppContext;
  let app: ReturnType<typeof testApp>;

  beforeAll(async () => {
    ctx = await buildTestContext();
    app = testApp(ctx);
  });

  afterAll(async () => {
    await closeContext(ctx);
  });

  it('computes a real, non-fabricated pH curve: pH 1 before titrant, ~7 at equivalence, strongly basic past it', async () => {
    const scene = titrationSceneBody(`Titration run ${randomUUID()}`);
    const created = await authed(app.post('/api/v1/lab/scenes')).send(scene.body);
    expect(created.status).toBe(201);

    // 5 mL steps to 25 mL (equivalence) then on to 50 mL (double equivalence).
    const steps = [5, 5, 5, 5, 5, 5, 5, 5, 5, 5];
    const actions = transferActions(scene.flaskId, scene.buretteId, steps);
    const runResponse = await authed(app.post(`/api/v1/lab/scenes/${created.body.id}/runs`)).send({
      methodId: 'titration.strong_acid_strong_base.charge_balance.v1',
      actions,
    });
    expect(runResponse.status).toBe(202);
    expect(runResponse.body.status).toBe('QUEUED');

    const finished = await waitForTerminal(app, runResponse.body.runId);
    expect(finished.body.status).toBe('SUCCEEDED');

    const observations = await authed(app.get(`/api/v1/lab/runs/${runResponse.body.runId}/observations`));
    const phs = (observations.body.items as { type: string; timeS: number; quantity: { value: number } }[]).filter((o) => o.type === 'PH').sort((a, b) => a.timeS - b.timeS);
    expect(phs.length).toBe(steps.length + 1); // +1 for the t=0 initial reading

    // Every observation must say how it was obtained - never a bare number with no evidence/method.
    for (const observation of observations.body.items as { evidence: string; methodId: string }[]) {
      expect(observation.evidence).toBe('MODEL_CALCULATED');
      expect(observation.methodId).toBe('titration.strong_acid_strong_base.charge_balance.v1');
    }

    expect(phs[0].quantity.value).toBeCloseTo(1.0, 1); // 0.100 mol/L strong acid, before any titrant
    const atEquivalence = phs.find((p) => Math.abs(p.timeS - 5) < 1e-9); // 5th step = 25 mL delivered
    expect(atEquivalence?.quantity.value).toBeCloseTo(7.0, 1);
    const pastEquivalence = phs[phs.length - 1]; // 50 mL delivered, double equivalence -> strongly basic
    expect(pastEquivalence.quantity.value).toBeGreaterThan(12);
  });

  it('reports UNSUPPORTED durably (no fake results) when the analyte is not a recognised strong acid/base', async () => {
    const scene = titrationSceneBody(`Unsupported run ${randomUUID()}`, 'CH3COOH(aq)' /* weak acid: not modeled */);
    const created = await authed(app.post('/api/v1/lab/scenes')).send(scene.body);
    const runResponse = await authed(app.post(`/api/v1/lab/scenes/${created.body.id}/runs`)).send({
      methodId: 'titration.strong_acid_strong_base.charge_balance.v1',
      actions: transferActions(scene.flaskId, scene.buretteId, [5]),
    });
    const finished = await waitForTerminal(app, runResponse.body.runId);
    expect(finished.body.status).toBe('UNSUPPORTED');
    expect(finished.body.observations).toEqual([]);
    expect(typeof finished.body.solverDiagnostics === 'undefined' || finished.body.solverDiagnostics !== null).toBe(true);
  });

  it('reports UNSUPPORTED for an unregistered method id instead of silently succeeding', async () => {
    const scene = titrationSceneBody(`Unknown method ${randomUUID()}`);
    const created = await authed(app.post('/api/v1/lab/scenes')).send(scene.body);
    const runResponse = await authed(app.post(`/api/v1/lab/scenes/${created.body.id}/runs`)).send({ methodId: 'not.a.real.method', actions: [] });
    const finished = await waitForTerminal(app, runResponse.body.runId);
    expect(finished.body.status).toBe('UNSUPPORTED');
  });

  it('fails without corrupting state when a transfer exceeds the titrant volume available', async () => {
    const scene = titrationSceneBody(`Overdraw run ${randomUUID()}`);
    const created = await authed(app.post('/api/v1/lab/scenes')).send(scene.body);
    const runResponse = await authed(app.post(`/api/v1/lab/scenes/${created.body.id}/runs`)).send({
      methodId: 'titration.strong_acid_strong_base.charge_balance.v1',
      actions: transferActions(scene.flaskId, scene.buretteId, [999]), // burette only has 50 mL
    });
    const finished = await waitForTerminal(app, runResponse.body.runId);
    expect(finished.body.status).toBe('FAILED');
    expect(finished.body.failureCode).toBe('titrant_volume_exceeded');
    expect(finished.body.failureMessage).toContain('exceeds');
  });

  it('idempotency key: retrying the same run-creation request returns the original run, not a second one', async () => {
    const scene = titrationSceneBody(`Idempotent run ${randomUUID()}`);
    const created = await authed(app.post('/api/v1/lab/scenes')).send(scene.body);
    const idempotencyKey = randomUUID();
    const body = { methodId: 'titration.strong_acid_strong_base.charge_balance.v1', actions: transferActions(scene.flaskId, scene.buretteId, [5]) };
    const first = await authed(app.post(`/api/v1/lab/scenes/${created.body.id}/runs`)).set('Idempotency-Key', idempotencyKey).send(body);
    const second = await authed(app.post(`/api/v1/lab/scenes/${created.body.id}/runs`)).set('Idempotency-Key', idempotencyKey).send(body);
    expect(second.body.runId).toBe(first.body.runId);
    const list = await authed(app.get(`/api/v1/lab/scenes/${created.body.id}/runs`));
    expect((list.body.items as unknown[]).length).toBe(1);
  });

  it('can cancel a queued run before it starts computing', async () => {
    process.env.MATTERLAB_API_RUN_START_DELAY_MS = '2000';
    const slowCtx = await buildTestContext();
    try {
      const slowApp = testApp(slowCtx);
      const scene = titrationSceneBody(`Cancel run ${randomUUID()}`);
      const created = await authed(slowApp.post('/api/v1/lab/scenes')).send(scene.body);
      const runResponse = await authed(slowApp.post(`/api/v1/lab/scenes/${created.body.id}/runs`)).send({
        methodId: 'titration.strong_acid_strong_base.charge_balance.v1',
        actions: transferActions(scene.flaskId, scene.buretteId, [5]),
      });
      const cancelResponse = await authed(slowApp.post(`/api/v1/lab/runs/${runResponse.body.runId}/cancel`));
      expect(cancelResponse.status).toBe(200);
      const finished = await waitForTerminal(slowApp, runResponse.body.runId, 5000);
      expect(finished.body.status).toBe('CANCELLED');
      expect(finished.body.observations).toEqual([]);
    } finally {
      await closeContext(slowCtx);
      delete process.env.MATTERLAB_API_RUN_START_DELAY_MS;
    }
  });
});
