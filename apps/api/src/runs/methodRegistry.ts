/**
 * Pluggable run-method registry (Agent 07's brief calls the equivalent concept `ExperimentPlugin`
 * on the apparatus-reducer side; this is Agent 09's matching seam on the run-execution side so a
 * validated method can be registered without the persistence layer changing).
 */
import type { ExperimentScene, LabAction, Observation } from '@matterlab/contracts-lab';
import * as strongAcidStrongBase from './methods/strongAcidStrongBase.js';

export type MethodResult =
  | { status: 'SUCCEEDED'; observations: Observation[]; warnings: readonly string[]; assumptions: readonly string[]; solverDiagnostics?: Record<string, unknown> }
  | { status: 'UNSUPPORTED' | 'FAILED'; warnings: readonly string[]; assumptions: readonly string[]; failureCode: string; failureMessage: string };

export interface MethodHandlerArgs {
  readonly scene: ExperimentScene;
  readonly actions: readonly LabAction[];
  readonly settings: Record<string, unknown>;
}

export type MethodHandler = (args: MethodHandlerArgs) => MethodResult;

function unsupported(code: string, message: string): MethodResult {
  return { status: 'UNSUPPORTED', warnings: [], assumptions: strongAcidStrongBase.ASSUMPTIONS, failureCode: code, failureMessage: message };
}

function resolveStationId(scene: ExperimentScene, settings: Record<string, unknown>): string | null {
  const requested = typeof settings.stationId === 'string' ? settings.stationId : undefined;
  if (requested) return scene.stations.some((s) => s.id === requested) ? requested : null;
  return scene.stations.length === 1 ? scene.stations[0].id : null;
}

const strongAcidStrongBaseHandler: MethodHandler = ({ scene, actions, settings }) => {
  const stationId = resolveStationId(scene, settings);
  if (!stationId) {
    return unsupported(
      'station_not_identified',
      scene.stations.length === 0
        ? 'The scene has no stations.'
        : `The scene has ${scene.stations.length} stations; specify settings.stationId to choose which one to run.`,
    );
  }
  const stationApparatus = scene.apparatus.filter((a) => a.stationId === stationId);
  const flaskId = strongAcidStrongBase.findSingleInstanceWithCapabilities(stationApparatus, ['CONTAINER', 'FLOW_RECEIVER']);
  const buretteId = strongAcidStrongBase.findSingleInstanceWithCapabilities(stationApparatus, ['CONTAINER', 'FLOW_SOURCE']);
  if (!flaskId) return unsupported('receiver_not_identified', 'This station needs exactly one CONTAINER apparatus with FLOW_RECEIVER capability (a flask).');
  if (!buretteId) return unsupported('source_not_identified', 'This station needs exactly one CONTAINER apparatus with FLOW_SOURCE capability (a burette).');

  const flaskContents = scene.containerStates[flaskId];
  const buretteContents = scene.containerStates[buretteId];
  if (!flaskContents) return unsupported('missing_container_state', `Apparatus ${flaskId} (flask) has no container state.`);
  if (!buretteContents) return unsupported('missing_container_state', `Apparatus ${buretteId} (burette) has no container state.`);

  const analyte = strongAcidStrongBase.classifyAnalyte(flaskContents);
  if (!analyte.supported) return unsupported('unrecognized_analyte', analyte.reason);
  const titrant = strongAcidStrongBase.classifyTitrant(buretteContents, analyte.isAcid);
  if (!titrant.supported) return unsupported('unrecognized_titrant', titrant.reason);

  let cumulative = 0;
  const steps: strongAcidStrongBase.TitrationStep[] = [];
  for (const action of actions) {
    if (action.type !== 'TRANSFER') continue;
    if (action.targetInstanceId !== flaskId) {
      return { status: 'FAILED', warnings: [], assumptions: strongAcidStrongBase.ASSUMPTIONS, failureCode: 'transfer_target_mismatch', failureMessage: `TRANSFER action ${action.actionId} targets ${action.targetInstanceId}, not the identified flask ${flaskId}.` };
    }
    const sourceInstanceId = action.payload.sourceInstanceId;
    if (sourceInstanceId !== buretteId) {
      return { status: 'FAILED', warnings: [], assumptions: strongAcidStrongBase.ASSUMPTIONS, failureCode: 'transfer_source_mismatch', failureMessage: `TRANSFER action ${action.actionId} does not source from the identified burette ${buretteId}.` };
    }
    const deliveredVolumeL = action.payload.deliveredVolumeL;
    if (typeof deliveredVolumeL !== 'number' || !(deliveredVolumeL > 0) || !Number.isFinite(deliveredVolumeL)) {
      return { status: 'FAILED', warnings: [], assumptions: strongAcidStrongBase.ASSUMPTIONS, failureCode: 'invalid_transfer_volume', failureMessage: `TRANSFER action ${action.actionId} has no positive numeric payload.deliveredVolumeL.` };
    }
    cumulative += deliveredVolumeL;
    steps.push({ atSimulationS: action.atSimulationS, cumulativeDeliveredVolumeL: cumulative, actionId: action.actionId });
  }

  try {
    const { observations, warnings, assumptions } = strongAcidStrongBase.computeTitrationObservations(
      analyte.container,
      analyte.isAcid,
      flaskId,
      titrant.container,
      buretteId,
      steps,
    );
    return { status: 'SUCCEEDED', observations, warnings, assumptions, solverDiagnostics: { stationId, flaskId, buretteId, steps: steps.length } };
  } catch (error) {
    if (error instanceof strongAcidStrongBase.TitrationVolumeExceededError) {
      return { status: 'FAILED', warnings: [], assumptions: strongAcidStrongBase.ASSUMPTIONS, failureCode: 'titrant_volume_exceeded', failureMessage: error.message };
    }
    throw error;
  }
};

interface MethodRegistration {
  readonly version: string;
  readonly handler: MethodHandler;
}

export const METHOD_REGISTRY: Readonly<Record<string, MethodRegistration>> = {
  [strongAcidStrongBase.METHOD_ID]: { version: strongAcidStrongBase.METHOD_VERSION, handler: strongAcidStrongBaseHandler },
};

export function methodVersionOf(methodId: string): string {
  return METHOD_REGISTRY[methodId]?.version ?? 'unknown';
}
