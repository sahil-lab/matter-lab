import { describe, expect, it } from 'vitest';
import { createPythonSolverClient } from './pythonSolverClient';
import { RealEngineRuntimeSource } from './realEngineSource';
import { AGENT06_METHOD_ID } from './solverBridgeProtocol';

/**
 * The one test in this surface that proves the *real* Agent 06 solver is genuinely wired in, not
 * just a fast in-process test double (see `createFakeStrongAcidStrongBaseSolverClient`, used
 * everywhere else for speed). This spawns the actual `agent08_titration_solver_bridge.py` process
 * around Agent 06's untouched `titration.solver.solve_equilibrium`, so it is slower than the rest
 * of this suite by design — it is checking a different thing (real process wiring), not goal logic.
 */
describe('RealEngineRuntimeSource wired to the real Agent 06 Python solver bridge', () => {
  it(
    'reaches pH \u2248 7 at the 25.00 mL equivalence point using the real solver process, not a fabricated number',
    async () => {
      const runtime = new RealEngineRuntimeSource(createPythonSolverClient());
      runtime.placeStand();
      runtime.placeClamp();
      runtime.attachClampToStand();
      runtime.placeBurette();
      runtime.attachBuretteToClamp();
      runtime.placeFlask();
      runtime.connectBuretteToFlask();
      runtime.fillHcl(); // 25.00 mL of 0.100 mol/L HCl: 0.0025 mol
      await runtime.settle();
      runtime.fillNaoh(); // 50.00 mL of 0.100 mol/L NaOH in the burette
      runtime.setStopcock(0.3);
      runtime.deliverIncrement(0.025); // delivers 0.0025 mol NaOH: exactly the theoretical equivalence volume
      await runtime.settle();

      const flaskId = runtime.idFor('flask')!;
      const phObservations = runtime.getObservations(flaskId).filter((o) => o.type === 'PH');
      expect(phObservations.length).toBeGreaterThan(0);
      const latest = phObservations[phObservations.length - 1]!;

      // This is the real bridge's own method id/evidence, not anything this surface invents.
      expect(latest.methodId).toBe(AGENT06_METHOD_ID);
      expect(latest.evidence).toBe('MODEL_CALCULATED');
      expect(latest.quantity.value).toBeCloseTo(7, 1);

      runtime.markEndpoint();
      const events = runtime.getEventLog();
      const lastRecord = events[events.length - 1]!;
      expect(lastRecord.outcome).toBe('APPLIED');
    },
    20_000,
  );
});
