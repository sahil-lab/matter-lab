import { writeFile } from 'node:fs/promises';
import { getScienceCatalog } from '../dist/index.mjs';

const catalogue = getScienceCatalog();
const common = {
  schemaVersion: catalogue.schemaVersion,
  methodId: catalogue.methodId,
  methodVersion: catalogue.methodVersion,
  catalogStatus: catalogue.catalogStatus,
};
await Promise.all([
  writeFile(new URL('../dist/reagent-definitions.json', import.meta.url), `${JSON.stringify({
    ...common, analyticalComponents: catalogue.analyticalComponents, reagents: catalogue.reagents, indicators: catalogue.indicators,
  }, null, 2)}\n`, 'utf8'),
  writeFile(new URL('../dist/source-references.json', import.meta.url), `${JSON.stringify({
    ...common, sources: catalogue.sources,
  }, null, 2)}\n`, 'utf8'),
]);
