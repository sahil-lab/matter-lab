/** Scene persistence: CRUD, optimistic-concurrency PATCH and isolation-preserving duplicate. */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from '../db.js';
import type { Database } from '../db.js';
import { ApiError, notFound, revisionConflict } from '../errors.js';
import type { ApparatusInstance, Connection, ContainerContents, ScenePatchRequest, SceneCreateRequest, SceneRecord, SceneSummary } from '@matterlab/contracts-lab';
import { type SceneGraph, toSceneRecord, toSceneSummary } from './mapping.js';

interface Station {
  id: string;
  name: string;
}

async function fetchGraph(client: PoolClient, sceneId: string): Promise<SceneGraph> {
  // Sequential, not Promise.all: a single pg connection processes one query at a time, and
  // concurrent client.query() calls on the same client are deprecated.
  const stations = await client.query('SELECT id, name, position FROM lab_station WHERE scene_id = $1 ORDER BY position, id', [sceneId]);
  const apparatus = await client.query(
    `SELECT id, station_id, kind, definition_key, position_m_x, position_m_y, position_m_z,
            quaternion_x, quaternion_y, quaternion_z, quaternion_w, instance_revision, config, capabilities
     FROM apparatus_instance WHERE scene_id = $1 ORDER BY position, created_at, id`,
    [sceneId],
  );
  const connections = await client.query(
    'SELECT id, from_instance_id, from_socket_id, to_instance_id, to_socket_id, kind, enabled FROM apparatus_connection WHERE scene_id = $1 ORDER BY position, created_at, id',
    [sceneId],
  );
  const containers = await client.query(
    'SELECT apparatus_instance_id, volume_l, species, temperature_k, mixing, model_id FROM container_state WHERE scene_id = $1',
    [sceneId],
  );
  return {
    stations: stations.rows as SceneGraph['stations'],
    apparatus: apparatus.rows as SceneGraph['apparatus'],
    connections: connections.rows as SceneGraph['connections'],
    containers: containers.rows as SceneGraph['containers'],
  };
}

async function fetchSceneRow(client: PoolClient, sceneId: string): Promise<import('./mapping.js').SceneRow | null> {
  const result = await client.query(
    'SELECT id, title, schema_version, simulation_config, viewport, revision, owner_id, created_at, updated_at FROM lab_scene WHERE id = $1',
    [sceneId],
  );
  return (result.rows[0] as import('./mapping.js').SceneRow | undefined) ?? null;
}

async function loadRecord(client: PoolClient, sceneId: string): Promise<SceneRecord | null> {
  const scene = await fetchSceneRow(client, sceneId);
  if (!scene) return null;
  const graph = await fetchGraph(client, sceneId);
  return toSceneRecord(scene, graph);
}

/** Every apparatus must belong to a declared station; every connection and container must reference a declared apparatus. */
function validateGraphReferences(stations: Station[], apparatus: ApparatusInstance[], connections: Connection[], containerStates: Record<string, ContainerContents>): void {
  const stationIds = new Set(stations.map((s) => s.id));
  const apparatusIds = new Set(apparatus.map((a) => a.id));
  for (const instance of apparatus) {
    if (!stationIds.has(instance.stationId)) {
      throw new ApiError(422, 'unknown_reference', `Apparatus ${instance.id} references station ${instance.stationId}, which is not in this scene.`);
    }
  }
  for (const connection of connections) {
    if (!apparatusIds.has(connection.from.instanceId)) {
      throw new ApiError(422, 'unknown_reference', `Connection ${connection.id} references unknown apparatus ${connection.from.instanceId}.`);
    }
    if (!apparatusIds.has(connection.to.instanceId)) {
      throw new ApiError(422, 'unknown_reference', `Connection ${connection.id} references unknown apparatus ${connection.to.instanceId}.`);
    }
  }
  for (const instanceId of Object.keys(containerStates)) {
    if (!apparatusIds.has(instanceId)) {
      throw new ApiError(422, 'unknown_reference', `Container state references unknown apparatus ${instanceId}.`);
    }
  }
}

