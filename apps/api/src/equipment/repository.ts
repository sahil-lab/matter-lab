/** Equipment (apparatus) definition catalog: versioned rows, "current" = highest version per key. */
import type { Database } from '../db.js';
import type { EquipmentDefinition } from '@matterlab/contracts-lab';

interface DefinitionRow {
  key: string;
  version: number;
  kind: EquipmentDefinition['kind'];
  name: string;
  description: string | null;
  capabilities: EquipmentDefinition['capabilities'];
  sockets: EquipmentDefinition['sockets'];
  capacity: EquipmentDefinition['capacity'] | null;
  dimensions_m: EquipmentDefinition['dimensionsM'] | null;
  control_actions: string[];
  default_config: Record<string, unknown>;
  evidence: EquipmentDefinition['evidence'];
  notes: string | null;
}

function toDefinition(row: DefinitionRow): EquipmentDefinition {
  return {
    key: row.key,
    version: row.version,
    kind: row.kind,
    name: row.name,
    description: row.description ?? undefined,
    capabilities: row.capabilities,
    sockets: row.sockets,
    capacity: row.capacity ?? undefined,
    dimensionsM: row.dimensions_m ?? undefined,
    controlActions: row.control_actions,
    defaultConfig: row.default_config,
    evidence: row.evidence,
    notes: row.notes ?? undefined,
  };
}

export interface ListEquipmentOptions {
  kind?: EquipmentDefinition['kind'];
  capability?: EquipmentDefinition['capabilities'][number];
}

/** Every key's current (highest, non-retired) version, optionally filtered. */
export async function listCurrentEquipmentDefinitions(db: Database, options: ListEquipmentOptions = {}): Promise<EquipmentDefinition[]> {
  const clauses: string[] = ['is_retired = false'];
  const params: unknown[] = [];
  if (options.kind) {
    params.push(options.kind);
    clauses.push(`kind = $${params.length}`);
  }
  if (options.capability) {
    params.push(options.capability);
    clauses.push(`$${params.length} = ANY(capabilities)`);
  }
  const rows = await db.query<DefinitionRow>(
    `SELECT DISTINCT ON (key) key, version, kind, name, description, capabilities, sockets, capacity, dimensions_m,
            control_actions, default_config, evidence, notes
     FROM apparatus_definition_version
     WHERE ${clauses.join(' AND ')}
     ORDER BY key, version DESC`,
    params,
  );
  return rows.map(toDefinition);
}

export async function getEquipmentDefinition(db: Database, key: string, version?: number): Promise<EquipmentDefinition | null> {
  const row = await db.queryOne<DefinitionRow>(
    version === undefined
      ? `SELECT key, version, kind, name, description, capabilities, sockets, capacity, dimensions_m, control_actions, default_config, evidence, notes
         FROM apparatus_definition_version WHERE key = $1 AND is_retired = false ORDER BY version DESC LIMIT 1`
      : `SELECT key, version, kind, name, description, capabilities, sockets, capacity, dimensions_m, control_actions, default_config, evidence, notes
         FROM apparatus_definition_version WHERE key = $1 AND version = $2`,
    version === undefined ? [key] : [key, version],
  );
  return row ? toDefinition(row) : null;
}

export async function upsertEquipmentDefinition(db: Database, definition: EquipmentDefinition, sourceId: number): Promise<void> {
  await db.query(
    `INSERT INTO apparatus_definition_version
       (key, version, kind, name, description, capabilities, sockets, capacity, dimensions_m, control_actions, default_config, evidence, notes, source_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (key, version) DO NOTHING`,
    [
      definition.key,
      definition.version,
      definition.kind,
      definition.name,
      definition.description ?? null,
      definition.capabilities,
      JSON.stringify(definition.sockets),
      definition.capacity ? JSON.stringify(definition.capacity) : null,
      definition.dimensionsM ? JSON.stringify(definition.dimensionsM) : null,
      definition.controlActions,
      JSON.stringify(definition.defaultConfig),
      definition.evidence,
      definition.notes ?? null,
      sourceId,
    ],
  );
}
