import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LAB_CONTRACT_VERSION, parseLabContract } from '../../../packages/contracts/src/index.ts';
import type { ReplayStep } from '../../../packages/contracts/src/index.ts';
import { apparatusRegistry } from '../../../apps/web/src/lab/apparatus/registry.ts';
import { createTitrationSetup } from '../../../apps/web/src/lab/apparatus/seeds.ts';
import { SCIENCE_METHOD_ID, SCIENCE_METHOD_VERSION, getScienceCatalog, prepareSolution } from '../../../packages/lab-science/src/index.ts';

const destination = resolve(process.argv[2] ?? 'packages/lab-runtime/dist/catalog');
await mkdir(destination, { recursive: true });
const catalogue = getScienceCatalog();
let next = 0;
const createId = () => `00000000-0000-4000-8000-${(++next).toString(16).padStart(12, '0')}`;
const setup = createTitrationSetup(SCIENCE_METHOD_ID, createId);
const fills = [
  { target: setup.ids.flaskId, reagentId: 'hcl', volumeL: 0.025, concentrationMolL: 0.1 },
  { target: setup.ids.buretteId, reagentId: 'naoh', volumeL: 0.05, concentrationMolL: 0.1 },
] as const;
const suggestedSteps: ReplayStep[] = fills.map((fill) => {
  const preparation = prepareSolution({ reagentId: fill.reagentId, volumeL: fill.volumeL, concentrationMolL: fill.concentrationMolL, temperatureK: 298.15 });
  if (preparation.status !== 'SUCCEEDED' || !preparation.sourceIds[0]) throw new Error('The canonical solver could not prepare the documented educational sample.');
  return { kind: 'ACTION', action: parseLabContract('LabAction', {
    actionId: createId(), atSimulationS: 0, targetInstanceId: fill.target, type: 'FILL',
    payload: { contents: preparation.contents, preparation: { kind: 'INITIAL', sourceId: preparation.sourceIds[0] } },
  }) };
});
const common = { schemaVersion: 1, methodId: SCIENCE_METHOD_ID, methodVersion: SCIENCE_METHOD_VERSION, catalogStatus: 'CURATED' };
const documents = {
  'equipment-definitions.json': { schemaVersion: 1, equipment: apparatusRegistry.listDefinitions() },
  'reagent-definitions.json': { ...common, reagents: catalogue.reagents, analyticalComponents: catalogue.analyticalComponents, indicators: catalogue.indicators },
  'source-references.json': { ...common, sources: catalogue.sources },
  'starter-scene.json': {
    schemaVersion: 1, contractVersion: LAB_CONTRACT_VERSION, methodVersion: SCIENCE_METHOD_VERSION,
    title: 'Titration station and blank bench', scene: setup.scene, suggestedSteps,
    notes: ['Unfilled parent-authored apparatus scene. Suggested virtual preparations are commands from the canonical chemistry package, not applied inventories or measured observations.'],
  },
};
for (const [name, document] of Object.entries(documents)) await writeFile(resolve(destination, name), JSON.stringify(document) + '\n', 'utf8');
console.log(`Exported ${Object.keys(documents).length} canonical laboratory release artifacts to ${destination}.`);
