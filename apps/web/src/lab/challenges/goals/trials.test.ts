import { describe, expect, it } from 'vitest';
import { createFakeStrongAcidStrongBaseSolverClient } from '../../experiments/testFixtures/fakeSolverClient';
import { RealEngineRuntimeSource } from '../integration/realEngineSource';
import { HCL_SPECIES_ID, GUIDED_TITRATION_OBJECTIVE, NAOH_SPECIES_ID } from '../titrationObjective';
import { scoreAttempt } from '../scoring';
import { evaluateObjective } from './objective';
import { deriveTrialsFromLog, withInterpretations } from './trials';
import type { EvaluationContext } from './types';

/** A real `ExperimentEngine` station driven by a fast, in-process, clearly-labelled test solver double (Agent 07's own `createFakeStrongAcidStrongBaseSolverClient`) instead of Agent 06's real Python bridge, so these tests stay fast; `integration/realEngineSource.test.ts` separately exercises the real bridge. */
function createTestRuntime(): RealEngineRuntimeSource {
  return new RealEngineRuntimeSource(createFakeStrongAcidStrongBaseSolverClient({ acidSpeciesId: HCL_SPECIES_ID, baseSpeciesId: NAOH_SPECIES_ID }));
}

/**
 * Drives the real engine through the whole guided titration, the way the mode store will.
 * Awaits `settle()` after every FILL/TRANSFER on the flask: the engine's observation ledger
 * discards a response as stale once a newer request for the same container has already been
 * issued (see `observationLedger.ts`), so firing several transfers back-to-back without awaiting
 * between them would silently collapse down to only the last reading — the same way a real user
 * would see one pH update land before making the next addition.
 */
async function runThroughGuidedTitration(runtime: RealEngineRuntimeSource): Promise<void> {
  runtime.placeStand();
  runtime.placeClamp();
  runtime.attachClampToStand();
  runtime.placeBurette();
  runtime.attachBuretteToClamp();
  runtime.placeFlask();
  runtime.connectBuretteToFlask();
  runtime.fillHcl();
  await runtime.settle();
  runtime.fillNaoh();
  runtime.setStopcock(0.3);
  for (let i = 0; i < 5; i++) {
    runtime.deliverIncrement(0.005);
    await runtime.settle();
  }
  runtime.markEndpoint();
  await runtime.settle();
}

describe('RealEngineRuntimeSource end-to-end through deriveTrialsFromLog', () => {
  it('drives a real user-interaction sequence into a satisfied objective and a reasonable score', async () => {
    const runtime = createTestRuntime();
    await runThroughGuidedTitration(runtime);

    const events = runtime.getEventLog();
    const observations = runtime.getObservations();
    const trials = deriveTrialsFromLog(events, observations);
    expect(trials).toHaveLength(1);
    expect(trials[0]!.endpoint).not.toBeNull();
    expect(trials[0]!.endpoint!.deliveredVolumeL).toBeCloseTo(0.025, 6);

    const ctx: EvaluationContext = { scene: runtime.getScene(), events, observations, trials, nowSimulationS: events.length };
    const evaluation = evaluateObjective(GUIDED_TITRATION_OBJECTIVE, ctx);
    const unmet = evaluation.steps.filter((s) => !s.result.met).map((s) => `${s.step.id}: ${s.result.detail}`);
    expect(unmet).toEqual([]);
    expect(evaluation.complete).toBe(true);

    const score = scoreAttempt(GUIDED_TITRATION_OBJECTIVE, ctx);
    expect(score.overall01).toBeGreaterThan(0.5);
  });

  it('keeps each repeat trial independent and applies learner interpretations without touching the log', async () => {
    const runtime = createTestRuntime();
    runtime.placeStand();
    runtime.placeClamp();
    runtime.attachClampToStand();
    runtime.placeBurette();
    runtime.attachBuretteToClamp();
    runtime.placeFlask();
    runtime.connectBuretteToFlask();
    runtime.fillHcl();
    await runtime.settle();
    runtime.fillNaoh();
    runtime.setStopcock(0.3);
    runtime.deliverIncrement(0.02);
    await runtime.settle();
    runtime.markEndpoint();
    runtime.startNewTrial();
    runtime.deliverIncrement(0.021);
    await runtime.settle();
    runtime.markEndpoint();

    const trials = deriveTrialsFromLog(runtime.getEventLog(), runtime.getObservations());
    expect(trials).toHaveLength(2);
    expect(trials[0]!.endpoint!.deliveredVolumeL).toBeCloseTo(0.02, 6);
    expect(trials[1]!.endpoint!.deliveredVolumeL).toBeCloseTo(0.021, 6);
    // Each trial's own observation slice only contains readings recorded during that trial: the
    // first trial sees its own FILL-triggered reading plus its own transfer; the second sees only
    // its own transfer's reading (the ledger cursor never re-visits an already-consumed reading).
    expect(trials[0]!.observations).toHaveLength(2);
    expect(trials[1]!.observations).toHaveLength(1);

    const withAnswers = withInterpretations(trials, new Map([[trials[0]!.trialId, { reportedAnalyteMolarity: 0.1 }]]));
    expect(withAnswers[0]!.reportedAnalyteMolarity).toBe(0.1);
    expect(withAnswers[1]!.reportedAnalyteMolarity).toBeUndefined();
  });
});
