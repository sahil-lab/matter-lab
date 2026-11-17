import express from 'express';
import cors from 'cors';
import type { AppContext } from './context.js';
import { authMiddleware } from './auth.js';
import { notFoundHandler, problemErrorHandler } from './errors.js';
import { scenesRouter } from './routes/scenes.js';
import { equipmentDefinitionsRouter } from './routes/equipmentDefinitions.js';
import { reagentsRouter } from './routes/catalog.js';
import { runsRouter } from './routes/runs.js';
import { templatesRouter } from './routes/templates.js';
import { exportRouter } from './routes/export.js';

export function createApp(ctx: AppContext): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(
    cors({
      origin: ctx.config.corsOrigins.length > 0 ? [...ctx.config.corsOrigins] : false,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      exposedHeaders: ['ETag', 'Location', 'Content-Disposition', 'X-MatterLab-Schema-Version', 'X-MatterLab-Exported-At', 'Retry-After'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: ctx.config.maxJsonBodyBytes }));

  app.get('/health', async (_req, res) => {
    try {
      await ctx.db.ping();
      res.json({ status: 'ok', service: 'matterlab-lab-api' });
    } catch {
      res.status(503).json({ status: 'unavailable', service: 'matterlab-lab-api' });
    }
  });

  const lab = express.Router();
  lab.use(authMiddleware(ctx.config));
  lab.use('/equipment-definitions', equipmentDefinitionsRouter(ctx));
  lab.use('/reagents', reagentsRouter(ctx));
  lab.use('/scenes', scenesRouter(ctx));
  lab.use('/scenes', exportRouter(ctx));
  lab.use('/runs', runsRouter(ctx));
  lab.use('/templates', templatesRouter(ctx));
  app.use('/api/v1/lab', lab);

  app.use(notFoundHandler);
  app.use(problemErrorHandler);
  return app;
}
