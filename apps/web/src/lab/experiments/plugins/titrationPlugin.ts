/**
 * The one experiment template implemented so far (00_SHARED_INTEGRATION_CONTRACT.md Section 6:
 * the shared vertical slice). Implements the `ExperimentPlugin` contract from
 * `@matterlab/contracts` (brief item 9) so later templates (buffer, conductivity, calorimetry)
 * plug in beside this one instead of the reducer special-casing every experiment it will ever run.
 *
 * This plugin never computes a pH itself — `buildSolverRequest` only shapes the request; the
 * engine sends it to whatever `SolverClient` it was configured with (Agent 06's, when wired in, or
 * the safe `createUnavailableSolverClient` default).
 */
import type { ContainerContents, ExperimentPlugin, ExperimentScene, PluginSupport, UUID } from '@matterlab/contracts';
import { fluidConnectionsInStation } from '../runtime/validation';

export const ACID_BASE_TITRATION_PLUGIN_ID = 'acid-base-titration';
export const STRONG_ACID_STRONG_BASE_METHOD_ID = 'strong-acid-strong-base-v1';

/**
 * Declared, not hidden: using this model means assuming complete dissociation, ideal dilute
 * activities, a well-mixed vessel and instantaneous equilibrium at every sampled volume. Agent 06
 * owns whether its solver actually honours these; this is what *this plugin* asked for.
 */
export const STRONG_ACID_STRONG_BASE_ASSUMPTIONS: readonly string[] = [
  'Strong acid / strong base model: complete dissociation of both titrant and analyte.',
  'Ideal dilute solution: activities approximated by concentrations.',
  'Well-mixed vessel and instantaneous equilibrium at each sampled delivered volume.',
];

function stationInstances(scene: ExperimentScene, stationId: UUID) {
  return scene.apparatus.filter((a) => a.stationId === stationId);
}

export function createAcidBaseTitrationPlugin(): ExperimentPlugin {
  return {
    id: ACID_BASE_TITRATION_PLUGIN_ID,
    title: 'Acid-base titration',
    supportedModelIds: [STRONG_ACID_STRONG_BASE_METHOD_ID],

    detectSupport(scene, stationId): PluginSupport {
      const instances = stationInstances(scene, stationId);
      const hasSource = instances.some((a) => a.capabilities.includes('FLOW_SOURCE') && a.capabilities.includes('CONTAINER'));
      const hasReceiver = instances.some((a) => a.capabilities.includes('FLOW_RECEIVER') && a.capabilities.includes('CONTAINER'));
      if (!hasSource || !hasReceiver) {
        const missingCapabilities = [...(hasSource ? [] : (['FLOW_SOURCE'] as const)), ...(hasReceiver ? [] : (['FLOW_RECEIVER'] as const))];
        return {
          supported: false,
          reason: 'This station needs a titrant source (e.g. a burette) and a receiving vessel (e.g. a flask) to run a titration.',
          missingCapabilities,
        };
      }
      if (fluidConnectionsInStation(scene, stationId).length === 0) {
        return { supported: false, reason: 'The titrant source and the receiving vessel are not connected by an open fluid path yet.' };
      }
      return { supported: true };
    },

    selectObservationTargets(scene, stationId): readonly UUID[] {
      return stationInstances(scene, stationId)
        .filter((a) => a.capabilities.includes('CONTAINER') && a.capabilities.includes('FLOW_RECEIVER'))
        .map((a) => a.id);
    },

    buildSolverRequest(contents: ContainerContents, conditions) {
      if (contents.volumeL <= 0) return null;
      return {
        contents,
        conditions: {
          ...conditions,
          methodId: STRONG_ACID_STRONG_BASE_METHOD_ID,
          assumptions: STRONG_ACID_STRONG_BASE_ASSUMPTIONS,
        },
      };
    },
  };
}
