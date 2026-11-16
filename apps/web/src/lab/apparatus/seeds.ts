import { parseExperimentScene } from '@matterlab/contracts';
import type { ApparatusInstance, Connection, ExperimentScene, JsonObject, UUID, Vec3M } from '@matterlab/contracts';
import { apparatusRegistry } from './registry.ts';

export interface TitrationSetupIds {
  readonly stationId: UUID;
  readonly blankStationId: UUID;
  readonly benchId: UUID;
  readonly blankBenchId: UUID;
  readonly standId: UUID;
  readonly clampId: UUID;
  readonly buretteId: UUID;
  readonly flaskId: UUID;
  readonly stirrerId: UUID;
  readonly probeId: UUID;
  readonly bottleId: UUID;
}

/** An assembled, unfilled station and an independent blank workbench. It contains no invented results. */
export function createTitrationSetup(
  methodId: string,
  createId: () => UUID = () => crypto.randomUUID(),
): { readonly scene: ExperimentScene; readonly ids: TitrationSetupIds } {
  const sceneId = createId();
  const ids: TitrationSetupIds = {
    stationId: createId(), blankStationId: createId(), benchId: createId(), blankBenchId: createId(),
    standId: createId(), clampId: createId(), buretteId: createId(), flaskId: createId(),
    stirrerId: createId(), probeId: createId(), bottleId: createId(),
  };
  const apparatus: ApparatusInstance[] = [];
  const add = (id: UUID, definitionId: string, positionM: Vec3M, stationId = ids.stationId, configuration: JsonObject = {}) => {
    const definition = apparatusRegistry.getDefinition(definitionId);
    if (!definition) throw new Error(`Required apparatus ${definitionId} is not registered.`);
    apparatus.push({
      id, kind: definition.kind, definitionId, stationId, revision: 0,
      transform: { positionM, quaternion: [0, 0, 0, 1] },
      config: { ...definition.defaultConfig, ...configuration }, capabilities: definition.capabilities,
    });
  };
  add(ids.benchId, 'bench-standard', [0, 0, 0]);
  add(ids.blankBenchId, 'bench-standard', [3, 0, 0], ids.blankStationId);
  add(ids.standId, 'retort-stand', [-0.45, 0.9, 0]);
  add(ids.clampId, 'burette-clamp', [-0.45, 1.51, 0]);
  add(ids.buretteId, 'burette-50ml', [-0.13, 1.18, 0]);
  add(ids.stirrerId, 'magnetic-stirrer', [-0.13, 0.9, 0]);
  add(ids.flaskId, 'conical-flask-250ml', [-0.13, 0.96, 0], ids.stationId, { indicatorId: 'phenolphthalein' });
  add(ids.probeId, 'ph-probe', [0.055, 0.9, 0.2]);
  add(ids.bottleId, 'reagent-bottle-250ml', [0.32, 0.9, 0]);
  const connections: Connection[] = [];
  const connect = (kind: Connection['kind'], fromId: UUID, fromSocket: string, toId: UUID, toSocket: string) => {
    connections.push({
      id: createId(), kind, enabled: true,
      from: { instanceId: fromId, socketId: fromSocket },
      to: { instanceId: toId, socketId: toSocket },
    });
  };
  connect('MECHANICAL', ids.standId, 'clamp-mount', ids.clampId, 'stand-mount');
  connect('MECHANICAL', ids.clampId, 'barrel-grip', ids.buretteId, 'barrel-mount');
  connect('MECHANICAL', ids.stirrerId, 'platform', ids.flaskId, 'base');
  connect('CONTROL', ids.stirrerId, 'stir-control', ids.flaskId, 'stir-control');
  connect('FLUID', ids.buretteId, 'outlet', ids.flaskId, 'inlet');
  const scene = parseExperimentScene({
    id: sceneId, revision: 0, schemaVersion: 1,
    stations: [{ id: ids.stationId, name: 'Titration station' }, { id: ids.blankStationId, name: 'Blank station' }],
    apparatus, connections, containerStates: {},
    simulationConfig: { methodId, timeStepS: 0.1 },
  });
  return { scene, ids: Object.freeze(ids) };
}
