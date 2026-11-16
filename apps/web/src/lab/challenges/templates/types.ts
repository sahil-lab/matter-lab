import type { ApparatusInstance, Connection, ContainerContents, ExperimentScene, UUID } from '../contracts';

export const LAB_TEMPLATE_SCHEMA = 'matterlab.lab-template';
export const LAB_TEMPLATE_SCHEMA_VERSION = 1;

/**
 * A reusable, exportable snapshot of a guided (or free) apparatus arrangement: the apparatus
 * graph, its connections and the starting reagent fills, without any accumulated run history.
 * Re-applying a template into a live `ExperimentScene` is Agent 07's scene-construction job; this
 * module only produces and parses the portable JSON document.
 */
export interface LabTemplate {
  readonly schema: 'matterlab.lab-template';
  readonly schemaVersion: 1;
  readonly id: UUID;
  readonly name: string;
  readonly description: string;
  readonly objectiveId: string | null;
  readonly createdAt: string;
  readonly apparatus: readonly ApparatusInstance[];
  readonly connections: readonly Connection[];
  readonly stations: ExperimentScene['stations'];
  readonly containerStates: Readonly<Record<UUID, ContainerContents>>;
}
