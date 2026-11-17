/**
 * Node-only `SolverClient` that calls Agent 06's real solver via `agent08_titration_solver_bridge.py`
 * (a thin CLI wrapper this surface added around Agent 06's untouched `titration.solver.solve_equilibrium`).
 * Used by vitest (Node environment) and by the Vite dev-server middleware
 * (`vite.config.ts` → `titrationSolverDevMiddleware`) that the browser preview talks to over HTTP.
 *
 * Not for browser code: `node:child_process` does not exist there. Browser code uses
 * `httpSolverClient.ts` instead, which calls the same bridge script indirectly through that
 * middleware.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SolverClient, SolverRequest, SolverResponse } from '@matterlab/contracts';
import { AGENT06_METHOD_ID, AGENT06_METHOD_VERSION, bridgeFailureResult, bridgeResultToRunResult, buildBridgeRequestBody } from './solverBridgeProtocol';
import type { BridgeResponseBody } from './solverBridgeProtocol';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// apps/web/src/lab/challenges/integration -> repo root is six levels up.
export const REPO_ROOT = path.resolve(HERE, '../../../../../../');
export const SCIENCE_DIR = path.join(REPO_ROOT, 'services', 'science');
export const BRIDGE_SCRIPT_PATH = path.join(SCIENCE_DIR, 'agent08_titration_solver_bridge.py');

export interface PythonSolverClientOptions {
  readonly pythonExecutable?: string;
  readonly timeoutMs?: number;
}

/**
 * Spawns a fresh Python process per call (simplicity over throughput — Agent 06's README reports
 * each solve taking under a millisecond; process startup dominates, which is acceptable for a dev
 * bridge, not a production performance target).
 */
export function createPythonSolverClient(options: PythonSolverClientOptions = {}): SolverClient {
  const pythonExecutable = options.pythonExecutable ?? process.env.AGENT08_PYTHON ?? 'python';
  const timeout = options.timeoutMs ?? 10_000;
  return {
    methodId: AGENT06_METHOD_ID,
    methodVersion: AGENT06_METHOD_VERSION,
    async evaluate(request: SolverRequest): Promise<SolverResponse> {
      const body = JSON.stringify(buildBridgeRequestBody(request.contents.species, request.contents.volumeL, request.contents.temperatureK));
      const outcome = spawnSync(pythonExecutable, [BRIDGE_SCRIPT_PATH], { input: body, cwd: SCIENCE_DIR, encoding: 'utf-8', timeout });
      if (outcome.error) return bridgeFailureResult(request, outcome.error.message);
      if (!outcome.stdout) return bridgeFailureResult(request, outcome.stderr || `python exited with code ${String(outcome.status)}`);
      let parsed: BridgeResponseBody;
      try {
        parsed = JSON.parse(outcome.stdout) as BridgeResponseBody;
      } catch {
        return bridgeFailureResult(request, `invalid JSON from solver bridge: ${outcome.stdout.slice(0, 500)}`);
      }
      if ('error' in parsed) return bridgeFailureResult(request, parsed.error);
      return bridgeResultToRunResult(request, parsed);
    },
  };
}
