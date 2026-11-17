import { Router } from 'express';
import { templateCreateRequestSchema } from '@matterlab/contracts-lab';
import type { AppContext } from '../context.js';
import { notFound, parseOrThrow } from '../errors.js';
import { createTemplate, deleteTemplate, getTemplate, listTemplates } from '../templates/repository.js';
import { idempotencyKeyOf, withIdempotency } from '../idempotency.js';
import { requireScope } from '../auth.js';
import { clampInt, pathParam } from '../util.js';

export function templatesRouter(ctx: AppContext): Router {
  const router = Router();

  router.get('/', requireScope('lab:read'), async (req, res) => {
    const limit = clampInt(req.query.limit, 50, 1, 500);
    const offset = clampInt(req.query.offset, 0, 0, 10_000_000);
    const { items, total } = await listTemplates(ctx.db, limit, offset);
    res.json({ items, total, limit, offset });
  });

  router.post('/', requireScope('lab:write'), async (req, res) => {
    const request = parseOrThrow(templateCreateRequestSchema, req.body);
    const result = await withIdempotency(ctx.db, 'lab_template_create', idempotencyKeyOf(req), req.body, async () => {
      const record = await createTemplate(ctx.db, request, req.auth!.ownerId, ctx.userSourceId);
      return { status: 201, body: record };
    });
    res.status(result.status).set('Location', `/api/v1/lab/templates/${result.body.id}`).json(result.body);
  });

  router.get('/:id', requireScope('lab:read'), async (req, res) => {
    const id = pathParam(req.params.id);
    const template = await getTemplate(ctx.db, id);
    if (!template) throw notFound('template', id);
    res.json(template);
  });

  router.delete('/:id', requireScope('lab:write'), async (req, res) => {
    const id = pathParam(req.params.id);
    const deleted = await deleteTemplate(ctx.db, id);
    if (!deleted) throw notFound('template', id);
    res.status(204).end();
  });

  return router;
}

