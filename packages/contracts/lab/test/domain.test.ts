import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  apparatusInstanceSchema,
  containerContentsSchema,
  experimentSceneSchema,
  labActionSchema,
  observationSchema,
  runResultSchema,
  type ExperimentScene,
} from '../src/domain.js';
import { equipmentDefinitionSchema } from '../src/equipment.js';
import { problemDetailsSchema, runCreateRequestSchema, sceneCreateRequestSchema, sceneRecordSchema } from '../src/api.js';

function uuid(): string {
  return randomUUID();
}

describe('ExperimentScene contract', () => {
  it('accepts the shared contract vertical-slice scenario (25.00 mL 0.100 mol/L HCl vs 0.100 mol/L NaOH)', () => {
    const stationId = uuid();
    const flaskId = uuid();
    const buretteId = uuid();

    const scene: ExperimentScene = {
      id: uuid(),
      revision: 1,
      schemaVersion: 1,
      stations: [{ id: stationId, name: 'Station 1' }],
      apparatus: [
        {
          id: flaskId,
          kind: 'FLASK',
          definitionId: 'erlenmeyer-flask-250ml',
          transform: { positionM: [0, 0.9, 0], quaternion: [0, 0, 0, 1] },
          revision: 1,
          config: {},
          capabilities: ['CONTAINER', 'FLOW_RECEIVER'],
          stationId,
        },
        {
          id: buretteId,
          kind: 'BURETTE',
          definitionId: 'burette-50ml',
          transform: { positionM: [0, 1.4, 0], quaternion: [0, 0, 0, 1] },
          revision: 1,
          config: { valveOpenFraction: 0 },
          capabilities: ['CONTAINER', 'FLOW_SOURCE'],
          stationId,
        },
      ],
      connections: [],
      containerStates: {
        [flaskId]: { volumeL: 0.025, species: [{ speciesId: 'HCl(aq)', moles: 0.1 * 0.025 }], temperatureK: 298.15, mixing: 'WELL_MIXED', modelId: 'ideal-well-mixed-v1' },
        [buretteId]: { volumeL: 0.05, species: [{ speciesId: 'NaOH(aq)', moles: 0.1 * 0.05 }], temperatureK: 298.15, mixing: 'WELL_MIXED', modelId: 'ideal-well-mixed-v1' },
      },
      simulationConfig: { methodId: 'fixed-tick-v1', timeStepS: 0.1 },
    };

    expect(experimentSceneSchema.parse(scene)).toEqual(scene);
  });

  it('rejects a scene missing the fixed schemaVersion literal', () => {
    const result = experimentSceneSchema.safeParse({
      id: uuid(),
      revision: 1,
      schemaVersion: 2,
      stations: [],
      apparatus: [],
      connections: [],
      containerStates: {},
      simulationConfig: { methodId: 'x', timeStepS: 0.1 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an apparatus instance with an unknown capability', () => {
    const result = apparatusInstanceSchema.safeParse({
      id: uuid(),
      kind: 'FLASK',
      definitionId: 'erlenmeyer-flask-250ml',
      transform: { positionM: [0, 0, 0], quaternion: [0, 0, 0, 1] },
      revision: 0,
      config: {},
      capabilities: ['NOT_A_CAPABILITY'],
      stationId: uuid(),
    });
    expect(result.success).toBe(false);
  });

  it('rejects negative container volume (would violate conservation)', () => {
    const result = containerContentsSchema.safeParse({
      volumeL: -1,
      species: [],
      temperatureK: 298.15,
      mixing: 'WELL_MIXED',
      modelId: 'ideal-well-mixed-v1',
    });
    expect(result.success).toBe(false);
  });

  it('round-trips a TRANSFER LabAction', () => {
    const action = {
      actionId: uuid(),
      atSimulationS: 12.5,
      targetInstanceId: uuid(),
      type: 'TRANSFER' as const,
      payload: { deliveredVolumeL: 0.0005 },
    };
    expect(labActionSchema.parse(action)).toEqual(action);
  });

  it('round-trips a PH Observation with MODEL_CALCULATED evidence', () => {
    const observation = {
      type: 'PH' as const,
      timeS: 12.5,
      quantity: { value: 7.01, unit: 'pH' },
      evidence: 'MODEL_CALCULATED' as const,
      methodId: 'titration.strong_acid_strong_base.charge_balance.v1',
      sourceIds: ['titration.strong_acid_strong_base.charge_balance.v1'],
    };
    expect(observationSchema.parse(observation)).toEqual(observation);
  });

  it('round-trips a RunResult with an UNSUPPORTED status and no observations', () => {
    const run = {
      runId: uuid(),
      status: 'UNSUPPORTED' as const,
      methodId: 'titration.strong_acid_strong_base.charge_balance.v1',
      methodVersion: '1.0.0',
      inputHash: 'deadbeef',
      observations: [],
      warnings: [],
      assumptions: [],
    };
    expect(runResultSchema.parse(run)).toEqual(run);
  });
});

describe('equipment and API envelopes', () => {
  it('accepts a minimal equipment definition', () => {
    const definition = {
      key: 'burette-50ml',
      kind: 'BURETTE' as const,
      version: 1,
      name: '50 mL burette',
      capabilities: ['CONTAINER', 'FLOW_SOURCE'] as const,
      sockets: [{ id: 'tip', kind: 'FLUID' as const }],
      capacity: { value: 0.05, unit: 'L' },
      controlActions: ['SET_VALVE'],
      defaultConfig: { valveOpenFraction: 0 },
      evidence: 'UNVERIFIED' as const,
    };
    expect(equipmentDefinitionSchema.parse(definition)).toMatchObject(definition);
  });

  it('defaults sceneCreateRequestSchema stations/apparatus/connections to empty arrays', () => {
    const parsed = sceneCreateRequestSchema.parse({ title: 'Blank station' });
    expect(parsed.stations).toEqual([]);
    expect(parsed.apparatus).toEqual([]);
    expect(parsed.connections).toEqual([]);
    expect(parsed.simulationConfig).toEqual({ methodId: 'fixed-tick-v1', timeStepS: 0.1 });
  });

  it('requires sceneRecordSchema timestamps and ownerId even though the domain scene does not have them', () => {
    const result = sceneRecordSchema.safeParse({
      id: uuid(),
      revision: 1,
      schemaVersion: 1,
      stations: [],
      apparatus: [],
      connections: [],
      containerStates: {},
      simulationConfig: { methodId: 'x', timeStepS: 0.1 },
      title: 'Untitled',
    });
    expect(result.success).toBe(false);
  });

  it('builds a valid RFC 9457 problem details body for a revision conflict', () => {
    const problem = {
      type: 'https://matterlab.dev/problems/revision-conflict',
      title: 'Revision conflict',
      status: 409,
      detail: 'The scene is at revision 3, not 2; it was changed since you loaded it.',
      code: 'revision_conflict',
    };
    expect(problemDetailsSchema.parse(problem)).toEqual(problem);
  });

  it('defaults runCreateRequestSchema actions/settings', () => {
    const parsed = runCreateRequestSchema.parse({ methodId: 'titration.strong_acid_strong_base.charge_balance.v1' });
    expect(parsed.actions).toEqual([]);
    expect(parsed.settings).toEqual({});
  });
});
