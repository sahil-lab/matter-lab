/**
 * **TEST FIXTURE ONLY.** A minimal, closed-form strong-acid/strong-base solver used solely to
 * exercise Agent 07's reducer-to-solver integration seam (`SolverClient`) in this package's own
 * tests — e.g. "fill, open valve, meter transfer, compute pH, update sensor and plot" end to end,
 * and that replaying a run reproduces identical observations.
 *
 * This is **not** Agent 06's validated solver (`services/science/titration/**`, a sibling branch
 * not available here) and must never be wired into a production build — `createUnavailableSolverClient`
 * in `@matterlab/contracts` is the safe production default until Agent 06's real client is
 * reconciled in. Every observation this emits is tagged `evidence: 'UNVERIFIED'` for exactly that
 * reason, even though the underlying equation (charge balance with water autoionization) is
 * textbook strong acid/base chemistry, not an invented curve.
 *
 * Governing equation: for a well-mixed solution with net strong-acid excess concentration
 * `C = ([acid] - [base])` (negative when base is in excess), charge balance `[H+] - [OH-] = C`
 * together with `[OH-] = Kw / [H+]` gives `[H+]^2 - C[H+] - Kw = 0`, solved by the quadratic
 * formula. At `C = 0` (equivalence) this reduces to `[H+] = sqrt(Kw)`, i.e. pH 7.00 at Kw = 1e-14.
 */
import type { Observation, RunResult, SolverClient, SolverRequest } from '@matterlab/contracts';
import { STRONG_ACID_STRONG_BASE_METHOD_ID } from '../plugins/titrationPlugin';

export const TEST_FIXTURE_SOLVER_METHOD_VERSION = 'test-fixture-0';

/** Illustrative Kw at ~298.15 K; not independently sourced for this fixture (Agent 06 owns the real value and its temperature dependence). */
const ILLUSTRATIVE_KW_298_15K = 1.0e-14;

export interface FakeSolverOptions {
  readonly acidSpeciesId?: string;
  readonly baseSpeciesId?: string;
  readonly kw?: number;
}

export function createFakeStrongAcidStrongBaseSolverClient(options: FakeSolverOptions = {}): SolverClient {
  const acidSpeciesId = options.acidSpeciesId ?? 'HCl';
  const baseSpeciesId = options.baseSpeciesId ?? 'NaOH';
  const kw = options.kw ?? ILLUSTRATIVE_KW_298_15K;

  return {
    methodId: STRONG_ACID_STRONG_BASE_METHOD_ID,
    methodVersion: TEST_FIXTURE_SOLVER_METHOD_VERSION,
    async evaluate(request: SolverRequest): Promise<RunResult> {
      const { contents } = request;
      if (contents.volumeL <= 0) {
        return {
          runId: request.requestId,
          status: 'UNSUPPORTED',
          methodId: request.conditions.methodId,
          methodVersion: TEST_FIXTURE_SOLVER_METHOD_VERSION,
          inputHash: `${request.requestId}:empty`,
          observations: [],
          warnings: [],
          assumptions: ['Container has no recorded volume; nothing to evaluate.'],
        };
      }
      const acidMoles = contents.species.find((s) => s.speciesId === acidSpeciesId)?.moles ?? 0;
      const baseMoles = contents.species.find((s) => s.speciesId === baseSpeciesId)?.moles ?? 0;
      const netExcessConcentration = (acidMoles - baseMoles) / contents.volumeL;
      const hydronium = (netExcessConcentration + Math.sqrt(netExcessConcentration * netExcessConcentration + 4 * kw)) / 2;
      const pH = -Math.log10(hydronium);

      const observation: Observation = {
        type: 'PH',
        apparatusId: request.apparatusId,
        timeS: request.atSimulationS,
        quantity: { value: pH, unit: 'pH' },
        evidence: 'UNVERIFIED',
        methodId: request.conditions.methodId,
        sourceIds: ['test-fixture:strong-acid-strong-base-charge-balance'],
      };
      return {
        runId: request.requestId,
        status: 'SUCCEEDED',
        methodId: request.conditions.methodId,
        methodVersion: TEST_FIXTURE_SOLVER_METHOD_VERSION,
        inputHash: `${acidMoles.toFixed(9)}:${baseMoles.toFixed(9)}:${contents.volumeL.toFixed(9)}`,
        observations: [observation],
        warnings: [],
        assumptions: [
          ...(request.conditions.assumptions ?? []),
          `Water autoionization included with an illustrative Kw = ${kw} (298.15 K); not independently sourced for this test fixture.`,
        ],
      };
    },
  };
}
