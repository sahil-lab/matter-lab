/** Curated reagent catalog, cross-linked to the existing compound catalogue by science_compound_id. */
import type { Database } from '../db.js';
import type { ReagentDefinition } from '@matterlab/contracts-lab';

interface ReagentRow {
  species_id: string;
  name: string;
  formula: string;
  roles: ReagentDefinition['roles'];
  science_compound_id: string | null;
  recommended_concentration: ReagentDefinition['recommendedConcentrationMolPerL'] | null;
  hazard_notes: string | null;
  source_key: string;
}

function toReagent(row: ReagentRow): ReagentDefinition {
  return {
    speciesId: row.species_id,
    name: row.name,
    formula: row.formula,
    roles: row.roles,
    scienceCompoundId: row.science_compound_id,
    recommendedConcentrationMolPerL: row.recommended_concentration ?? undefined,
    hazardNotes: row.hazard_notes ?? undefined,
    sourceKey: row.source_key,
  };
}

export async function listReagents(db: Database, role?: ReagentDefinition['roles'][number]): Promise<ReagentDefinition[]> {
  const rows = await db.query<ReagentRow>(
    `SELECT r.species_id, r.name, r.formula, r.roles, r.science_compound_id, r.recommended_concentration, r.hazard_notes, ds.key AS source_key
     FROM lab_reagent r JOIN data_sources ds ON ds.id = r.source_id
     ${role ? 'WHERE $1 = ANY(r.roles)' : ''}
     ORDER BY r.name`,
    role ? [role] : [],
  );
  return rows.map(toReagent);
}

export async function getReagent(db: Database, speciesId: string): Promise<ReagentDefinition | null> {
  const row = await db.queryOne<ReagentRow>(
    `SELECT r.species_id, r.name, r.formula, r.roles, r.science_compound_id, r.recommended_concentration, r.hazard_notes, ds.key AS source_key
     FROM lab_reagent r JOIN data_sources ds ON ds.id = r.source_id WHERE r.species_id = $1`,
    [speciesId],
  );
  return row ? toReagent(row) : null;
}

export async function upsertReagent(db: Database, reagent: ReagentDefinition, sourceId: number): Promise<void> {
  await db.query(
    `INSERT INTO lab_reagent (species_id, name, formula, roles, science_compound_id, recommended_concentration, hazard_notes, source_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (species_id) DO UPDATE SET
       name = EXCLUDED.name, formula = EXCLUDED.formula, roles = EXCLUDED.roles, science_compound_id = EXCLUDED.science_compound_id,
       recommended_concentration = EXCLUDED.recommended_concentration, hazard_notes = EXCLUDED.hazard_notes`,
    [
      reagent.speciesId,
      reagent.name,
      reagent.formula,
      reagent.roles,
      reagent.scienceCompoundId,
      reagent.recommendedConcentrationMolPerL ? JSON.stringify(reagent.recommendedConcentrationMolPerL) : null,
      reagent.hazardNotes ?? null,
      sourceId,
    ],
  );
}

/** Resolves a compound's id in the existing science catalogue by an exact case-insensitive name/synonym match. */
export async function findScienceCompoundIdByName(db: Database, name: string): Promise<string | null> {
  const row = await db.queryOne<{ compound_id: string }>('SELECT compound_id FROM compound_synonyms WHERE name_normalized = lower($1) LIMIT 1', [name]);
  return row ? row.compound_id : null;
}
