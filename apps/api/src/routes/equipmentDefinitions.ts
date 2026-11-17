import { Router } from 'express';
import type { AppContext } from '../context.js';
import { notFound } from '../errors.js';
import { getEquipmentDefinition, listCurrentEquipmentDefinitions } from '../equipment/repository.js';
import { requireScope } from '../auth.js';
import { pathParam } from '../util.js';
import { APPARATUS_KINDS, CAPABILITIES, type ApparatusKind, type Capability } from '@matterlab/contracts-lab';

function isApparatusKind(value: unknown): value is ApparatusKind {
  return typeof value === 'string' && (APPARATUS_KINDS as readonly string[]).includes(value);
}

function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && (CAPABILITIES as readonly string[]).includes(value);
}

export function equipmentDefinitionsRouter(ctx: AppContext): Router {
  const router = Router();

  router.get('/', requireScope('lab:read'), async (req, res) => {
    const kind = isApparatusKind(req.query.kind) ? req.query.kind : undefined;
    const capability = isCapability(req.query.capability) ? req.query.capability : undefined;
    const items = await listCurrentEquipmentDefinitions(ctx.db, { kind, capability });
    res.json({ items, total: items.length, limit: items.length, offset: 0 });
  });

  router.get('/:key', requireScope('lab:read'), async (req, res) => {
    const key = pathParam(req.params.key);
    const version = typeof req.query.version === 'string' ? Number.parseInt(req.query.version, 10) : undefined;
    const definition = await getEquipmentDefinition(ctx.db, key, version);
    if (!definition) throw notFound('equipment definition', key);
    res.json(definition);
  });

  return router;
}
