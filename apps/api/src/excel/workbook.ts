/**
 * Excel export: Equipment, Stations, Connections, Conditions, Trial Measurements, Titration Curve,
 * Observations, Sources - the eight sheets named in the brief. PostgreSQL stays authoritative; this
 * workbook (and the JSON export in `json.ts`) are interchange copies. Every numeric column states
 * its unit in the header. See `sanitize.ts` for why no formula can be injected into a cell.
 */
import ExcelJS from 'exceljs';
import type { Database } from '../db.js';
import { writeText } from './sanitize.js';

const SHEET_ORDER = ['Equipment', 'Stations', 'Connections', 'Conditions', 'Trial Measurements', 'Titration Curve', 'Observations', 'Sources'] as const;

interface ColumnSpec {
  readonly header: string;
  readonly width?: number;
}

const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF7' } };

function addHeader(sheet: ExcelJS.Worksheet, columns: readonly ColumnSpec[]): void {
  columns.forEach((column, index) => {
    const cell = sheet.getCell(1, index + 1);
    writeText(cell, column.header);
    cell.font = { bold: true };
    cell.fill = HEADER_FILL;
    sheet.getColumn(index + 1).width = column.width ?? 20;
  });
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

function writeRow(sheet: ExcelJS.Worksheet, rowIndex: number, values: readonly unknown[]): void {
  values.forEach((value, index) => {
    const cell = sheet.getCell(rowIndex, index + 1);
    if (value === null || value === undefined) return;
    if (typeof value === 'string') writeText(cell, value);
    else cell.value = value as ExcelJS.CellValue;
  });
}

function speciesText(species: readonly { speciesId: string; moles: number }[]): string {
  return species.map((s) => `${s.speciesId}: ${s.moles} mol`).join('; ');
}

export interface ExportSummary {
  readonly sceneId: string;
  readonly sheets: Record<string, number>;
  readonly exportedAt: string;
}

export async function exportSceneWorkbook(db: Database, sceneId: string): Promise<{ buffer: Buffer; summary: ExportSummary } | null> {
  const scene = await db.queryOne<{ id: string; title: string; revision: number; source_id: number }>(
    'SELECT id, title, revision, source_id FROM lab_scene WHERE id = $1',
    [sceneId],
  );
  if (!scene) return null;

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'MATTER LAB lab API';
  workbook.created = new Date();
  const sheets: Record<string, ExcelJS.Worksheet> = {};
  for (const name of SHEET_ORDER) sheets[name] = workbook.addWorksheet(name);
  const counts: Record<string, number> = {};
  const referencedSourceIds = new Set<number>([scene.source_id]);

  // Equipment
  {
    const columns: ColumnSpec[] = [
      { header: 'Apparatus id' },
      { header: 'Kind' },
      { header: 'Definition key' },
      { header: 'Definition version', width: 14 },
      { header: 'Station' },
      { header: 'Position x (m)', width: 14 },
      { header: 'Position y (m)', width: 14 },
      { header: 'Position z (m)', width: 14 },
      { header: 'Capabilities', width: 30 },
      { header: 'Config (JSON)', width: 40 },
    ];
    addHeader(sheets.Equipment, columns);
    const rows = await db.query<{
      id: string;
      kind: string;
      definition_key: string;
      definition_version: number | null;
      station_name: string;
      position_m_x: number;
      position_m_y: number;
      position_m_z: number;
      capabilities: string[];
      config: Record<string, unknown>;
    }>(
      `SELECT ai.id, ai.kind, ai.definition_key, ai.definition_version, ls.name AS station_name,
              ai.position_m_x, ai.position_m_y, ai.position_m_z, ai.capabilities, ai.config
       FROM apparatus_instance ai JOIN lab_station ls ON ls.id = ai.station_id
       WHERE ai.scene_id = $1 ORDER BY ls.position, ai.position, ai.created_at`,
      [sceneId],
    );
    rows.forEach((row, index) => {
      writeRow(sheets.Equipment, index + 2, [
        row.id,
        row.kind,
        row.definition_key,
        row.definition_version,
        row.station_name,
        row.position_m_x,
        row.position_m_y,
        row.position_m_z,
        row.capabilities.join(', '),
        JSON.stringify(row.config),
      ]);
    });
    counts.Equipment = rows.length;
    const definitionKeys = [...new Set(rows.map((r) => r.definition_key))];
    if (definitionKeys.length > 0) {
      const defSources = await db.query<{ source_id: number }>(
        'SELECT DISTINCT ON (key) source_id FROM apparatus_definition_version WHERE key = ANY($1) ORDER BY key, version DESC',
        [definitionKeys],
      );
      for (const d of defSources) referencedSourceIds.add(d.source_id);
    }
  }

  // Stations
  {
    addHeader(sheets.Stations, [{ header: 'Station id' }, { header: 'Name', width: 30 }, { header: 'Position', width: 10 }]);
    const rows = await db.query<{ id: string; name: string; position: number }>('SELECT id, name, position FROM lab_station WHERE scene_id = $1 ORDER BY position', [sceneId]);
    rows.forEach((row, index) => writeRow(sheets.Stations, index + 2, [row.id, row.name, row.position]));
    counts.Stations = rows.length;
  }

  // Connections
  {
    addHeader(sheets.Connections, [
      { header: 'Connection id' },
      { header: 'Kind' },
      { header: 'From apparatus id' },
      { header: 'From socket' },
      { header: 'To apparatus id' },
      { header: 'To socket' },
      { header: 'Enabled', width: 10 },
    ]);
    const rows = await db.query<{ id: string; kind: string; from_instance_id: string; from_socket_id: string; to_instance_id: string; to_socket_id: string; enabled: boolean }>(
      'SELECT id, kind, from_instance_id, from_socket_id, to_instance_id, to_socket_id, enabled FROM apparatus_connection WHERE scene_id = $1',
      [sceneId],
    );
    rows.forEach((row, index) =>
      writeRow(sheets.Connections, index + 2, [row.id, row.kind, row.from_instance_id, row.from_socket_id, row.to_instance_id, row.to_socket_id, row.enabled]),
    );
    counts.Connections = rows.length;
  }

  // Conditions
  {
    addHeader(sheets.Conditions, [
      { header: 'Apparatus id' },
      { header: 'Kind' },
      { header: 'Volume (L)', width: 14 },
      { header: 'Temperature (K)', width: 16 },
      { header: 'Mixing' },
      { header: 'Model id', width: 28 },
      { header: 'Species (mol)', width: 40 },
    ]);
    const rows = await db.query<{
      apparatus_instance_id: string;
      kind: string;
      volume_l: number;
      temperature_k: number;
      mixing: string;
      model_id: string;
      species: { speciesId: string; moles: number }[];
    }>(
      `SELECT cs.apparatus_instance_id, ai.kind, cs.volume_l, cs.temperature_k, cs.mixing, cs.model_id, cs.species
       FROM container_state cs JOIN apparatus_instance ai ON ai.id = cs.apparatus_instance_id WHERE cs.scene_id = $1`,
      [sceneId],
    );
    rows.forEach((row, index) =>
      writeRow(sheets.Conditions, index + 2, [row.apparatus_instance_id, row.kind, row.volume_l, row.temperature_k, row.mixing, row.model_id, speciesText(row.species)]),
    );
    counts.Conditions = rows.length;
    const speciesIds = [...new Set(rows.flatMap((r) => r.species.map((s) => s.speciesId)))];
    if (speciesIds.length > 0) {
      const reagentSources = await db.query<{ source_id: number }>('SELECT source_id FROM lab_reagent WHERE species_id = ANY($1)', [speciesIds]);
      for (const r of reagentSources) referencedSourceIds.add(r.source_id);
    }
  }

  // Trial Measurements (one row per run)
  {
    addHeader(sheets['Trial Measurements'], [
      { header: 'Run id' },
      { header: 'Status' },
      { header: 'Method id', width: 44 },
      { header: 'Method version', width: 14 },
      { header: 'Scene revision at run', width: 16 },
      { header: 'Observation count', width: 14 },
      { header: 'Created at (UTC)', width: 22 },
      { header: 'Started at (UTC)', width: 22 },
      { header: 'Finished at (UTC)', width: 22 },
      { header: 'Failure code', width: 20 },
      { header: 'Failure message', width: 40 },
    ]);
    const rows = await db.query<{
      id: string;
      status: string;
      method_id: string;
      method_version: string;
      scene_revision: number;
      observation_count: string;
      created_at: Date;
      started_at: Date | null;
      finished_at: Date | null;
      failure_code: string | null;
      failure_message: string | null;
    }>(
      `SELECT r.id, r.status, r.method_id, r.method_version, r.scene_revision, r.created_at, r.started_at, r.finished_at, r.failure_code, r.failure_message,
              (SELECT count(*) FROM lab_observation o WHERE o.run_id = r.id) AS observation_count
       FROM lab_run r WHERE r.scene_id = $1 ORDER BY r.created_at`,
      [sceneId],
    );
    rows.forEach((row, index) =>
      writeRow(sheets['Trial Measurements'], index + 2, [
        row.id,
        row.status,
        row.method_id,
        row.method_version,
        row.scene_revision,
        Number(row.observation_count),
        row.created_at.toISOString(),
        row.started_at?.toISOString() ?? null,
        row.finished_at?.toISOString() ?? null,
        row.failure_code,
        row.failure_message,
      ]),
    );
    counts['Trial Measurements'] = rows.length;
  }

  // Titration Curve (paired VOLUME/PH observations sharing a run and timestamp)
  {
    addHeader(sheets['Titration Curve'], [
      { header: 'Run id' },
      { header: 'Time (s)', width: 12 },
      { header: 'Delivered volume (L)', width: 18 },
      { header: 'pH', width: 10 },
      { header: 'Evidence', width: 20 },
    ]);
    const rows = await db.query<{ run_id: string; time_s: number; delivered_volume_l: number; ph: number; evidence: string }>(
      `SELECT v.run_id, v.time_s, v.value AS delivered_volume_l, p.value AS ph, p.evidence
       FROM lab_observation v JOIN lab_observation p ON p.run_id = v.run_id AND p.time_s = v.time_s AND p.type = 'PH'
       WHERE v.scene_id = $1 AND v.type = 'VOLUME' ORDER BY v.run_id, v.time_s`,
      [sceneId],
    );
    rows.forEach((row, index) => writeRow(sheets['Titration Curve'], index + 2, [row.run_id, row.time_s, row.delivered_volume_l, row.ph, row.evidence]));
    counts['Titration Curve'] = rows.length;
  }

  // Observations (full ledger)
  {
    addHeader(sheets.Observations, [
      { header: 'Run id' },
      { header: 'Sequence', width: 10 },
      { header: 'Type' },
      { header: 'Apparatus id' },
      { header: 'Time (s)', width: 12 },
      { header: 'Value', width: 14 },
      { header: 'Unit', width: 10 },
      { header: 'Uncertainty', width: 14 },
      { header: 'Evidence', width: 20 },
      { header: 'Method id', width: 44 },
      { header: 'Source ids', width: 40 },
    ]);
    const rows = await db.query<{
      run_id: string;
      sequence: number;
      type: string;
      apparatus_instance_id: string | null;
      time_s: number;
      value: number;
      unit: string;
      uncertainty: number | null;
      evidence: string;
      method_id: string;
      source_ids: string[];
    }>(
      'SELECT run_id, sequence, type, apparatus_instance_id, time_s, value, unit, uncertainty, evidence, method_id, source_ids FROM lab_observation WHERE scene_id = $1 ORDER BY run_id, sequence',
      [sceneId],
    );
    rows.forEach((row, index) =>
      writeRow(sheets.Observations, index + 2, [
        row.run_id,
        row.sequence,
        row.type,
        row.apparatus_instance_id,
        row.time_s,
        row.value,
        row.unit,
        row.uncertainty,
        row.evidence,
        row.method_id,
        row.source_ids.join(', '),
      ]),
    );
    counts.Observations = rows.length;
  }

  // Sources (every data_sources row referenced above)
  {
    addHeader(sheets.Sources, [
      { header: 'Key', width: 30 },
      { header: 'Version', width: 20 },
      { header: 'Kind', width: 16 },
      { header: 'Title', width: 40 },
      { header: 'URL', width: 36 },
      { header: 'Retrieved (ISO date)', width: 18 },
      { header: 'License', width: 24 },
    ]);
    const ids = [...referencedSourceIds];
    const rows = ids.length
      ? await db.query<{ key: string; version: string; kind: string; title: string; url: string | null; retrieved_on: string | null; license: string | null }>(
          'SELECT key, version, kind, title, url, retrieved_on, license FROM data_sources WHERE id = ANY($1) ORDER BY key, version',
          [ids],
        )
      : [];
    rows.forEach((row, index) => writeRow(sheets.Sources, index + 2, [row.key, row.version, row.kind, row.title, row.url, row.retrieved_on, row.license]));
    counts.Sources = rows.length;
  }

  for (const sheet of Object.values(sheets)) {
    if (sheet.rowCount > 1) sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columnCount } };
  }

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    summary: { sceneId, sheets: counts, exportedAt: new Date().toISOString() },
  };
}
