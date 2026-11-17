/**
 * Browser-side `SolverClient`. The browser cannot spawn Python directly, so this calls a dev-only
 * HTTP route (`/__agent08__/titration-solve`) added by the Vite middleware in `apps/web/vite.config.ts`,
 * which itself shells out to the same `agent08_titration_solver_bridge.py` that `pythonSolverClient.ts`
 * uses directly in Node. In a production deployment this route does not exist; Agent 09's real
 * `/api/v1/lab/scenes/{id}/runs` is the intended replacement (see this module's `README.md` entry).
 */
import type { SolverClient, SolverRequest, SolverResponse } from '@matterlab/contracts';
import { AGENT06_METHOD_ID, AGENT06_METHOD_VERSION, bridgeFailureResult, bridgeResultToRunResult, buildBridgeRequestBody } from './solverBridgeProtocol';
import type { BridgeResponseBody } from './solverBridgeProtocol';

export const TITRATION_SOLVE_DEV_ROUTE = '/__agent08__/titration-solve';

export interface HttpSolverClientOptions {
  readonly route?: string;
  readonly fetchImpl?: typeof fetch;
}

export function createHttpSolverClient(options: HttpSolverClientOptions = {}): SolverClient {
  const route = options.route ?? TITRATION_SOLVE_DEV_ROUTE;
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    methodId: AGENT06_METHOD_ID,
    methodVersion: AGENT06_METHOD_VERSION,
    async evaluate(request: SolverRequest): Promise<SolverResponse> {
      try {
        const response = await fetchImpl(route, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildBridgeRequestBody(request.contents.species, request.contents.volumeL, request.contents.temperatureK)),
        });
        if (!response.ok) return bridgeFailureResult(request, `dev solver bridge responded HTTP ${response.status}`);
        const parsed = (await response.json()) as BridgeResponseBody;
        if ('error' in parsed) return bridgeFailureResult(request, parsed.error);
        return bridgeResultToRunResult(request, parsed);
      } catch (error) {
        return bridgeFailureResult(request, error instanceof Error ? error.message : String(error));
      }
    },
  };
}
