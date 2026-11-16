import { LAB_CONTRACT_VERSION, parseExperimentScene } from '@matterlab/contracts';
import type { ContainerContents, ExperimentScene, LabAction, LabActionPayloads, LabActionType, NodeRunRequest, UUID } from '@matterlab/contracts';
import { DEFAULT_ASSUMPTIONS, prepareSolution, SCIENCE_METHOD_ID, SCIENCE_METHOD_VERSION, solveEquilibrium } from '@matterlab/lab-science';
import { apparatusRegistry } from '../../../apps/web/src/lab/apparatus/registry.ts';
import { createTitrationSetup } from '../../../apps/web/src/lab/apparatus/seeds.ts';
import { LAB_RUNTIME_VERSION } from '../src/runtime.ts';
import type { LabRuntime, RuntimeDependencies } from '../src/types.ts';

export const uuid = (number: number): UUID => `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
export function prepared(reagentId: string, volumeL: number, concentrationMolL = 0.1): ContainerContents {
  const result = prepareSolution({ reagentId, volumeL, concentrationMolL, temperatureK: 298.15, mixing: 'WELL_MIXED' });
  if (result.status !== 'SUCCEEDED') throw new Error(result.error.detail);
  return result.contents;
}
export const dependencies: RuntimeDependencies = {
  definitions: apparatusRegistry,
  science: { solve: solveEquilibrium, methodId: SCIENCE_METHOD_ID, methodVersion: SCIENCE_METHOD_VERSION, assumptions: DEFAULT_ASSUMPTIONS },
};
export function fixture(withContents = true) {
  let nextId = 0;
  const { scene: initial, ids } = createTitrationSetup(SCIENCE_METHOD_ID, () => uuid(++nextId));
  const duplicated = initial.apparatus.filter((instance) => instance.stationId === ids.stationId && instance.id !== ids.benchId);
  const map = new Map(duplicated.map((instance) => [instance.id, uuid(++nextId)]));
  const secondSourceId = map.get(ids.buretteId)!;
  const secondReceiverId = map.get(ids.flaskId)!;
  const scene = parseExperimentScene({
    ...initial,
    apparatus: [...initial.apparatus, ...duplicated.map((instance) => ({
      ...instance, id: map.get(instance.id)!, stationId: ids.blankStationId,
      transform: { ...instance.transform, positionM: [instance.transform.positionM[0] + 3, instance.transform.positionM[1], instance.transform.positionM[2]] },
    }))],
    connections: [...initial.connections, ...initial.connections.map((edge) => ({
      ...edge, id: uuid(++nextId),
      from: { ...edge.from, instanceId: map.get(edge.from.instanceId)! },
      to: { ...edge.to, instanceId: map.get(edge.to.instanceId)! },
    }))],
    containerStates: withContents ? {
      [ids.buretteId]: prepared('naoh', 0.05), [ids.flaskId]: prepared('hcl', 0.025),
      [secondSourceId]: prepared('naoh', 0.05), [secondReceiverId]: prepared('hcl', 0.025),
    } : {},
  });
  return {
    scene, ids, secondSourceId, secondReceiverId,
    fluidId: scene.connections.find((edge) => edge.kind === 'FLUID' && edge.from.instanceId === ids.buretteId)!.id,
    runId: uuid(900_000),
  };
}
export function action<Type extends LabActionType>(
  runtime: LabRuntime, actionNumber: number, targetInstanceId: UUID, type: Type, payload: LabActionPayloads[Type],
): LabAction {
  const snapshot = runtime.reader.getSnapshot();
  const instance = type === 'PLACE'
    ? (payload as LabActionPayloads['PLACE']).instance
    : snapshot.scene.apparatus.find((instance) => instance.id === targetInstanceId)!;
  const station = snapshot.stationStates[instance.stationId]!;
  return { actionId: uuid(actionNumber), targetInstanceId, type, payload, atSimulationS: station.simulationTimeS, expectedEpoch: station.epoch } as LabAction;
}
export async function resume(runtime: LabRuntime, stationId: UUID, number: number): Promise<void> {
  const state = runtime.reader.getSnapshot().stationStates[stationId]!;
  const receipt = await runtime.actions.control({ controlId: uuid(number), stationId, atSimulationS: state.simulationTimeS, expectedEpoch: state.epoch, type: 'RESUME', payload: {} });
  if (receipt.status !== 'APPLIED') throw new Error(receipt.error.detail);
}
export function request(scene: ExperimentScene, steps: NodeRunRequest['steps'] = []): NodeRunRequest {
  return {
    schemaVersion: 1, runId: uuid(900_000), contractVersion: LAB_CONTRACT_VERSION,
    runtimeVersion: LAB_RUNTIME_VERSION, methodVersion: SCIENCE_METHOD_VERSION, initialScene: scene, steps,
  };
}
