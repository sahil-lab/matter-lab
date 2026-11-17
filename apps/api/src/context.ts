import { Database } from './db.js';
import type { Config } from './config.js';
import { ensureApiSource, ensureStubEquipmentSource, ensureUserSource } from './sources.js';

export const API_VERSION = '0.1.0';

export interface AppContext {
  readonly config: Config;
  readonly db: Database;
  readonly apiSourceId: number;
  readonly stubEquipmentSourceId: number;
  readonly userSourceId: number;
}

export async function createContext(config: Config): Promise<AppContext> {
  const db = new Database({
    connectionString: config.databaseUrl,
    maxSize: config.dbPoolMaxSize,
    idleTimeoutMs: config.dbPoolIdleTimeoutMs,
    connectTimeoutMs: config.dbConnectTimeoutMs,
  });
  await db.ping();
  const apiSourceId = await ensureApiSource(db, API_VERSION);
  const stubEquipmentSourceId = await ensureStubEquipmentSource(db);
  const userSourceId = await ensureUserSource(db);
  return { config, db, apiSourceId, stubEquipmentSourceId, userSourceId };
}

export async function closeContext(ctx: AppContext): Promise<void> {
  await ctx.db.close();
}
