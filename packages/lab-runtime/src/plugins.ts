import { parseLabContract, serializeLabContract } from '@matterlab/contracts';
import type {
  ApparatusCapabilityPlugin, ApparatusDefinitionReader, EquilibriumInput, ExperimentPlugin, ExperimentScene, ModelSupport,
  RuntimeSnapshot, RuntimeSolverRequest, UUID,
} from '@matterlab/contracts';
import { fail, problem } from './errors.ts';
import { stationGraphProblems } from './graph.ts';
import { VOLUME_TOLERANCE_L } from './inventory.ts';
import type { RuntimeScience } from './types.ts';

export const CONFIGURATION_PLUGIN_ID = 'matterlab:container-config-v1';
export const EDITOR_PLUGIN_ID = 'matterlab:editor-v1';
export const METERED_FLOW_METHOD_ID = 'flow:linear-valve-v1';

export function createAqueousExperimentPlugin(science: RuntimeScience): ExperimentPlugin {
  const getSolverRequests = (snapshot: RuntimeSnapshot, stationId: UUID): readonly RuntimeSolverRequest[] =>
    snapshot.scene.apparatus.filter((instance) => instance.stationId === stationId && instance.capabilities.includes('CONTAINER'))
      .sort((a, b) => a.id < b.id ? -1 : 1)
      .flatMap((instance) => {
        const contents = snapshot.scene.containerStates[instance.id];
        if (!contents || contents.volumeL <= VOLUME_TOLERANCE_L) return [];
        const indicatorId = instance.config.indicatorId;
        return [{
          apparatusId: instance.id,
          input: {
            contents, methodId: science.methodId, assumptions: science.assumptions,
            ...(typeof indicatorId === 'string' && indicatorId !== '' && indicatorId !== 'none' ? { indicatorIds: [indicatorId] } : {}),
          },
        }];
      });
  return Object.freeze({
    id: 'matterlab:aqueous-containers-v1', version: '1.0.0', methodId: science.methodId,
    requiredCapabilities: ['CONTAINER'] as const,
    supportedActionTypes: ['PLACE', 'MOVE', 'ATTACH', 'DETACH', 'FILL', 'SET_VALVE', 'TRANSFER', 'START_STIRRER', 'SET_PROBE', 'RESET', 'CUSTOM'] as const,
    getSupport(scene: ExperimentScene, stationId: UUID, definitions: ApparatusDefinitionReader): ModelSupport {
      const reasons = stationGraphProblems(scene, stationId, definitions).map((error) => error.detail);
      if (scene.simulationConfig.methodId !== science.methodId) reasons.push('Selected method is not provided by this science adapter.');
      if (!scene.apparatus.some((instance) => instance.stationId === stationId &&
          instance.capabilities.includes('CONTAINER') && (scene.containerStates[instance.id]?.volumeL ?? 0) > 0)) {
        reasons.push('This template requires at least one explicitly prepared nonempty container.');
      }
      return { status: reasons.length === 0 ? 'SUPPORTED' : 'UNSUPPORTED', methodId: science.methodId, reasons };
    },
    getSolverRequests,
    getSolverInputs(snapshot: RuntimeSnapshot, stationId: UUID): readonly EquilibriumInput[] {
      return getSolverRequests(snapshot, stationId).map((request) => request.input);
    },
  });
}

export function resolveSolverRequests(
  plugin: ExperimentPlugin, snapshot: RuntimeSnapshot, stationId: UUID, definitions: ApparatusDefinitionReader,
): readonly RuntimeSolverRequest[] {
  const requests = plugin.getSolverRequests
    ? plugin.getSolverRequests(snapshot, stationId)
    : plugin.getSolverInputs(snapshot, stationId).map((input) => {
      const matches = snapshot.scene.apparatus.filter((instance) => instance.stationId === stationId &&
        instance.capabilities.includes('CONTAINER') && snapshot.scene.containerStates[instance.id] === input.contents);
      if (matches.length !== 1) fail('UNSUPPORTED_MODEL', 'Legacy solver inputs cannot be uniquely attributed to an authoritative vessel; provide explicit RuntimeSolverRequest IDs.');
      return { apparatusId: matches[0]!.id, input };
    });
  const seen = new Set<UUID>();
  return Object.freeze(requests.map((raw) => {
    const request = parseLabContract('RuntimeSolverRequest', raw);
    const instance = snapshot.scene.apparatus.find((item) => item.id === request.apparatusId);
    const authoritative = snapshot.scene.containerStates[request.apparatusId];
    if (!instance || instance.stationId !== stationId || !instance.capabilities.includes('CONTAINER') ||
        !definitions.getDefinition(instance.definitionId) || !authoritative) {
      fail('UNSUPPORTED_MODEL', 'Solver request must identify a known same-station authoritative container.');
    }
    if (seen.has(instance.id)) fail('UNSUPPORTED_MODEL', 'A template cannot issue ambiguous duplicate solver requests for one vessel.');
    seen.add(instance.id);
    if (request.input.methodId !== snapshot.scene.simulationConfig.methodId ||
        serializeLabContract('ContainerContents', authoritative) !== serializeLabContract('ContainerContents', request.input.contents)) {
      fail('UNSUPPORTED_MODEL', 'Solver input differs from the identified authoritative inventory or method.');
    }
    return request;
  }));
}

export function builtInCapabilities(): readonly ApparatusCapabilityPlugin[] {
  const assignments = [
    ['CONTAINER', ['FILL']], ['FLOW_SOURCE', ['SET_VALVE', 'TRANSFER']],
    ['STIRRING', ['START_STIRRER']], ['PH_SENSOR', ['SET_PROBE']],
  ] as const;
  return Object.freeze(assignments.map(([capability, actionTypes]) => Object.freeze({
    id: `matterlab:capability:${capability.toLowerCase()}`, version: '1.0.0', capability, actionTypes,
    validateAction(snapshot, action) {
      const instance = snapshot.scene.apparatus.find((item) => item.id === action.targetInstanceId);
      return instance?.capabilities.includes(capability) ? null : problem('INVALID_ACTION', `Action requires ${capability}.`);
    },
    proposeActions: () => [],
  } satisfies ApparatusCapabilityPlugin)));
}