async function replaceGraph(
  client: PoolClient,
  sceneId: string,
  stations: Station[],
  apparatus: ApparatusInstance[],
  connections: Connection[],
  containerStates: Record<string, ContainerContents>,
): Promise<void> {
  validateGraphReferences(stations, apparatus, connections, containerStates);
  // Deleting stations cascades to apparatus_instance, which cascades to apparatus_connection and
  // container_state: one statement clears the whole graph before it is rewritten from scratch.
  await client.query('DELETE FROM lab_station WHERE scene_id = $1', [sceneId]);
  let stationPosition = 0;
  for (const station of stations) {
    await client.query('INSERT INTO lab_station (id, scene_id, name, position) VALUES ($1, $2, $3, $4)', [station.id, sceneId, station.name, stationPosition++]);
  }
  let apparatusPosition = 0;
  for (const instance of apparatus) {
    await client.query(
      `INSERT INTO apparatus_instance
         (id, scene_id, station_id, kind, definition_key, position_m_x, position_m_y, position_m_z,
          quaternion_x, quaternion_y, quaternion_z, quaternion_w, instance_revision, config, capabilities, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        instance.id,
        sceneId,
        instance.stationId,
        instance.kind,
        instance.definitionId,
        instance.transform.positionM[0],
        instance.transform.positionM[1],
        instance.transform.positionM[2],
        instance.transform.quaternion[0],
        instance.transform.quaternion[1],
        instance.transform.quaternion[2],
        instance.transform.quaternion[3],
        instance.revision,
        JSON.stringify(instance.config),
        instance.capabilities,
        apparatusPosition++,
      ],
    );
  }
  let connectionPosition = 0;
  for (const connection of connections) {
    await client.query(
      `INSERT INTO apparatus_connection (id, scene_id, from_instance_id, from_socket_id, to_instance_id, to_socket_id, kind, enabled, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [connection.id, sceneId, connection.from.instanceId, connection.from.socketId, connection.to.instanceId, connection.to.socketId, connection.kind, connection.enabled, connectionPosition++],
    );
  }
  for (const [instanceId, contents] of Object.entries(containerStates)) {
    await client.query(
      `INSERT INTO container_state (apparatus_instance_id, scene_id, volume_l, species, temperature_k, mixing, model_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [instanceId, sceneId, contents.volumeL, JSON.stringify(contents.species), contents.temperatureK, contents.mixing, contents.modelId],
    );
  }
}

export async function createScene(db: Database, request: SceneCreateRequest, ownerId: string | null, sourceId: number): Promise<SceneRecord> {
  return db.transaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO lab_scene (title, simulation_config, viewport, owner_id, source_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [request.title, JSON.stringify(request.simulationConfig), request.viewport ? JSON.stringify(request.viewport) : null, ownerId, sourceId],
    );
    const sceneId = (inserted.rows[0] as { id: string }).id;
    await replaceGraph(client, sceneId, request.stations, request.apparatus, request.connections, request.containerStates);
    const record = await loadRecord(client, sceneId);
    if (!record) throw new Error('scene vanished immediately after creation');
    return record;
  });
}

export async function getScene(db: Database, sceneId: string): Promise<SceneRecord | null> {
  return db.transaction((client) => loadRecord(client, sceneId));
}

export interface PatchOutcome {
  record: SceneRecord;
}

export async function patchScene(db: Database, sceneId: string, patch: ScenePatchRequest, expectedRevision: number): Promise<PatchOutcome> {
  return db.transaction(async (client) => {
    const current = await client.query('SELECT revision FROM lab_scene WHERE id = $1 FOR UPDATE', [sceneId]);
    const currentRow = current.rows[0] as { revision: number } | undefined;
    if (!currentRow) throw notFound('scene', sceneId);
    if (currentRow.revision !== expectedRevision) throw revisionConflict(currentRow.revision, expectedRevision);

    const touchesGraph = patch.stations !== undefined || patch.apparatus !== undefined || patch.connections !== undefined || patch.containerStates !== undefined;
    const assignments: string[] = ['revision = revision + 1'];
    const params: unknown[] = [];
    let paramIndex = 1;
    if (patch.title !== undefined) {
      assignments.push(`title = $${++paramIndex}`);
      params.push(patch.title);
    }
    if (patch.simulationConfig !== undefined) {
      assignments.push(`simulation_config = $${++paramIndex}`);
      params.push(JSON.stringify(patch.simulationConfig));
    }
    if (patch.viewport !== undefined) {
      assignments.push(`viewport = $${++paramIndex}`);
      params.push(JSON.stringify(patch.viewport));
    }
    await client.query(`UPDATE lab_scene SET ${assignments.join(', ')} WHERE id = $1`, [sceneId, ...params]);

    if (touchesGraph) {
      const currentGraph = await fetchGraph(client, sceneId);
      const stations = patch.stations ?? currentGraph.stations.map((s) => ({ id: s.id, name: s.name }));
      const apparatus =
        patch.apparatus ??
        currentGraph.apparatus.map(
          (a): ApparatusInstance => ({
            id: a.id,
            kind: a.kind,
            definitionId: a.definition_key,
            transform: { positionM: [a.position_m_x, a.position_m_y, a.position_m_z], quaternion: [a.quaternion_x, a.quaternion_y, a.quaternion_z, a.quaternion_w] },
            revision: a.instance_revision,
            config: a.config,
            capabilities: a.capabilities,
            stationId: a.station_id,
          }),
        );
      const connections =
        patch.connections ??
        currentGraph.connections.map(
          (c): Connection => ({
            id: c.id,
            from: { instanceId: c.from_instance_id, socketId: c.from_socket_id },
            to: { instanceId: c.to_instance_id, socketId: c.to_socket_id },
            kind: c.kind,
            enabled: c.enabled,
          }),
        );
      const containerStates =
        patch.containerStates ??
        Object.fromEntries(
          currentGraph.containers.map((cs): [string, ContainerContents] => [
            cs.apparatus_instance_id,
            { volumeL: cs.volume_l, species: cs.species, temperatureK: cs.temperature_k, mixing: cs.mixing, modelId: cs.model_id },
          ]),
        );
      await replaceGraph(client, sceneId, stations, apparatus, connections, containerStates);
    }

    const record = await loadRecord(client, sceneId);
    if (!record) throw new Error('scene vanished during patch');
    return { record };
  });
}

export async function duplicateScene(db: Database, sceneId: string, titleOverride: string | undefined, ownerId: string | null, sourceId: number): Promise<SceneRecord> {
  return db.transaction(async (client) => {
    const original = await fetchSceneRow(client, sceneId);
    if (!original) throw notFound('scene', sceneId);
    const graph = await fetchGraph(client, sceneId);

    const inserted = await client.query(
      `INSERT INTO lab_scene (title, simulation_config, viewport, owner_id, duplicated_from_id, source_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [titleOverride ?? `${original.title} (copy)`, JSON.stringify(original.simulation_config), original.viewport ? JSON.stringify(original.viewport) : null, ownerId, sceneId, sourceId],
    );
    const newSceneId = (inserted.rows[0] as { id: string }).id;

    const stationIdMap = new Map(graph.stations.map((s) => [s.id, randomUUID()]));
    const instanceIdMap = new Map(graph.apparatus.map((a) => [a.id, randomUUID()]));

    const newStations = graph.stations.map((s) => ({ id: stationIdMap.get(s.id)!, name: s.name }));
    const newApparatus: ApparatusInstance[] = graph.apparatus.map((a) => ({
      id: instanceIdMap.get(a.id)!,
      kind: a.kind,
      definitionId: a.definition_key,
      transform: { positionM: [a.position_m_x, a.position_m_y, a.position_m_z], quaternion: [a.quaternion_x, a.quaternion_y, a.quaternion_z, a.quaternion_w] },
      revision: a.instance_revision,
      config: a.config,
      capabilities: a.capabilities,
      stationId: stationIdMap.get(a.station_id)!,
    }));
    const newConnections: Connection[] = graph.connections.map((c) => ({
      id: randomUUID(),
      from: { instanceId: instanceIdMap.get(c.from_instance_id)!, socketId: c.from_socket_id },
      to: { instanceId: instanceIdMap.get(c.to_instance_id)!, socketId: c.to_socket_id },
      kind: c.kind,
      enabled: c.enabled,
    }));
    const newContainerStates: Record<string, ContainerContents> = Object.fromEntries(
      graph.containers.map((cs): [string, ContainerContents] => [
        instanceIdMap.get(cs.apparatus_instance_id)!,
        { volumeL: cs.volume_l, species: cs.species, temperatureK: cs.temperature_k, mixing: cs.mixing, modelId: cs.model_id },
      ]),
    );

    await replaceGraph(client, newSceneId, newStations, newApparatus, newConnections, newContainerStates);
    const record = await loadRecord(client, newSceneId);
    if (!record) throw new Error('duplicated scene vanished immediately after creation');
    return record;
  });
}

export interface ListScenesOptions {
  ownerId?: string | null;
  limit: number;
  offset: number;
}

export async function listScenes(db: Database, options: ListScenesOptions): Promise<{ items: SceneSummary[]; total: number }> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.ownerId !== undefined) {
    if (options.ownerId === null) {
      clauses.push('owner_id IS NULL');
    } else {
      params.push(options.ownerId);
      clauses.push(`owner_id = $${params.length}`);
    }
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const totalRow = await db.queryOne<{ n: string }>(`SELECT count(*) AS n FROM lab_scene ${where}`, params);
  const rows = await db.query<Record<string, unknown>>(
    `SELECT s.id, s.title, s.schema_version, s.simulation_config, s.viewport, s.revision, s.owner_id, s.created_at, s.updated_at,
            (SELECT count(*) FROM lab_station st WHERE st.scene_id = s.id) AS station_count,
            (SELECT count(*) FROM apparatus_instance ai WHERE ai.scene_id = s.id) AS apparatus_count
     FROM lab_scene s ${where} ORDER BY s.updated_at DESC, s.id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, options.limit, options.offset],
  );
  const items = rows.map((row) =>
    toSceneSummary(row as unknown as import('./mapping.js').SceneRow, Number(row.station_count), Number(row.apparatus_count)),
  );
  return { items, total: totalRow ? Number(totalRow.n) : 0 };
}

export async function deleteScene(db: Database, sceneId: string): Promise<boolean> {
  const result = await db.query('DELETE FROM lab_scene WHERE id = $1 RETURNING id', [sceneId]);
  return result.length > 0;
}
