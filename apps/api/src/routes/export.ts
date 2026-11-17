import { Router } from 'express';
import type { AppContext } from '../context.js';
import { ApiError, notFound } from '../errors.js';
import { getScene } from '../scenes/repository.js';
import { exportSceneWorkbook } from '../excel/workbook.js';
import { requireScope } from '../auth.js';
import { pathParam } from '../util.js';

export function exportRouter(ctx: AppContext): Router {
  const router = Router();

  router.get('/:id/export', requireScope('lab:read'), async (req, res) => {
    const id = pathParam(req.params.id);
    const format = typeof req.query.format === 'string' ? req.query.format : 'json';
    if (format !== 'json' && format !== 'xlsx') {
      throw new ApiError(400, 'bad_request', 'format must be "json" or "xlsx".');
    }
    if (format === 'json') {
      const record = await getScene(ctx.db, id);
      if (!record) throw notFound('scene', id);
      res.set('X-MatterLab-Schema-Version', '1').json(record);
      return;
    }
    const result = await exportSceneWorkbook(ctx.db, id);
    if (!result) throw notFound('scene', id);
    res
      .set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .set('Content-Disposition', `attachment; filename="scene-${id}.xlsx"`)
      .set('X-MatterLab-Exported-At', result.summary.exportedAt)
      .send(result.buffer);
  });

  return router;
}

