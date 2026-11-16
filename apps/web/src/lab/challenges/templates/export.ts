import type { ExperimentScene } from '../contracts';
import { LAB_TEMPLATE_SCHEMA, LAB_TEMPLATE_SCHEMA_VERSION } from './types';
import type { LabTemplate } from './types';

export interface TemplateMeta {
  readonly name: string;
  readonly description: string;
  readonly objectiveId?: string;
}

export function buildTemplateFromScene(scene: ExperimentScene, meta: TemplateMeta): LabTemplate {
  return {
    schema: LAB_TEMPLATE_SCHEMA,
    schemaVersion: LAB_TEMPLATE_SCHEMA_VERSION,
    id: crypto.randomUUID(),
    name: meta.name,
    description: meta.description,
    objectiveId: meta.objectiveId ?? null,
    createdAt: new Date().toISOString(),
    apparatus: scene.apparatus,
    connections: scene.connections,
    stations: scene.stations,
    containerStates: scene.containerStates,
  };
}

export function serializeTemplate(template: LabTemplate): string {
  return JSON.stringify(template, null, 2);
}

export function parseTemplate(json: string): LabTemplate {
  let data: Partial<LabTemplate>;
  try {
    data = JSON.parse(json) as Partial<LabTemplate>;
  } catch {
    throw new Error('That file is not valid JSON.');
  }
  if (data.schema !== LAB_TEMPLATE_SCHEMA) throw new Error('That file is not a MATTER LAB lab template.');
  if (data.schemaVersion !== LAB_TEMPLATE_SCHEMA_VERSION) throw new Error(`Unsupported lab template schema version: ${String(data.schemaVersion)}.`);
  if (!Array.isArray(data.apparatus) || !Array.isArray(data.connections) || !Array.isArray(data.stations)) {
    throw new Error('The lab template file is missing required fields.');
  }
  return data as LabTemplate;
}
