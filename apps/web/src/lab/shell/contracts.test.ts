import { describe, expect, it } from 'vitest';
import type { ApparatusInstance, ExperimentScene, Observation, RunResult } from './contracts';
import { deriveTitrationHudData, pairVolumeAndPh } from './contracts';

const STATION = 'station-1';

function burette(id: string, capacityL: number): ApparatusInstance {
  return { id, kind: 'BURETTE', definitionId: 'burette.graduated.50ml', transform: { positionM: [0, 0, 0], quaternion: [0, 0, 0, 1] }, revision: 1, config: { capacityL }, capabilities: ['CONTAINER', 'FLOW_SOURCE'], stationId: STATION };
}

function scene(apparatus: ExperimentScene['apparatus'], containerStates: ExperimentScene['containerStates'] = {}): ExperimentScene {
  return {
    id: 'scene-1',
    revision: 1,
    schemaVersion: 1,
    stations: [{ id: STATION, name: 'Station 1' }],
    apparatus,
    connections: [],
    containerStates,
    simulationConfig: { methodId: 'strong-acid-strong-base-equilibrium', timeStepS: 0.1 },
  };
}

function runResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    runId: 'run-1',
    status: 'SUCCEEDED',
    methodId: 'method-1',
    methodVersion: '1.0.0',
    inputHash: 'hash-1',
    observations: [],
    warnings: [],
    assumptions: [],
    ...overrides,
  };
}

describe('deriveTitrationHudData', () => {
  it('is honestly disconnected when there is no scene at all', () => {
    const data = deriveTitrationHudData(null, null, null);
    expect(data.connectionStatus).toBe('disconnected');
    expect(data.ph).toBeNull();
    expect(data.deliveredVolumeL).toBeNull();
    expect(data.warnings).toEqual([]);
  });

  it('reports UNSUPPORTED runs explicitly, without inventing a reading', () => {
    const run = runResult({ status: 'UNSUPPORTED', warnings: ['No validated model for this mixture.'] });
    const data = deriveTitrationHudData(scene([]), run, []);
    expect(data.connectionStatus).toBe('unsupported');
    expect(data.ph).toBeNull();
    expect(data.warnings).toEqual(['No validated model for this mixture.']);
  });

  it('picks the latest observation of each type by simulation time, not array order', () => {
    const observations: Observation[] = [
      { type: 'PH', timeS: 10, quantity: { value: 7.1, unit: 'pH' }, evidence: 'MODEL_CALCULATED', methodId: 'm', sourceIds: ['a'] },
      { type: 'PH', timeS: 2, quantity: { value: 2.0, unit: 'pH' }, evidence: 'MODEL_CALCULATED', methodId: 'm', sourceIds: ['a'] },
      { type: 'VOLUME', timeS: 10, quantity: { value: 0.012, unit: 'L' }, evidence: 'MODEL_CALCULATED', methodId: 'm', sourceIds: ['a'] },
    ];
    const data = deriveTitrationHudData(scene([]), runResult({ observations }), observations);
    expect(data.connectionStatus).toBe('ready');
    expect(data.ph?.value).toBe(7.1);
    expect(data.phEvidence).toBe('MODEL_CALCULATED');
    expect(data.deliveredVolumeL).toBeCloseTo(0.012);
  });

  it('reads burette remaining volume and capacity from the container state and apparatus config', () => {
    const b = burette('burette-1', 0.05);
    const data = deriveTitrationHudData(scene([b], { 'burette-1': { volumeL: 0.0231, species: [], temperatureK: 298.15, mixing: 'WELL_MIXED', modelId: 'm' } }), runResult(), []);
    expect(data.buretteRemainingL).toBeCloseTo(0.0231);
    expect(data.buretteCapacityL).toBeCloseTo(0.05);
  });

  it('reads equivalence and endpoint volumes only from solverDiagnostics, never computing them', () => {
    const run = runResult({ solverDiagnostics: { equivalenceVolumeL: 0.025, endpointVolumeL: 0.0252 } });
    const data = deriveTitrationHudData(scene([]), run, []);
    expect(data.equivalenceVolumeL).toBeCloseTo(0.025);
    expect(data.endpointVolumeL).toBeCloseTo(0.0252);
  });

  it('leaves equivalence/endpoint null when solverDiagnostics does not carry them', () => {
    const data = deriveTitrationHudData(scene([]), runResult({ solverDiagnostics: { somethingElse: 1 } }), []);
    expect(data.equivalenceVolumeL).toBeNull();
    expect(data.endpointVolumeL).toBeNull();
  });

  it('deduplicates source ids across observations', () => {
    const observations: Observation[] = [
      { type: 'PH', timeS: 1, quantity: { value: 7, unit: 'pH' }, evidence: 'MODEL_CALCULATED', methodId: 'm', sourceIds: ['solver-a'] },
      { type: 'VOLUME', timeS: 1, quantity: { value: 0.01, unit: 'L' }, evidence: 'MODEL_CALCULATED', methodId: 'm', sourceIds: ['solver-a', 'solver-b'] },
    ];
    const data = deriveTitrationHudData(scene([]), runResult({ observations }), observations);
    expect([...data.sourceIds].sort()).toEqual(['solver-a', 'solver-b']);
  });
});

describe('pairVolumeAndPh', () => {
  it('pairs VOLUME and PH observations that share a simulation time, sorted by volume', () => {
    const observations: Observation[] = [
      { type: 'VOLUME', timeS: 5, quantity: { value: 0.02, unit: 'L' }, evidence: 'MODEL_CALCULATED', methodId: 'm', sourceIds: [] },
      { type: 'PH', timeS: 5, quantity: { value: 9.5, unit: 'pH' }, evidence: 'MODEL_CALCULATED', methodId: 'm', sourceIds: [] },
      { type: 'VOLUME', timeS: 1, quantity: { value: 0.0, unit: 'L' }, evidence: 'MODEL_CALCULATED', methodId: 'm', sourceIds: [] },
      { type: 'PH', timeS: 1, quantity: { value: 1.2, unit: 'pH' }, evidence: 'MODEL_CALCULATED', methodId: 'm', sourceIds: [] },
    ];
    expect(pairVolumeAndPh(observations)).toEqual([
      { volumeL: 0.0, ph: 1.2 },
      { volumeL: 0.02, ph: 9.5 },
    ]);
  });

  it('drops a VOLUME observation that has no matching PH at the same time, rather than guessing one', () => {
    const observations: Observation[] = [
      { type: 'VOLUME', timeS: 1, quantity: { value: 0.01, unit: 'L' }, evidence: 'MODEL_CALCULATED', methodId: 'm', sourceIds: [] },
      { type: 'TEMPERATURE', timeS: 1, quantity: { value: 298, unit: 'K' }, evidence: 'MODEL_CALCULATED', methodId: 'm', sourceIds: [] },
    ];
    expect(pairVolumeAndPh(observations)).toEqual([]);
  });

  it('returns an empty array for no observations', () => {
    expect(pairVolumeAndPh([])).toEqual([]);
  });
});
