import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../src/context.js';
import { closeContext } from '../src/context.js';
import { authed, buildTestContext, testApp } from './helpers.js';

describe('scene export (Excel and JSON)', () => {
  let ctx: AppContext;
  let app: ReturnType<typeof testApp>;

  beforeAll(async () => {
    ctx = await buildTestContext();
    app = testApp(ctx);
  });

  afterAll(async () => {
    await closeContext(ctx);
  });

  async function createTitrationScene(stationName: string) {
    const stationId = randomUUID();
    const flaskId = randomUUID();
    const buretteId = randomUUID();
    const body = {
      title: `Export test ${randomUUID()}`,
      stations: [{ id: stationId, name: stationName }],
      apparatus: [
        {
          id: flaskId,
          kind: 'FLASK',
          definitionId: 'erlenmeyer-flask-250ml',
          transform: { positionM: [0, 0.1, 0.2], quaternion: [0, 0, 0, 1] },
          revision: 0,
          config: {},
          capabilities: ['CONTAINER', 'FLOW_RECEIVER'],
          stationId,
        },
        {
          id: buretteId,
          kind: 'BURETTE',
          definitionId: 'burette-50ml',
          transform: { positionM: [0, 0.5, 0.2], quaternion: [0, 0, 0, 1] },
          revision: 0,
          config: { valveOpenFraction: 0 },
          capabilities: ['CONTAINER', 'FLOW_SOURCE'],
          stationId,
        },
      ],
      connections: [{ id: randomUUID(), from: { instanceId: buretteId, socketId: 'tip' }, to: { instanceId: flaskId, socketId: 'opening' }, kind: 'FLUID', enabled: true }],
      containerStates: {
        [flaskId]: { volumeL: 0.025, species: [{ speciesId: 'HCl(aq)', moles: 0.0025 }], temperatureK: 298.15, mixing: 'WELL_MIXED', modelId: 'ideal-well-mixed-v1' },
        [buretteId]: { volumeL: 0.05, species: [{ speciesId: 'NaOH(aq)', moles: 0.005 }], temperatureK: 298.15, mixing: 'WELL_MIXED', modelId: 'ideal-well-mixed-v1' },
      },
      simulationConfig: { methodId: 'fixed-tick-v1', timeStepS: 0.1 },
    };
    const created = await authed(app.post('/api/v1/lab/scenes')).send(body);
    const runResponse = await authed(app.post(`/api/v1/lab/scenes/${created.body.id}/runs`)).send({
      methodId: 'titration.strong_acid_strong_base.charge_balance.v1',
      actions: [{ actionId: randomUUID(), atSimulationS: 1, targetInstanceId: flaskId, type: 'TRANSFER', payload: { sourceInstanceId: buretteId, deliveredVolumeL: 0.005 } }],
    });
    const deadline = Date.now() + 10_000;
    for (;;) {
      const run = await authed(app.get(`/api/v1/lab/runs/${runResponse.body.runId}`));
      if (['SUCCEEDED', 'FAILED', 'UNSUPPORTED', 'CANCELLED'].includes(run.body.status)) break;
      if (Date.now() > deadline) throw new Error('run did not finish in time');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { sceneId: created.body.id as string, body };
  }

  it('JSON export round-trips the exact scene state', async () => {
    const { sceneId, body } = await createTitrationScene('Station 1');
    const exported = await authed(app.get(`/api/v1/lab/scenes/${sceneId}/export`)).query({ format: 'json' });
    expect(exported.status).toBe(200);
    expect(exported.body.stations).toEqual(body.stations);
    expect(exported.body.apparatus).toEqual(body.apparatus);
    expect(exported.body.connections).toEqual(body.connections);
    expect(exported.body.containerStates).toEqual(body.containerStates);

    // The export is accepted back as a new scene's create body. Station/apparatus/connection ids
    // are global primary keys, so a faithful "import this JSON as a new scene" remaps them first
    // (exactly like POST .../duplicate does internally) rather than re-using the exported ids.
    const idMap = new Map<string, string>();
    const remapId = (id: string): string => {
      if (!idMap.has(id)) idMap.set(id, randomUUID());
      return idMap.get(id)!;
    };
    const remappedStations = (exported.body.stations as { id: string; name: string }[]).map((s) => ({ ...s, id: remapId(s.id) }));
    const remappedApparatus = (exported.body.apparatus as Record<string, unknown>[]).map((a) => ({ ...a, id: remapId(a.id as string), stationId: remapId(a.stationId as string) }));
    const remappedConnections = (exported.body.connections as { id: string; from: { instanceId: string; socketId: string }; to: { instanceId: string; socketId: string } }[]).map((c) => ({
      ...c,
      id: randomUUID(),
      from: { ...c.from, instanceId: remapId(c.from.instanceId) },
      to: { ...c.to, instanceId: remapId(c.to.instanceId) },
    }));
    const remappedContainerStates = Object.fromEntries(Object.entries(exported.body.containerStates as Record<string, unknown>).map(([id, contents]) => [remapId(id), contents]));

    const reimported = await authed(app.post('/api/v1/lab/scenes')).send({
      title: 'Reimported',
      stations: remappedStations,
      apparatus: remappedApparatus,
      connections: remappedConnections,
      containerStates: remappedContainerStates,
      simulationConfig: exported.body.simulationConfig,
    });
    expect(reimported.status).toBe(201);
    expect(reimported.body.apparatus.map((a: { kind: string; definitionId: string }) => ({ kind: a.kind, definitionId: a.definitionId }))).toEqual(
      exported.body.apparatus.map((a: { kind: string; definitionId: string }) => ({ kind: a.kind, definitionId: a.definitionId })),
    );
    expect(Object.values(reimported.body.containerStates)).toEqual(Object.values(exported.body.containerStates));
  });

  it('Excel export has the required sheets, correct numeric types, and never turns formula-like text into a real formula', async () => {
    const maliciousStationName = '=1+1';
    const { sceneId } = await createTitrationScene(maliciousStationName);
    const exported = await authed(app.get(`/api/v1/lab/scenes/${sceneId}/export`)).query({ format: 'xlsx' }).responseType('blob').buffer(true);
    expect(exported.status).toBe(200);
    expect(exported.headers['content-type']).toContain('spreadsheetml');
    expect(exported.headers['content-disposition']).toContain('.xlsx');

    const workbook = new ExcelJS.Workbook();
    // exceljs's bundled .d.ts redeclares a global `Buffer extends ArrayBuffer` that conflicts with
    // @types/node's real Buffer (a Uint8Array subclass); `any` sidesteps that upstream type bug.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await workbook.xlsx.load(Buffer.from(exported.body as Buffer) as any);
    const sheetNames = workbook.worksheets.map((s) => s.name);
    expect(sheetNames).toEqual(['Equipment', 'Stations', 'Connections', 'Conditions', 'Trial Measurements', 'Titration Curve', 'Observations', 'Sources']);

    // No cell anywhere in the workbook is an actual formula (type 6 in exceljs' ValueType enum):
    // this API never constructs a `{ formula }` cell value from exported data.
    for (const sheet of workbook.worksheets) {
      sheet.eachRow((row) => {
        row.eachCell((cell) => {
          expect(cell.type).not.toBe(ExcelJS.ValueType.Formula);
        });
      });
    }

    const stations = workbook.getWorksheet('Stations')!;
    const nameHeaderCol = stations.getRow(1).values as unknown[];
    const nameColIndex = nameHeaderCol.findIndex((v) => v === 'Name');
    const stationNameCell = stations.getRow(2).getCell(nameColIndex);
    // Stored as a literal string (and additionally neutralised with a leading apostrophe for defence in depth).
    expect(typeof stationNameCell.value).toBe('string');
    expect(stationNameCell.value).toBe(`'${maliciousStationName}`);

    const conditions = workbook.getWorksheet('Conditions')!;
    const volumeHeaderRow = conditions.getRow(1).values as unknown[];
    const volumeColIndex = volumeHeaderRow.findIndex((v) => typeof v === 'string' && v.startsWith('Volume'));
    expect(typeof conditions.getRow(2).getCell(volumeColIndex).value).toBe('number');

    const titrationCurve = workbook.getWorksheet('Titration Curve')!;
    expect(titrationCurve.rowCount).toBeGreaterThan(1); // header + at least one computed point
  });

  it('404s exporting an unknown scene', async () => {
    const response = await authed(app.get(`/api/v1/lab/scenes/${randomUUID()}/export`)).query({ format: 'json' });
    expect(response.status).toBe(404);
  });
});
