import type {
  ApparatusDefinition, ApparatusInstance, ContainerContents, ExperimentScene, NodeRunRequest, RuntimeCheckpoint,
} from '../src/index.ts';

export const id = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
export const solution = (volumeL: number, speciesId: string, moles: number): ContainerContents => ({
  volumeL, species: [{ speciesId, moles, sourceId: 'test-fixture' }],
  temperatureK: 298.15, mixing: 'WELL_MIXED', modelId: 'aqueous-acid-base-ideal-v1',
});
export function sceneFixture(): ExperimentScene {
  const vessel = (n: number, station: number, source: boolean): ApparatusInstance => ({
    id: id(n), stationId: id(station), kind: source ? 'BURETTE' : 'FLASK',
    definitionId: source ? 'test-burette' : 'test-flask', revision: 0,
    transform: { positionM: [0, 0.9, 0], quaternion: [0, 0, 0, 1] }, config: {},
    capabilities: ['CONTAINER', source ? 'FLOW_SOURCE' : 'FLOW_RECEIVER'],
  });
  return {
    id: id(1), revision: 3, schemaVersion: 1,
    stations: [{ id: id(2), name: 'Station A' }, { id: id(3), name: 'Station B' }],
    apparatus: [vessel(4, 2, true), vessel(5, 2, false), vessel(6, 3, true), vessel(7, 3, false)],
    connections: [
      { id: id(8), from: { instanceId: id(4), socketId: 'out' }, to: { instanceId: id(5), socketId: 'in' }, kind: 'FLUID', enabled: true },
      { id: id(9), from: { instanceId: id(6), socketId: 'out' }, to: { instanceId: id(7), socketId: 'in' }, kind: 'FLUID', enabled: true },
    ],
    containerStates: {
      [id(4)]: solution(0.05, 'ion:sodium', 0.005), [id(5)]: solution(0.025, 'ion:chloride', 0.0025),
      [id(6)]: solution(0.05, 'ion:sodium', 0.005), [id(7)]: solution(0.025, 'ion:chloride', 0.0025),
    },
    simulationConfig: { methodId: 'aqueous-acid-base-ideal-v1', timeStepS: 0.1 },
    viewport: { mode: 'orbit', positionM: [1, 2, 3] },
  };
}
export function requestFixture(): NodeRunRequest {
  return {
    schemaVersion: 1, runId: id(10), contractVersion: '1.0.0', runtimeVersion: '1.0.0', methodVersion: '1.0.0',
    initialScene: sceneFixture(),
    steps: [{
      kind: 'ACTION',
      action: {
        actionId: id(11), atSimulationS: 0, targetInstanceId: id(4), type: 'TRANSFER',
        payload: { sourceInstanceId: id(4), targetInstanceId: id(5), volumeL: 0.001, connectionId: id(8) },
      },
    }],
  };
}
export function checkpointFixture(): RuntimeCheckpoint {
  const initialScene = sceneFixture();
  return {
    schemaVersion: 1, contractVersion: '1.0.0', runtimeVersion: '1.0.0', methodVersion: '1.0.0',
    inputHash: 'a'.repeat(64), initialScene,
    snapshot: {
      schemaVersion: 1, runId: id(10), revision: 0, scene: initialScene,
      stationStates: Object.fromEntries(initialScene.stations.map((station) => [station.id, {
        stationId: station.id, epoch: 0, status: 'PREPARING' as const, simulationTimeS: 0, tick: 0, speed: 1,
      }])),
      apparatusStates: {}, transferTotals: [], observations: [], lastSequence: 0,
    },
    steps: [], completedStepCount: 0, events: [],
  };
}
export function apparatusFixture(): ApparatusDefinition {
  return {
    id: 'test-calibrated-vessel', version: '1.0.0', schemaVersion: 1, kind: 'BEAKER',
    label: 'Test-only vessel', category: 'glassware', capabilities: ['CONTAINER', 'FLOW_RECEIVER'],
    dimensionsM: [0.1, 0.2, 0.1], boundsM: { min: [-0.05, 0, -0.05], max: [0.05, 0.2, 0.05] },
    permittedTransforms: { translation: ['X', 'Y', 'Z'], rotation: ['Y'] },
    sockets: [{
      id: 'in', kind: 'FLUID', localTransform: { positionM: [0, 0.2, 0], quaternion: [0, 0, 0, 1] },
      direction: 'IN', gender: 'NEUTRAL', compatibility: { key: 'test-liquid', accepts: ['test-liquid'] }, maxConnections: 1,
    }],
    controls: [{ id: 'fill', label: 'Prepare', actionType: 'FILL', fields: { volumeL: { type: 'number', unit: 'L', minimum: 0, maximum: 0.25 } } }],
    configSchema: {
      type: 'object', properties: { labeled: { type: 'boolean', default: true } },
      required: ['labeled'], additionalProperties: false,
    },
    defaultConfig: { labeled: true }, capacityL: 0.25,
    vesselCalibration: {
      capacityL: 0.25, maxFillHeightM: 0.15, interiorProfile: [{ yM: 0.01, radiusM: 0.03 }, { yM: 0.18, radiusM: 0.04 }],
      volumeHeightCurve: [{ volumeL: 0, heightM: 0.01 }, { volumeL: 0.125, heightM: 0.09 }, { volumeL: 0.25, heightM: 0.15 }],
      graduations: { minorStepL: 0.01, majorStepL: 0.05, startHeightM: 0.01, endHeightM: 0.15, reading: 'CONTAINED', direction: 'UP' },
      meniscus: { reference: 'BOTTOM', offsetM: 0 }, evidence: 'ILLUSTRATIVE', sourceIds: ['test-fixture'], assumptions: ['Test-only calibration, not a measured instrument.'],
    },
  };
}
