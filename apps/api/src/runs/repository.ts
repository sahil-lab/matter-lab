/** Run persistence: immutable snapshot at creation, durable lifecycle, observations and events. */
import type { Database, Queryable } from '../db.js';
import { queryableFromClient } from '../db.js';
import type { ExperimentScene, LabAction, Observation, RunCreateRequest, RunEvent, RunRecord, RunStatus, RunSummary } from '@matterlab/contracts-lab';
import { notFound } from '../errors.js';
import { canonicalJson, sha256Hex } from '../util.js';
import { methodVersionOf } from './methodRegistry.js';

interface RunRow {
  id: string;
  scene_id: string;
  scene_revision: number;
  status: RunStatus;
  method_id: string;
  method_version: string;
  input_hash: string;
  warnings: string[];
  assumptions: string[];
  solver_diagnostics: Record<string, unknown> | null;
  failure_code: string | null;
  failure_message: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

function toSummary(row: RunRow): RunSummary {
  return {
    runId: row.id,
    sceneId: row.scene_id,
    status: row.status,
    methodId: row.method_id,
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

async function toRecord(db: Queryable, row: RunRow): Promise<RunRecord> {
  const observationRows = await db.query<{
    type: Observation['type'];
    apparatus_instance_id: string | null;
    time_s: number;
    value: number;
    unit: string;
    uncertainty: number | null;
    evidence: Observation['evidence'];
    method_id: string;
    source_ids: string[];
  }>(
    'SELECT type, apparatus_instance_id, time_s, value, unit, uncertainty, evidence, method_id, source_ids FROM lab_observation WHERE run_id = $1 ORDER BY sequence',
    [row.id],
  );
  const observations: Observation[] = observationRows.map((o) => ({
    type: o.type,
    apparatusId: o.apparatus_instance_id ?? undefined,
    timeS: o.time_s,
    quantity: { value: o.value, unit: o.unit, uncertainty: o.uncertainty ?? undefined },
    evidence: o.evidence,
    methodId: o.method_id,
    sourceIds: o.source_ids,
  }));
  return {
    runId: row.id,
    sceneId: row.scene_id,
    sceneRevision: row.scene_revision,
    status: row.status,
    methodId: row.method_id,
    methodVersion: row.method_version,
    inputHash: row.input_hash,
    observations,
    warnings: row.warnings,
    assumptions: row.assumptions,
    solverDiagnostics: row.solver_diagnostics ?? undefined,
    failureCode: row.failure_code ?? undefined,
    failureMessage: row.failure_message ?? undefined,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

export interface CreatedRun {
  record: RunRecord;
  sceneSnapshot: ExperimentScene;
  actions: LabAction[];
  settings: Record<string, unknown>;
}

export async function createRun(db: Database, sceneId: string, request: RunCreateRequest, ownerId: string | null): Promise<CreatedRun> {
  return db.transaction(async (client) => {
    const sceneRow = await client.query(
      `SELECT id, title, schema_version, simulation_config, viewport, revision FROM lab_scene WHERE id = $1`,
      [sceneId],
    );
    const scene = sceneRow.rows[0] as { id: string; revision: number; simulation_config: unknown } | undefined;
    if (!scene) throw notFound('scene', sceneId);

    // Sequential, not Promise.all: a single pg connection processes one query at a time, and
    // concurrent client.query() calls on the same client are deprecated.
    const stations = await client.query('SELECT id, name FROM lab_station WHERE scene_id = $1 ORDER BY position, id', [sceneId]);
    const apparatus = await client.query(
      `SELECT id, station_id, kind, definition_key, position_m_x, position_m_y, position_m_z, quaternion_x, quaternion_y, quaternion_z,
              quaternion_w, instance_revision, config, capabilities
       FROM apparatus_instance WHERE scene_id = $1 ORDER BY position, created_at, id`,
      [sceneId],
    );
    const connections = await client.query(
      'SELECT id, from_instance_id, from_socket_id, to_instance_id, to_socket_id, kind, enabled FROM apparatus_connection WHERE scene_id = $1 ORDER BY position, created_at, id',
      [sceneId],
    );
    const containers = await client.query('SELECT apparatus_instance_id, volume_l, species, temperature_k, mixing, model_id FROM container_state WHERE scene_id = $1', [sceneId]);

    const sceneSnapshot: ExperimentScene = {
      id: scene.id,
      revision: scene.revision,
      schemaVersion: 1,
      stations: stations.rows.map((s) => ({ id: s.id as string, name: s.name as string })),
      apparatus: apparatus.rows.map((a) => ({
        id: a.id as string,
        kind: a.kind,
        definitionId: a.definition_key,
        transform: { positionM: [a.position_m_x, a.position_m_y, a.position_m_z], quaternion: [a.quaternion_x, a.quaternion_y, a.quaternion_z, a.quaternion_w] },
        revision: a.instance_revision,
        config: a.config,
        capabilities: a.capabilities,
        stationId: a.station_id,
      })),
      connections: connections.rows.map((c) => ({
        id: c.id as string,
        from: { instanceId: c.from_instance_id, socketId: c.from_socket_id },
        to: { instanceId: c.to_instance_id, socketId: c.to_socket_id },
        kind: c.kind,
        enabled: c.enabled,
      })),
      containerStates: Object.fromEntries(
        containers.rows.map((cs) => [cs.apparatus_instance_id as string, { volumeL: cs.volume_l, species: cs.species, temperatureK: cs.temperature_k, mixing: cs.mixing, modelId: cs.model_id }]),
      ),
      simulationConfig: scene.simulation_config as ExperimentScene['simulationConfig'],
    };

    const inputHash = sha256Hex(canonicalJson({ sceneSnapshot, actions: request.actions, methodId: request.methodId, settings: request.settings }));
    const methodVersion = methodVersionOf(request.methodId);

    const inserted = await client.query(
      `INSERT INTO lab_run (scene_id, scene_revision, status, method_id, method_version, input_hash, settings, scene_snapshot, owner_id)
       VALUES ($1, $2, 'QUEUED', $3, $4, $5, $6, $7, $8)
       RETURNING id, scene_id, scene_revision, status, method_id, method_version, input_hash, warnings, assumptions, solver_diagnostics, failure_code, failure_message, created_at, started_at, finished_at`,
      [sceneId, scene.revision, request.methodId, methodVersion, inputHash, JSON.stringify(request.settings), JSON.stringify(sceneSnapshot), ownerId],
    );
    const runRow = inserted.rows[0] as RunRow;

    let sequence = 0;
    for (const action of request.actions) {
      await client.query(
        `INSERT INTO lab_action_event (run_id, sequence, action_id, at_simulation_s, target_instance_id, type, payload, actor_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [runRow.id, sequence++, action.actionId, action.atSimulationS, action.targetInstanceId, action.type, JSON.stringify(action.payload), action.actorId ?? null],
      );
    }
    await client.query('INSERT INTO lab_run_event (run_id, sequence, status, message) VALUES ($1, 0, $2, $3)', [runRow.id, 'QUEUED', 'Run queued.']);

    return { record: await toRecord(queryableFromClient(client), runRow), sceneSnapshot, actions: request.actions, settings: request.settings };
  });
}

export async function getRun(db: Database, runId: string): Promise<RunRecord | null> {
  const row = await db.queryOne<RunRow>(
    'SELECT id, scene_id, scene_revision, status, method_id, method_version, input_hash, warnings, assumptions, solver_diagnostics, failure_code, failure_message, created_at, started_at, finished_at FROM lab_run WHERE id = $1',
    [runId],
  );
  return row ? toRecord(db, row) : null;
}

export async function listRuns(db: Database, sceneId: string, limit: number, offset: number): Promise<{ items: RunSummary[]; total: number }> {
  const totalRow = await db.queryOne<{ n: string }>('SELECT count(*) AS n FROM lab_run WHERE scene_id = $1', [sceneId]);
  const rows = await db.query<RunRow>(
    'SELECT id, scene_id, scene_revision, status, method_id, method_version, input_hash, warnings, assumptions, solver_diagnostics, failure_code, failure_message, created_at, started_at, finished_at ' +
      'FROM lab_run WHERE scene_id = $1 ORDER BY created_at DESC, id LIMIT $2 OFFSET $3',
    [sceneId, limit, offset],
  );
  return { items: rows.map(toSummary), total: totalRow ? Number(totalRow.n) : 0 };
}

export async function requestCancel(db: Database, runId: string): Promise<RunRecord | null> {
  const row = await db.queryOne<RunRow>(
    `UPDATE lab_run SET cancel_requested = true WHERE id = $1 AND status IN ('QUEUED', 'RUNNING')
     RETURNING id, scene_id, scene_revision, status, method_id, method_version, input_hash, warnings, assumptions, solver_diagnostics, failure_code, failure_message, created_at, started_at, finished_at`,
    [runId],
  );
  if (row) return toRecord(db, row);
  return getRun(db, runId);
}

export async function listRunEventsAfter(db: Database, runId: string, afterSequence: number): Promise<RunEvent[]> {
  const rows = await db.query<{ sequence: number; status: RunStatus; message: string; observation: Observation | null; created_at: Date }>(
    'SELECT sequence, status, message, observation, created_at FROM lab_run_event WHERE run_id = $1 AND sequence > $2 ORDER BY sequence',
    [runId, afterSequence],
  );
  return rows.map((row) => ({ sequence: row.sequence, at: row.created_at.toISOString(), status: row.status, message: row.message, observation: row.observation ?? undefined }));
}

export function runExists(db: Database, runId: string): Promise<boolean> {
  return db.queryOne('SELECT 1 FROM lab_run WHERE id = $1', [runId]).then((row) => row !== null);
}

// ------------------------------------------------------------------------------------------------
// Execution-time helpers (called only by executor.ts, which drives a run from QUEUED to a terminal
// status). Kept here so every SQL statement touching lab_run/lab_observation/lab_run_event lives in
// one file.
// ------------------------------------------------------------------------------------------------

export interface ExecutionInput {
  readonly methodId: string;
  readonly sceneId: string;
  readonly sceneSnapshot: ExperimentScene;
  readonly actions: LabAction[];
  readonly settings: Record<string, unknown>;
}

export async function loadForExecution(db: Database, runId: string): Promise<ExecutionInput | null> {
  const run = await db.queryOne<{ method_id: string; scene_id: string; scene_snapshot: ExperimentScene; settings: Record<string, unknown> }>(
    'SELECT method_id, scene_id, scene_snapshot, settings FROM lab_run WHERE id = $1',
    [runId],
  );
  if (!run) return null;
  const actionRows = await db.query<{ action_id: string; at_simulation_s: number; target_instance_id: string; type: LabAction['type']; payload: Record<string, unknown>; actor_id: string | null }>(
    'SELECT action_id, at_simulation_s, target_instance_id, type, payload, actor_id FROM lab_action_event WHERE run_id = $1 ORDER BY sequence',
    [runId],
  );
  const actions: LabAction[] = actionRows.map((a) => ({
    actionId: a.action_id,
    atSimulationS: a.at_simulation_s,
    targetInstanceId: a.target_instance_id,
    type: a.type,
    payload: a.payload,
    actorId: a.actor_id ?? undefined,
  }));
  return { methodId: run.method_id, sceneId: run.scene_id, sceneSnapshot: run.scene_snapshot, actions, settings: run.settings };
}

export async function isCancelRequested(db: Database, runId: string): Promise<boolean> {
  const row = await db.queryOne<{ cancel_requested: boolean }>('SELECT cancel_requested FROM lab_run WHERE id = $1', [runId]);
  return row?.cancel_requested ?? false;
}

async function nextEventSequence(db: Database, runId: string): Promise<number> {
  const row = await db.queryOne<{ next: number }>('SELECT COALESCE(max(sequence), -1) + 1 AS next FROM lab_run_event WHERE run_id = $1', [runId]);
  return row ? Number(row.next) : 0;
}

export async function appendRunEvent(db: Database, runId: string, status: RunStatus, message: string, observation?: Observation): Promise<void> {
  const sequence = await nextEventSequence(db, runId);
  await db.query('INSERT INTO lab_run_event (run_id, sequence, status, message, observation) VALUES ($1, $2, $3, $4, $5)', [
    runId,
    sequence,
    status,
    message,
    observation ? JSON.stringify(observation) : null,
  ]);
}

export async function markRunning(db: Database, runId: string): Promise<void> {
  await db.query("UPDATE lab_run SET status = 'RUNNING', started_at = now() WHERE id = $1 AND status = 'QUEUED'", [runId]);
}

export async function persistObservations(db: Database, runId: string, sceneId: string, observations: readonly Observation[]): Promise<void> {
  let sequence = 0;
  for (const observation of observations) {
    await db.query(
      `INSERT INTO lab_observation (run_id, scene_id, sequence, type, apparatus_instance_id, time_s, value, unit, uncertainty, evidence, method_id, source_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        runId,
        sceneId,
        sequence++,
        observation.type,
        observation.apparatusId ?? null,
        observation.timeS,
        observation.quantity.value,
        observation.quantity.unit,
        observation.quantity.uncertainty ?? null,
        observation.evidence,
        observation.methodId,
        observation.sourceIds,
      ],
    );
  }
}

export interface FinalizeOutcome {
  readonly warnings: readonly string[];
  readonly assumptions: readonly string[];
  readonly solverDiagnostics?: Record<string, unknown>;
  readonly failureCode?: string;
  readonly failureMessage?: string;
}

export async function finalizeRun(db: Database, runId: string, status: RunStatus, outcome: FinalizeOutcome): Promise<void> {
  await db.query(
    `UPDATE lab_run SET status = $2, warnings = $3, assumptions = $4, solver_diagnostics = $5, failure_code = $6, failure_message = $7,
                         started_at = COALESCE(started_at, now()), finished_at = now()
     WHERE id = $1`,
    [
      runId,
      status,
      outcome.warnings,
      outcome.assumptions,
      outcome.solverDiagnostics ? JSON.stringify(outcome.solverDiagnostics) : null,
      outcome.failureCode ?? null,
      outcome.failureMessage ?? null,
    ],
  );
}
