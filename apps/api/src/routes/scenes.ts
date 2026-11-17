import { Router } from 'express';
import { runCreateRequestSchema, sceneCreateRequestSchema, scenePatchRequestSchema, sceneDuplicateRequestSchema } from '@matterlab/contracts-lab';
import type { AppContext } from '../context.js';
import { ApiError, notFound, parseOrThrow } from '../errors.js';
import { createScene, deleteScene, duplicateScene, getScene, listScenes, patchScene } from '../scenes/repository.js';
import { createRun, listRuns } from '../runs/repository.js';
import { executeRun } from '../runs/executor.js';
import { idempotencyKeyOf, withIdempotency } from '../idempotency.js';
import { requireScope } from '../auth.js';
import { clampInt, etagFor, parseRevisionEtag, pathParam } from '../util.js';

export function scenesRouter(ctx: AppContext): Router {
  const router = Router();

  router.get('/', requireScope('lab:read'), async (req, res) => {
    const limit = clampInt(req.query.limit, 50, 1, 500);
    const offset = clampInt(req.query.offset, 0, 0, 10_000_000);
    const options = req.query.owner === 'me' ? { ownerId: req.auth!.ownerId, limit, offset } : { limit, offset };
    const { items, total } = await listScenes(ctx.db, options);
    res.json({ items, total, limit, offset });
  });

  router.post('/', requireScope('lab:write'), async (req, res) => {
    const request = parseOrThrow(sceneCreateRequestSchema, req.body);
    const result = await withIdempotency(ctx.db, 'lab_scene_create', idempotencyKeyOf(req), req.body, async () => {
      const record = await createScene(ctx.db, request, req.auth!.ownerId, ctx.userSourceId);
      return { status: 201, body: record };
    });
    res
      .status(result.status)
      .set('ETag', etagFor(result.body.revision))
      .set('Location', `/api/v1/lab/scenes/${result.body.id}`)
      .json(result.body);
  });

  router.get('/:id', requireScope('lab:read'), async (req, res) => {
    const id = pathParam(req.params.id);
    const record = await getScene(ctx.db, id);
    if (!record) throw notFound('scene', id);
    res.set('ETag', etagFor(record.revision)).json(record);
  });

  router.patch('/:id', requireScope('lab:write'), async (req, res) => {
    const id = pathParam(req.params.id);
    const ifMatch = req.header('if-match');
    if (!ifMatch) {
      throw new ApiError(428, 'precondition_required', 'PATCH requires an If-Match header carrying the scene\u2019s current ETag (see the Get response).');
    }
    const expectedRevision = parseRevisionEtag(ifMatch);
    if (expectedRevision === null) throw new ApiError(400, 'bad_request', `If-Match "${ifMatch}" is not a recognised scene ETag.`);
    const patch = parseOrThrow(scenePatchRequestSchema, req.body);
    const { record } = await patchScene(ctx.db, id, patch, expectedRevision);
    res.set('ETag', etagFor(record.revision)).json(record);
  });

  router.post('/:id/duplicate', requireScope('lab:write'), async (req, res) => {
    const id = pathParam(req.params.id);
    const request = parseOrThrow(sceneDuplicateRequestSchema, req.body ?? {});
    const result = await withIdempotency(ctx.db, 'lab_scene_duplicate', idempotencyKeyOf(req), { id, body: req.body ?? {} }, async () => {
      const record = await duplicateScene(ctx.db, id, request.title, req.auth!.ownerId, ctx.userSourceId);
      return { status: 201, body: record };
    });
    res
      .status(result.status)
      .set('ETag', etagFor(result.body.revision))
      .set('Location', `/api/v1/lab/scenes/${result.body.id}`)
      .json(result.body);
  });

  router.delete('/:id', requireScope('lab:write'), async (req, res) => {
    const id = pathParam(req.params.id);
    const deleted = await deleteScene(ctx.db, id);
    if (!deleted) throw notFound('scene', id);
    res.status(204).end();
  });

  router.get('/:id/runs', requireScope('lab:read'), async (req, res) => {
    const id = pathParam(req.params.id);
    const limit = clampInt(req.query.limit, 50, 1, 500);
    const offset = clampInt(req.query.offset, 0, 0, 10_000_000);
    const { items, total } = await listRuns(ctx.db, id, limit, offset);
    res.json({ items, total, limit, offset });
  });

  router.post('/:id/runs', requireScope('lab:write'), async (req, res) => {
    const id = pathParam(req.params.id);
    const request = parseOrThrow(runCreateRequestSchema, req.body);
    const result = await withIdempotency(ctx.db, 'lab_run_create', idempotencyKeyOf(req), { sceneId: id, body: req.body }, async () => {
      const created = await createRun(ctx.db, id, request, req.auth!.ownerId);
      return { status: 202, body: created.record };
    });
    if (!result.replayed) {
      // Fire and forget: the HTTP response below reports QUEUED immediately; GET /runs/{id} (or the
      // SSE events endpoint) reports progress from here on. A rejection is still durably recorded:
      // executeRun never throws past its own try/catch, it always finalises the run row.
      void executeRun(ctx.db, result.body.runId, { startDelayMs: ctx.config.runStartDelayMs });
    }
    res.status(result.status).set('Location', `/api/v1/lab/runs/${result.body.runId}`).json(result.body);
  });

  return router;
}
