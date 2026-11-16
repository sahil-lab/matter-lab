import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { LAB_JSON_SCHEMA } from '../lab/json-schema.ts';

const directory = fileURLToPath(new URL('../schemas/', import.meta.url));
mkdirSync(directory, { recursive: true });
writeFileSync(join(directory, 'lab-v1.schema.json'), `${JSON.stringify(LAB_JSON_SCHEMA, null, 2)}\n`, 'utf8');
