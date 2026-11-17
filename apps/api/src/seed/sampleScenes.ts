/**
 * Sample seed scenes: one titration station (apparatus placed, initial inventories only - no
 * computed pH, no run, no observations) and one blank station. Never ships a fake scientific
 * result: the curve the user sees comes only from a real POST .../runs call against this state.
 */
import { randomUUID } from 'node:crypto';
import type { SceneCreateRequest } from '@matterlab/contracts-lab';

const IDENTITY_QUATERNION: [number, number, number, number] = [0, 0, 0, 1];

export function buildTitrationStationScene(): SceneCreateRequest {
  const stationId = randomUUID();
  const benchId = randomUUID();
  const standId = randomUUID();
  const clampId = randomUUID();
  const buretteId = randomUUID();
  const flaskId = randomUUID();
  const stirrerId = randomUUID();
  const probeId = randomUUID();

  return {
    title: 'Titration Station (seed)',
    stations: [{ id: stationId, name: 'Titration Station' }],
    apparatus: [
      {
        id: benchId,
        kind: 'BENCH',
        definitionId: 'bench-standard',
        transform: { positionM: [0, 0, 0], quaternion: IDENTITY_QUATERNION },
        revision: 0,
        config: {},
        capabilities: ['MOUNT'],
        stationId,
      },
      {
        id: standId,
        kind: 'STAND',
        definitionId: 'stand-standard',
        transform: { positionM: [0.5, 0, 0], quaternion: IDENTITY_QUATERNION },
        revision: 0,
        config: {},
        capabilities: ['MOUNT', 'MOUNTABLE'],
        stationId,
      },
      {
        id: clampId,
        kind: 'CLAMP',
        definitionId: 'clamp-standard',
        transform: { positionM: [0.5, 0.45, 0], quaternion: IDENTITY_QUATERNION },
        revision: 0,
        config: { jawOpenFraction: 0.3 },
        capabilities: ['MOUNT', 'MOUNTABLE'],
        stationId,
      },
      {
        id: buretteId,
        kind: 'BURETTE',
        definitionId: 'burette-50ml',
        transform: { positionM: [0.5, 0.55, 0], quaternion: IDENTITY_QUATERNION },
        revision: 0,
        config: { valveOpenFraction: 0 },
        capabilities: ['CONTAINER', 'FLOW_SOURCE', 'MOUNTABLE'],
        stationId,
      },
      {
        id: flaskId,
        kind: 'FLASK',
        definitionId: 'erlenmeyer-flask-250ml',
        transform: { positionM: [0.5, 0.05, 0.15], quaternion: IDENTITY_QUATERNION },
        revision: 0,
        config: {},
        capabilities: ['CONTAINER', 'FLOW_RECEIVER'],
        stationId,
      },
      {
        id: stirrerId,
        kind: 'STIRRER',
        definitionId: 'magnetic-stirrer-standard',
        transform: { positionM: [0.5, 0, 0.15], quaternion: IDENTITY_QUATERNION },
        revision: 0,
        config: { speedRpm: 0 },
        capabilities: ['STIRRING', 'MOUNT'],
        stationId,
      },
      {
        id: probeId,
        kind: 'PH_PROBE',
        definitionId: 'ph-probe-standard',
        transform: { positionM: [0.52, 0.08, 0.15], quaternion: IDENTITY_QUATERNION },
        revision: 0,
        config: {},
        capabilities: ['PH_SENSOR', 'MOUNTABLE'],
        stationId,
      },
    ],
    connections: [
      { id: randomUUID(), from: { instanceId: benchId, socketId: 'surface' }, to: { instanceId: standId, socketId: 'base' }, kind: 'MECHANICAL', enabled: true },
      { id: randomUUID(), from: { instanceId: standId, socketId: 'rod' }, to: { instanceId: clampId, socketId: 'rod-grip' }, kind: 'MECHANICAL', enabled: true },
      { id: randomUUID(), from: { instanceId: clampId, socketId: 'jaw' }, to: { instanceId: buretteId, socketId: 'clamp-grip' }, kind: 'MECHANICAL', enabled: true },
      { id: randomUUID(), from: { instanceId: buretteId, socketId: 'tip' }, to: { instanceId: flaskId, socketId: 'opening' }, kind: 'FLUID', enabled: true },
      { id: randomUUID(), from: { instanceId: probeId, socketId: 'probe-tip' }, to: { instanceId: flaskId, socketId: 'opening' }, kind: 'SENSOR', enabled: true },
    ],
    containerStates: {
      // 25.00 mL of 0.100 mol/L HCl, exactly the shared contract's vertical-slice aliquot.
      [flaskId]: { volumeL: 0.025, species: [{ speciesId: 'HCl(aq)', moles: 0.1 * 0.025 }], temperatureK: 298.15, mixing: 'WELL_MIXED', modelId: 'ideal-well-mixed-v1' },
      // Burette filled to its 50.00 mL mark with 0.100 mol/L NaOH titrant.
      [buretteId]: { volumeL: 0.05, species: [{ speciesId: 'NaOH(aq)', moles: 0.1 * 0.05 }], temperatureK: 298.15, mixing: 'WELL_MIXED', modelId: 'ideal-well-mixed-v1' },
    },
    simulationConfig: { methodId: 'fixed-tick-v1', timeStepS: 0.1 },
  };
}

export function buildBlankStationScene(): SceneCreateRequest {
  const stationId = randomUUID();
  const benchId = randomUUID();
  return {
    title: 'Blank Station (seed)',
    stations: [{ id: stationId, name: 'Station 1' }],
    apparatus: [
      {
        id: benchId,
        kind: 'BENCH',
        definitionId: 'bench-standard',
        transform: { positionM: [0, 0, 0], quaternion: IDENTITY_QUATERNION },
        revision: 0,
        config: {},
        capabilities: ['MOUNT'],
        stationId,
      },
    ],
    connections: [],
    containerStates: {},
    simulationConfig: { methodId: 'fixed-tick-v1', timeStepS: 0.1 },
  };
}
