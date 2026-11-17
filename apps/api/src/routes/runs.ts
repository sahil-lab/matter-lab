import { Router } from 'express';
import { TERMINAL_RUN_STATUSES } from '@matterlab/contracts-lab';
import type { AppContext } from '../context.js';
import { notFound } from '../errors.js';
import { getRun, listRunEventsAfter, requestCancel } from '../runs/repository.js';
import { requireScope } from '../auth.js';
import { pathParam } from '../util.js';

const SSE_POLL_INTERVAL_MS = 250;
/** Safety bound so a forgotten client doesn't hold a connection (and a DB polling timer) forever. */
const SSE_MAX_DURATION_MS = 5 * 60 * 1000;

export function runsRouter(ctx: AppContext): Router {
  const router = Router();

  router.get('/:runId', requireScope('lab:read'), async (req, res) => {
    const runId = pathParam(req.params.runId);
    const run = await getRun(ctx.db, runId);
    if (!run) throw notFound('run', runId);
    res.json(run);
  });

  router.get('/:runId/observations', requireScope('lab:read'), async (req, res) => {
    const runId = pathParam(req.params.runId);
    const run = await getRun(ctx.db, runId);
    if (!run) throw notFound('run', runId);
    res.json({ items: run.observations, total: run.observations.length, limit: run.observations.length, offset: 0 });
  });

  router.post('/:runId/cancel', requireScope('lab:write'), async (req, res) => {
    const runId = pathParam(req.params.runId);
    const run = await requestCancel(ctx.db, runId);
    if (!run) throw notFound('run', runId);
    res.json(run);
  });

  router.get('/:runId/events', requireScope('lab:read'), async (req, res) => {
    const runId = pathParam(req.params.runId);
    const initial = await getRun(ctx.db, runId);
    if (!initial) throw notFound('run', runId);

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    let lastSequence = Number.parseInt(req.header('last-event-id') ?? String(req.query.after ?? '-1'), 10);
    if (!Number.isFinite(lastSequence)) lastSequence = -1;
    let stopped = false;
    const deadline = Date.now() + SSE_MAX_DURATION_MS;

    const send = (event: { sequence: number; status: string; message: string; observation?: unknown; at: string }): void => {
      res.write(`id: ${event.sequence}\n`);
      res.write(`event: run-status\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    req.on('close', () => {
      stopped = true;
    });

    while (!stopped) {
      const events = await listRunEventsAfter(ctx.db, runId, lastSequence);
      for (const event of events) {
        send(event);
        lastSequence = event.sequence;
        if ((TERMINAL_RUN_STATUSES as readonly string[]).includes(event.status)) {
          stopped = true;
        }
      }
      if (stopped || Date.now() > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, SSE_POLL_INTERVAL_MS));
    }
    res.end();
  });

  return router;
}
