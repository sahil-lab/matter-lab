import { Router } from 'express';
import { REAGENT_ROLES, type ReagentDefinition } from '@matterlab/contracts-lab';
import type { AppContext } from '../context.js';
import { notFound } from '../errors.js';
import { getReagent, listReagents } from '../equipment/reagents.js';
import { requireScope } from '../auth.js';
import { pathParam } from '../util.js';

function isReagentRole(value: unknown): value is ReagentDefinition['roles'][number] {
  return typeof value === 'string' && (REAGENT_ROLES as readonly string[]).includes(value);
}

export function reagentsRouter(ctx: AppContext): Router {
  const router = Router();

  router.get('/', requireScope('lab:read'), async (req, res) => {
    const role = isReagentRole(req.query.role) ? req.query.role : undefined;
    const items = await listReagents(ctx.db, role);
    res.json({ items, total: items.length, limit: items.length, offset: 0 });
  });

  router.get('/:speciesId', requireScope('lab:read'), async (req, res) => {
    const speciesId = pathParam(req.params.speciesId);
    const reagent = await getReagent(ctx.db, speciesId);
    if (!reagent) throw notFound('reagent', speciesId);
    res.json(reagent);
  });

  return router;
}
