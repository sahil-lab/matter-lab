/**
 * The one typed seam between Agent 07 (apparatus/inventory state, this reducer) and Agent 06
 * (chemistry solver). 00_SHARED_INTEGRATION_CONTRACT.md Section 4 is explicit: "The chemistry
 * solver is a pure, deterministic function of validated chemical state + method/conditions, with
 * result provenance and errors. No UI component calculates authoritative pH independently." Agent
 * 07 must never compute pH; it only ever builds a `SolverRequest` from its own authoritative
 * `ContainerContents` and calls a `SolverClient`.
 *
 * STUB STATUS: Agent 06 owns `services/science/titration/**` on a sibling branch not available
 * here. This file defines the contract Agent 07 codes and tests against, plus a safe default
 * client (`createUnavailableSolverClient`) that always reports `UNSUPPORTED` rather than inventing
 * a result. Reconcile with Agent 06's actual request/response shape before this ships; Agent 09/10
 * are expected to wire the real client in at integration time.
 */

import type { ContainerContents, Observation, RunResult, UUID } from './types';

export interface SolverConditions {
  readonly temperatureK: number;
  /** Identifies which validated model to run, e.g. `'strong-acid-strong-base-v1'`. */
  readonly methodId: string;
  /** Assumptions the caller is explicitly declaring (e.g. "ideal dilute activities"). */
  readonly assumptions?: readonly string[];
}

/**
 * Exactly what Agent 07 is allowed to send: a validated container's contents plus the method to
 * run. No visual, pixel or UI state ever crosses this boundary.
 */
export interface SolverRequest {
  readonly requestId: UUID;
  readonly stationId: UUID;
  /** The container (vessel) whose contents are being evaluated, e.g. the receiving flask. */
  readonly apparatusId: UUID;
  readonly contents: ContainerContents;
  readonly conditions: SolverConditions;
  /** Simulation time the request corresponds to, so late-resolving responses can be ordered. */
  readonly atSimulationS: number;
}

export type SolverResponse = RunResult;

/**
 * The typed local/remote call Agent 07's runtime makes. A real implementation may be a direct
 * in-process call (if Agent 06 ships a TypeScript port, mirroring how `forcefield`/`quantum` run
 * client-side) or an HTTP call through Agent 09's `/api/v1/lab/scenes/{id}/runs` endpoint; the
 * reducer does not care which, since both return a `Promise<SolverResponse>`.
 */
export interface SolverClient {
  readonly methodId: string;
  readonly methodVersion: string;
  evaluate(request: SolverRequest): Promise<SolverResponse>;
}

let requestCounter = 0;

/** Deterministic id generator so tests do not depend on `crypto.randomUUID` availability. */
export function nextSolverRequestId(prefix = 'solver-request'): string {
  requestCounter += 1;
  return `${prefix}-${requestCounter}`;
}

/**
 * Safe default used whenever no real chemistry client has been wired in. It never fabricates a
 * number: every call reports `UNSUPPORTED` with a diagnostic explaining why, satisfying "Never
 * fabricate a scientific result" even in the absence of Agent 06's solver. Swap this out for the
 * real client; do not delete the `UNSUPPORTED` fallback behaviour it models, since the reducer
 * should always degrade to this when the real client throws or is not configured.
 */
export function createUnavailableSolverClient(): SolverClient {
  return {
    methodId: 'unavailable',
    methodVersion: '0',
    async evaluate(request: SolverRequest): Promise<SolverResponse> {
      const observations: readonly Observation[] = [];
      return {
        runId: request.requestId,
        status: 'UNSUPPORTED',
        methodId: request.conditions.methodId,
        methodVersion: '0',
        inputHash: request.requestId,
        observations,
        warnings: [],
        assumptions: [
          'Agent 06 chemistry solver is not connected in this build. No pH or equilibrium value has been computed.',
        ],
      } satisfies SolverResponse;
    },
  };
}
