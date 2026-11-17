/**
 * Provenance registry helpers: reuses the existing `data_sources` table (db/migrations/0001) so
 * every lab row can name where it came from, exactly like the rest of the database.
 */
import type { Database } from './db.js';

export const API_SOURCE_KEY = 'matterlab-api';
export const STUB_EQUIPMENT_SOURCE_KEY = 'matterlab-api-stub-equipment';
export const USER_SOURCE_KEY = 'matterlab-user';

async function upsertSource(
  db: Database,
  args: { key: string; version: string; kind: string; title: string; notes?: string },
): Promise<number> {
  const row = await db.queryOne<{ id: number }>(
    `INSERT INTO data_sources (key, version, kind, title, notes)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (key, version) DO UPDATE SET notes = EXCLUDED.notes
     RETURNING id`,
    [args.key, args.version, args.kind, args.title, args.notes ?? null],
  );
  if (row) return row.id;
  const existing = await db.queryOne<{ id: number }>('SELECT id FROM data_sources WHERE key = $1 AND version = $2', [args.key, args.version]);
  if (!existing) throw new Error(`failed to register data source ${args.key}@${args.version}`);
  return existing.id;
}

/** Source for rows the API itself produced (run lifecycle bookkeeping, computed observations). */
export async function ensureApiSource(db: Database, apiVersion: string): Promise<number> {
  return upsertSource(db, {
    key: API_SOURCE_KEY,
    version: apiVersion,
    kind: 'software',
    title: 'MATTER LAB lab API',
    notes: 'Records produced by the Astra lab backend (apps/api) itself, e.g. run lifecycle bookkeeping.',
  });
}

/**
 * Source for the provisional equipment definitions Agent 09 seeds while Agent 03's authoritative
 * apparatus assets are not yet available in this worktree. Never used for a scientific result.
 */
export async function ensureStubEquipmentSource(db: Database): Promise<number> {
  return upsertSource(db, {
    key: STUB_EQUIPMENT_SOURCE_KEY,
    version: 'unversioned',
    kind: 'software',
    title: 'MATTER LAB Agent 09 provisional equipment catalog',
    notes:
      'Stock apparatus definitions (capacities, sockets, capabilities) seeded by Agent 09 so the lab API has a working ' +
      'equipment-definitions endpoint before Agent 03\'s authoritative apparatus asset definitions are integrated. ' +
      'Dimensions and capacities are standard labware specifications, not measurements of a specific physical item.',
  });
}

/** Source for records created by a user/client through the lab API (scenes, templates). */
export async function ensureUserSource(db: Database): Promise<number> {
  return upsertSource(db, {
    key: USER_SOURCE_KEY,
    version: 'unversioned',
    kind: 'user',
    title: 'MATTER LAB lab user records',
    notes: 'Created by a user through the lab API. Not reference data and not independently verified.',
  });
}
