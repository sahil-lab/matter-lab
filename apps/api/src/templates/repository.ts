/** Reusable equipment assembly templates: denormalised JSONB (a template is a copy stamp, not a live link). */
import type { Database } from '../db.js';
import type { TemplateCreateRequest, TemplateRecord } from '@matterlab/contracts-lab';
import { ApiError } from '../errors.js';

interface TemplateRow {
  id: string;
  name: string;
  description: string | null;
  apparatus: TemplateRecord['apparatus'];
  connections: TemplateRecord['connections'];
  revision: number;
  created_at: Date;
  updated_at: Date;
}

function toRecord(row: TemplateRow): TemplateRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    apparatus: row.apparatus,
    connections: row.connections,
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function createTemplate(db: Database, request: TemplateCreateRequest, ownerId: string | null, sourceId: number): Promise<TemplateRecord> {
  try {
    const row = await db.queryOne<TemplateRow>(
      `INSERT INTO lab_template (name, description, apparatus, connections, owner_id, source_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, description, apparatus, connections, revision, created_at, updated_at`,
      [request.name, request.description ?? null, JSON.stringify(request.apparatus), JSON.stringify(request.connections), ownerId, sourceId],
    );
    if (!row) throw new Error('template insert returned no row');
    return toRecord(row);
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new ApiError(409, 'duplicate_name', `A template named "${request.name}" already exists.`);
    }
    throw error;
  }
}

export async function getTemplate(db: Database, id: string): Promise<TemplateRecord | null> {
  const row = await db.queryOne<TemplateRow>(
    'SELECT id, name, description, apparatus, connections, revision, created_at, updated_at FROM lab_template WHERE id = $1',
    [id],
  );
  return row ? toRecord(row) : null;
}

export async function listTemplates(db: Database, limit: number, offset: number): Promise<{ items: TemplateRecord[]; total: number }> {
  const totalRow = await db.queryOne<{ n: string }>('SELECT count(*) AS n FROM lab_template');
  const rows = await db.query<TemplateRow>(
    'SELECT id, name, description, apparatus, connections, revision, created_at, updated_at FROM lab_template ORDER BY name LIMIT $1 OFFSET $2',
    [limit, offset],
  );
  return { items: rows.map(toRecord), total: totalRow ? Number(totalRow.n) : 0 };
}

export async function deleteTemplate(db: Database, id: string): Promise<boolean> {
  const rows = await db.query('DELETE FROM lab_template WHERE id = $1 RETURNING id', [id]);
  return rows.length > 0;
}
