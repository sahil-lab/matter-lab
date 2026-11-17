import { describe, expect, it } from 'vitest';
import { buildFixtureContext } from '../fixtures/strongAcidStrongBaseFixture';
import { CHALLENGE_TITRATION_OBJECTIVE, GUIDED_TITRATION_OBJECTIVE } from '../titrationObjective';
import { evaluateObjective } from './objective';
import type { EvaluationContext } from './types';

describe('evaluateObjective (strong acid / strong base guided titration)', () => {
  it('reports every step unmet against an empty context', () => {
    const empty: EvaluationContext = { scene: null, events: [], observations: [], trials: [], nowSimulationS: 0 };
    const evaluation = evaluateObjective(GUIDED_TITRATION_OBJECTIVE, empty);
    expect(evaluation.completedCount).toBe(0);
    expect(evaluation.firstUnmetIndex).toBe(0);
    expect(evaluation.complete).toBe(false);
  });

  it('resolves every step and binds every role against a complete fixture trial', () => {
    const ctx = buildFixtureContext();
    const evaluation = evaluateObjective(GUIDED_TITRATION_OBJECTIVE, ctx);
    const unmet = evaluation.steps.filter((s) => !s.result.met).map((s) => `${s.step.id}: ${s.result.detail}`);
    expect(unmet).toEqual([]);
    expect(evaluation.completedCount).toBe(evaluation.totalCount);
    expect(evaluation.complete).toBe(true);
    expect(evaluation.bindings.stand).toBeDefined();
    expect(evaluation.bindings.clamp).toBeDefined();
    expect(evaluation.bindings.burette).toBeDefined();
    expect(evaluation.bindings.flask).toBeDefined();
  });

  it('does not mark the endpoint step met when the mark is far from the computed equivalence point', () => {
    const ctx = buildFixtureContext({ markedVolumeL: 0.025 + 0.01 }); // 10 mL past equivalence: well outside 4% tolerance
    const evaluation = evaluateObjective(GUIDED_TITRATION_OBJECTIVE, ctx);
    const endpointStep = evaluation.steps.find((s) => s.step.id === 'capture-endpoint')!;
    expect(endpointStep.result.met).toBe(false);
  });

  it('treats Free Experiment as having no forced objective', () => {
    const empty: EvaluationContext = { scene: null, events: [], observations: [], trials: [], nowSimulationS: 0 };
    const evaluation = evaluateObjective({ id: 'free', title: 'Free', summary: '', mode: 'free', steps: [], requiredTrials: 0 }, empty);
    expect(evaluation.complete).toBe(true);
    expect(evaluation.totalCount).toBe(0);
  });

  it('never completes Challenge mode merely because every apparatus exists; a wrong reagent concentration gives a specific, actionable reason', () => {
    const ctx = buildFixtureContext({ analyteMolarityMolPerL: 0.02 }); // prepared far too dilute (0.02 M, not ~0.1 M)
    const evaluation = evaluateObjective(CHALLENGE_TITRATION_OBJECTIVE, ctx);
    expect(evaluation.complete).toBe(false);
    const aliquotStep = evaluation.steps.find((s) => s.step.id === 'prepare-aliquot')!;
    expect(aliquotStep.result.met).toBe(false);
    expect(aliquotStep.result.detail).toContain('0.020'); // names the actual (wrong) concentration, not a generic failure
  });

  it('does not let an unrelated UI action (no matching observed event) silently satisfy a goal', () => {
    // A scene with every apparatus placed and connected, but no FILL/TRANSFER/observation events at all.
    const ctx = buildFixtureContext();
    const noEvents: EvaluationContext = { ...ctx, events: [], observations: [], trials: [] };
    const evaluation = evaluateObjective(GUIDED_TITRATION_OBJECTIVE, noEvents);
    const stopcockStep = evaluation.steps.find((s) => s.step.id === 'open-stopcock')!;
    expect(stopcockStep.result.met).toBe(false);
    expect(evaluation.complete).toBe(false);
  });
});
