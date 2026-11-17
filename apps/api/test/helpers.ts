/** Shared test setup: a real AppContext/Express app against a real, already-migrated PostgreSQL. */
import request from 'supertest';
import { createApp } from '../src/app.js';
import { closeContext, createContext, type AppContext } from '../src/context.js';
import { loadConfig } from '../src/config.js';

export const DEV_API_KEY = 'matterlab-dev-key';

export async function buildTestContext(): Promise<AppContext> {
  const config = loadConfig();
  const ctx = await createContext(config);
  const hasLabSchema = await ctx.db.queryOne("SELECT to_regclass('public.lab_scene') AS present");
  if (!(hasLabSchema as { present: string | null } | null)?.present) {
    await closeContext(ctx);
    throw new Error(
      'lab_scene table not found. Point MATTERLAB_DB_HOST/PORT/USER/PASSWORD/NAME at a database with db/migrations 0001-0009 applied before running apps/api tests ' +
        '(e.g. docker compose run --rm science python -m matterlab_science migrate).',
    );
  }
  return ctx;
}

export function testApp(ctx: AppContext) {
  return request(createApp(ctx));
}

export function authed(req: request.Test): request.Test {
  return req.set('Authorization', `Bearer ${DEV_API_KEY}`);
}
