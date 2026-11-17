/**
 * Shared request/response mapping between Agent 07's `SolverClient` contract
 * (`@matterlab/contracts`) and the JSON protocol `agent08_titration_solver_bridge.py` speaks on
 * top of Agent 06's real `titration.solver.solve_equilibrium`. Used by both the Node-side
 * (`pythonSolverClient.ts`, for tests and the Vite dev middleware process) and the browser-side
 * (`httpSolverClient.ts`) clients, so the two can never drift apart.
 */
import type { Evidence, RunResult, RunStatus, SolverRequest, SpeciesAmount } from '@matterlab/contracts';

export const AGENT06_METHOD_ID = 'monoprotic-acid-base-electroneutrality-v1';
export const AGENT06_METHOD_VERSION = '1.0.0';

export interface BridgeRequestBody {
  readonly species: readonly { readonly speciesId: string; readonly moles: number }[];
  readonly volumeL: number;
  readonly temperatureK: number;
}

export interface BridgeSolveResult {
  readonly status: 'SUCCEEDED' | 'UNSUPPORTED' | 'FAILED';
  readonly model_id: string;
  readonly method_version: string;
  readonly pH: number | null;
  readonly evidence: Evidence;
  readonly reason: string | null;
  readonly warnings: readonly string[];
  readonly assumptions: readonly string[];
  readonly diagnostics?: { readonly input_hash?: string; readonly [key: string]: unknown };
}

export type BridgeResponseBody = BridgeSolveResult | { readonly error: string };

export function buildBridgeRequestBody(species: readonly SpeciesAmount[], volumeL: number, temperatureK: number): BridgeRequestBody {
  return { species: species.map((s) => ({ speciesId: s.speciesId, moles: s.moles })), volumeL, temperatureK };
}

const STATUS_MAP: Readonly<Record<BridgeSolveResult['status'], RunStatus>> = {
  SUCCEEDED: 'SUCCEEDED',
  UNSUPPORTED: 'UNSUPPORTED',
  FAILED: 'FAILED',
};

/** Converts Agent 06's real `SolveResult` (as emitted by the Python bridge) into the `RunResult` Agent 07's engine expects. */
export function bridgeResultToRunResult(request: SolverRequest, parsed: BridgeSolveResult): RunResult {
  const observations: RunResult['observations'] =
    parsed.status === 'SUCCEEDED' && parsed.pH !== null
      ? [
          {
            type: 'PH',
            apparatusId: request.apparatusId,
            timeS: request.atSimulationS,
            quantity: { value: parsed.pH, unit: 'pH' },
            evidence: parsed.evidence,
            methodId: parsed.model_id,
            sourceIds: ['agent06:titration-solver'],
          },
        ]
      : [];
  return {
    runId: request.requestId,
    status: STATUS_MAP[parsed.status],
    methodId: parsed.model_id,
    methodVersion: parsed.method_version,
    inputHash: parsed.diagnostics?.input_hash ?? request.requestId,
    observations,
    warnings: parsed.warnings,
    assumptions: parsed.assumptions,
    solverDiagnostics: parsed.reason ? { ...parsed.diagnostics, reason: parsed.reason } : parsed.diagnostics,
  };
}

/** Honest failure result: used whenever the bridge process, its JSON, or the request itself could not be turned into a real answer. */
export function bridgeFailureResult(request: SolverRequest, reason: string): RunResult {
  return {
    runId: request.requestId,
    status: 'FAILED',
    methodId: request.conditions.methodId,
    methodVersion: '0',
    inputHash: request.requestId,
    observations: [],
    warnings: [],
    assumptions: [],
    solverDiagnostics: { reason: `Agent 06 solver bridge error: ${reason}` },
  };
}
