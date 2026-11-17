/** DB row <-> domain/API shape mapping for lab scenes. */
import type { ApparatusInstance, Connection, ContainerContents } from '@matterlab/contracts-lab';
import type { SceneRecord, SceneSummary } from '@matterlab/contracts-lab';

export interface SceneRow {
  id: string;
  title: string;
  schema_version: number;
  simulation_config: { methodId: string; timeStepS: number };
  viewport: Record<string, unknown> | null;
  revision: number;
  owner_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface StationRow {
  id: string;
  name: string;
  position: number;
}

export interface ApparatusInstanceRow {
  id: string;
  station_id: string;
  kind: ApparatusInstance['kind'];
  definition_key: string;
  position_m_x: number;
  position_m_y: number;
  position_m_z: number;
  quaternion_x: number;
  quaternion_y: number;
  quaternion_z: number;
  quaternion_w: number;
  instance_revision: number;
  config: Record<string, unknown>;
  capabilities: ApparatusInstance['capabilities'];
}

export interface ConnectionRow {
  id: string;
  from_instance_id: string;
  from_socket_id: string;
  to_instance_id: string;
  to_socket_id: string;
  kind: Connection['kind'];
  enabled: boolean;
}

export interface ContainerStateRow {
  apparatus_instance_id: string;
  volume_l: number;
  species: ContainerContents['species'];
  temperature_k: number;
  mixing: ContainerContents['mixing'];
  model_id: string;
}

export interface SceneGraph {
  stations: StationRow[];
  apparatus: ApparatusInstanceRow[];
  connections: ConnectionRow[];
  containers: ContainerStateRow[];
}

export function toSceneRecord(scene: SceneRow, graph: SceneGraph): SceneRecord {
  return {
    id: scene.id,
    revision: scene.revision,
    schemaVersion: 1,
    title: scene.title,
    ownerId: scene.owner_id,
    createdAt: scene.created_at.toISOString(),
    updatedAt: scene.updated_at.toISOString(),
    stations: graph.stations.map((s) => ({ id: s.id, name: s.name })),
    apparatus: graph.apparatus.map(
      (a): ApparatusInstance => ({
        id: a.id,
        kind: a.kind,
        definitionId: a.definition_key,
        transform: {
          positionM: [a.position_m_x, a.position_m_y, a.position_m_z],
          quaternion: [a.quaternion_x, a.quaternion_y, a.quaternion_z, a.quaternion_w],
        },
        revision: a.instance_revision,
        config: a.config,
        capabilities: a.capabilities,
        stationId: a.station_id,
      }),
    ),
    connections: graph.connections.map(
      (c): Connection => ({
        id: c.id,
        from: { instanceId: c.from_instance_id, socketId: c.from_socket_id },
        to: { instanceId: c.to_instance_id, socketId: c.to_socket_id },
        kind: c.kind,
        enabled: c.enabled,
      }),
    ),
    containerStates: Object.fromEntries(
      graph.containers.map((cs): [string, ContainerContents] => [
        cs.apparatus_instance_id,
        { volumeL: cs.volume_l, species: cs.species, temperatureK: cs.temperature_k, mixing: cs.mixing, modelId: cs.model_id },
      ]),
    ),
    simulationConfig: scene.simulation_config,
    viewport: scene.viewport ?? undefined,
  };
}

export function toSceneSummary(scene: SceneRow, stationCount: number, apparatusCount: number): SceneSummary {
  return {
    id: scene.id,
    title: scene.title,
    revision: scene.revision,
    stationCount,
    apparatusCount,
    ownerId: scene.owner_id,
    createdAt: scene.created_at.toISOString(),
    updatedAt: scene.updated_at.toISOString(),
  };
}
