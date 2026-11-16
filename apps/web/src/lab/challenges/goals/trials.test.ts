import { describe, expect, it } from 'vitest';
import { FixtureDemoRuntime, DEMO_STATION_ID } from '../demo';
import { GUIDED_TITRATION_OBJECTIVE } from '../titrationObjective';
import { scoreAttempt } from '../scoring';
import { evaluateObjective } from './objective';
import { deriveTrialsFromLog, withInterpretations } from './trials';
import type { EvaluationContext } from './types';

/** Drives the demo runtime through the whole guided titration, the way the mode store will. */
function runThroughGuidedTitration(runtime: FixtureDemoRuntime): void {
  runtime.placeApparatus('stand');
  runtime.placeApparatus('clamp');
  runtime.attach('clamp', 'stand');
  runtime.placeApparatus('burette');
  runtime.attach('burette', 'clamp');
  runtime.placeApparatus('flask');
  runtime.fillHcl();
  runtime.fillNaoh();
  runtime.openStopcock(0.3);
  for (let mL = 2; mL <= 24; mL += 2) runtime.deliverTo(mL / 1000);
  runtime.deliverTo(0.025);
  runtime.markEndpoint();
}

describe('FixtureDemoRuntime end-to-end through deriveTrialsFromLog', () => {
  it('drives a real user-interaction sequence into a satisfied objective and a reasonable score', () => {
    const runtime = new FixtureDemoRuntime();
    runThroughGuidedTitration(runtime);

    const events = runtime.getEvents(DEMO_STATION_ID);
    const runResults = runtime.getRunResults(DEMO_STATION_ID);
    const trials = deriveTrialsFromLog(events, runResults);
    expect(trials).toHaveLength(1);
    expect(trials[0]!.endpoint).not.toBeNull();

    const ctx: EvaluationContext = { scene: runtime.getScene(DEMO_STATION_ID), events, runResults, trials, nowSimulationS: events.length };
    const evaluation = evaluateObjective(GUIDED_TITRATION_OBJECTIVE, ctx);
    expect(evaluation.complete).toBe(true);

    const score = scoreAttempt(GUIDED_TITRATION_OBJECTIVE, ctx);
    expect(score.overall01).toBeGreaterThan(0.5);
  });

  it('keeps each repeat trial independent and applies learner interpretations without touching the log', () => {
    const runtime = new FixtureDemoRuntime();
    runtime.placeApparatus('stand');
    runtime.placeApparatus('clamp');
    runtime.attach('clamp', 'stand');
    runtime.placeApparatus('burette');
    runtime.attach('burette', 'clamp');
    runtime.placeApparatus('flask');
    runtime.fillHcl();
    runtime.fillNaoh();
    runtime.openStopcock(0.3);
    runtime.deliverTo(0.025);
    runtime.markEndpoint();
    runtime.startNewTrial();
    runtime.deliverTo(0.0252);
    runtime.markEndpoint();

    const trials = deriveTrialsFromLog(runtime.getEvents(DEMO_STATION_ID), runtime.getRunResults(DEMO_STATION_ID));
    expect(trials).toHaveLength(2);
    expect(trials[0]!.endpoint!.deliveredVolumeL).toBeCloseTo(0.025, 6);
    expect(trials[1]!.endpoint!.deliveredVolumeL).toBeCloseTo(0.0252, 6);
    // Each trial's own run result only contains that trial's observations.
    expect(trials[0]!.runResults).toHaveLength(1);
    expect(trials[1]!.runResults).toHaveLength(1);
    expect(trials[0]!.runResults[0]!.runId).not.toBe(trials[1]!.runResults[0]!.runId);

    const withAnswers = withInterpretations(trials, new Map([[trials[0]!.trialId, { reportedAnalyteMolarity: 0.1 }]]));
    expect(withAnswers[0]!.reportedAnalyteMolarity).toBe(0.1);
    expect(withAnswers[1]!.reportedAnalyteMolarity).toBeUndefined();
  });
});
