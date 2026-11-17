import type { Database } from '../db.js';
import { ensureStubEquipmentSource, ensureUserSource } from '../sources.js';
import { upsertEquipmentDefinition } from '../equipment/repository.js';
import { upsertReagent, findScienceCompoundIdByName } from '../equipment/reagents.js';
import { STUB_EQUIPMENT_DEFINITIONS } from './equipmentDefinitions.js';
import { REAGENT_SEEDS } from './reagents.js';
import { buildBlankStationScene, buildTitrationStationScene } from './sampleScenes.js';
import { createScene } from '../scenes/repository.js';

export interface SeedReport {
  equipmentDefinitions: number;
  reagents: number;
  scenesCreated: string[];
  scenesSkipped: string[];
}

export async function seedAll(db: Database): Promise<SeedReport> {
  const stubEquipmentSourceId = await ensureStubEquipmentSource(db);
  const userSourceId = await ensureUserSource(db);

  for (const definition of STUB_EQUIPMENT_DEFINITIONS) {
    await upsertEquipmentDefinition(db, definition, stubEquipmentSourceId);
  }

  for (const reagent of REAGENT_SEEDS) {
    const scienceCompoundId = await findScienceCompoundIdByName(db, reagent.scienceCompoundName);
    await upsertReagent(
      db,
      {
        speciesId: reagent.speciesId,
        name: reagent.name,
        formula: reagent.formula,
        roles: [...reagent.roles],
        scienceCompoundId,
        recommendedConcentrationMolPerL: reagent.recommendedConcentrationMolPerL,
        hazardNotes: reagent.hazardNotes,
        sourceKey: 'matterlab-api-stub-equipment',
      },
      stubEquipmentSourceId,
    );
  }

  const scenesCreated: string[] = [];
  const scenesSkipped: string[] = [];
  for (const build of [buildTitrationStationScene, buildBlankStationScene]) {
    const request = build();
    const existing = await db.queryOne<{ id: string }>('SELECT id FROM lab_scene WHERE title = $1 AND owner_id IS NULL', [request.title]);
    if (existing) {
      scenesSkipped.push(request.title);
      continue;
    }
    await createScene(db, request, null, userSourceId);
    scenesCreated.push(request.title);
  }

  return { equipmentDefinitions: STUB_EQUIPMENT_DEFINITIONS.length, reagents: REAGENT_SEEDS.length, scenesCreated, scenesSkipped };
}
