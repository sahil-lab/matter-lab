/**
 * `ExperimentPlugin` contract (Agent 07 required implementation item 9): lets a validated
 * experiment template (acid-base titration today; buffer/calorimetry/conductivity later) declare
 * what apparatus arrangement it needs and how to turn a container's contents into a `SolverRequest`,
 * without the reducer hardcoding every template it will ever support.
 *
 * 00_SHARED_INTEGRATION_CONTRACT.md Section 4: "A custom apparatus graph is accepted only if
 * connections are compatible and the requested model supports the configured experiment. Otherwise
 * show unsupported conditions clearly." `detectSupport` is how a plugin says which of those is true
 * for a given station, in a human-readable way the UI (Agent 01/08) can show as-is.
 */

import type { ApparatusDefinition } from './apparatus';
import type { Capability, ContainerContents, ExperimentScene, UUID } from './types';
import type { SolverConditions, SolverRequest } from './solver';

export interface PluginSupport {
  readonly supported: boolean;
  /** One sentence, shown directly to the user when `supported` is false. */
  readonly reason?: string;
  readonly missingCapabilities?: readonly Capability[];
}

/** Minimal read-only registry surface a plugin needs; satisfied by the real capability registry. */
export interface ApparatusDefinitionLookup {
  get(definitionId: string): ApparatusDefinition | undefined;
}

export interface PluginContext {
  readonly registry: ApparatusDefinitionLookup;
  readonly atSimulationS: number;
}

export interface ExperimentPlugin {
  /** Stable id, e.g. `'acid-base-titration'`. */
  readonly id: string;
  readonly title: string;
  /** Solver method ids this plugin knows how to request (Agent 06 must recognise at least one). */
  readonly supportedModelIds: readonly string[];
  /** Whether `stationId`'s current apparatus arrangement is one this plugin can evaluate. */
  detectSupport(scene: ExperimentScene, stationId: UUID, registry: ApparatusDefinitionLookup): PluginSupport;
  /** Which apparatus instances (vessels) in this station should receive recomputed observations. */
  selectObservationTargets(scene: ExperimentScene, stationId: UUID): readonly UUID[];
  /** Turns one target vessel's authoritative contents into a request Agent 06's solver can answer. */
  buildSolverRequest(
    contents: ContainerContents,
    conditions: Omit<SolverConditions, 'methodId'>,
    context: PluginContext,
  ): Omit<SolverRequest, 'requestId' | 'stationId' | 'apparatusId' | 'atSimulationS'> | null;
}
