import { describe, expect, it } from 'vitest';
import { createChallengeController } from './controller.ts';
import { buildTrialNotebook, compareTrialPair, trialPlotPoints, trialReplayFrames } from './notebook.ts';
import { parseLearningStateJson, serializeLearningState } from './persistence.ts';
import { evaluatePredicate } from './predicates.ts';
import { recordedTrialFixture } from './recorded-trial-fixture.ts';
import { evaluateTrial, summarizeTrials } from './scoring.ts';

describe('pure scoring against science-backed canonical event fixtures (not live-runtime journeys)', () => {
  it('captures a real solver sample only after accepted fixture preparation, sensor, delivery and stopcock evidence', () => {
    const fixture = recordedTrialFixture('guided');
    fixture.prepare();
    const beforeClose = fixture.deliver(0.025);
    expect(fixture.capture(beforeClose).ok).toBe(false);
    const endpoint = fixture.close();
    expect(endpoint.sequence).toBeLessThan(fixture.reader.snapshot.lastSequence);
    expect(fixture.capture(endpoint).ok).toBe(true);
    expect(fixture.controller.getSnapshot().evaluation.score.complete).toBe(false);
    expect(fixture.conclude().ok).toBe(true);
    const view = fixture.controller.getSnapshot();
    expect(view.evaluation.score.complete).toBe(true);
    expect(view.evaluation.score.total).toBe(view.evaluation.score.maximum);
    expect(view.trial.endpoint?.observationId).toBe(endpoint.id);
    expect(view.trial.endpoint?.deliveredVolume.value).toBe(0.025);
    const plot = trialPlotPoints(view.trial, view.attempt.definition);
    expect(plot.at(-1)?.pH).toBe(endpoint.observation.quantity.value);
    expect(plot.every((point) => view.trial.observations.some((record) => record.id === point.observationId))).toBe(true);
    fixture.controller.dispose();
  });

  it('keeps an overshoot, refuses backdating and does not equate a captured endpoint with equivalence', () => {
    const fixture = recordedTrialFixture('guided');
    fixture.prepare();
    const nearTarget = fixture.deliver(0.025);
    fixture.deliver(0.026);
    const overshoot = fixture.close();
    expect(fixture.controller.captureEndpoint({ observationId: nearTarget.id, basis: 'instrument-reading' }).ok).toBe(false);
    expect(fixture.capture(overshoot).ok).toBe(true);
    expect(fixture.conclude('after').ok).toBe(true);
    const view = fixture.controller.getSnapshot();
    expect(view.evaluation.endpointPosition).toBe('after');
    expect(view.evaluation.goals.find((goal) => goal.id === 'endpoint')?.state).toBe('complete');
    expect(view.evaluation.goals.find((goal) => goal.id === 'target')?.state).toBe('pending');
    expect(view.evaluation.goals.find((goal) => goal.id === 'target')?.reasons.join(' ')).toContain('Overshoot');
    expect(view.evaluation.score.complete).toBe(false);
    expect(view.evaluation.score.total).toBeLessThan(view.evaluation.score.maximum);
    fixture.controller.dispose();
  });

  it('requires an accepted probe selection, not merely a supported equilibrium calculation', () => {
    const fixture = recordedTrialFixture();
    fixture.prepare(false);
    fixture.deliver(0.025);
    const endpoint = fixture.close();
    expect(endpoint.observation.evidence).toBe('MODEL_CALCULATED');
    expect(fixture.capture(endpoint).ok).toBe(false);
    expect(fixture.controller.getSnapshot().evaluation.goals.find((goal) => goal.id === 'probe')?.state).toBe('pending');
    fixture.controller.dispose();
  });

  it('reports a misread meniscus separately from the actual immutable delivered quantity', () => {
    const fixture = recordedTrialFixture('guided');
    fixture.prepare();
    fixture.deliver(0.02);
    const endpoint = fixture.close();
    expect(fixture.capture(endpoint, 0.03).ok).toBe(true);
    const view = fixture.controller.getSnapshot();
    expect(view.trial.endpoint?.deliveredVolume.value).toBe(0.02);
    expect(evaluatePredicate(view.trial, view.attempt.definition, { kind: 'instrumentRead', source: 'burette', receiver: 'receiver' }).state).toBe('pending');
    expect(view.evaluation.score.complete).toBe(false);
    fixture.controller.dispose();
  });

  it('does not fall back to an older supported sample after an unsupported latest receiver output', () => {
    const fixture = recordedTrialFixture();
    fixture.prepare();
    fixture.deliver(0.025);
    const earlier = fixture.close();
    fixture.observe(fixture.ids.flaskId, 'UNSUPPORTED');
    expect(fixture.controller.getSnapshot().evaluation.eligibleObservationIds).toEqual([]);
    expect(fixture.controller.captureEndpoint({ observationId: earlier.id, basis: 'instrument-reading' }).ok).toBe(false);
    fixture.controller.dispose();
  });

  it('freezes prior trial evidence across display renders and old-epoch RESET receipts; repeats are distinct scopes', () => {
    const fixture = recordedTrialFixture();
    const results: string[] = [];
    for (const volume of [0.0249, 0.025, 0.0251]) {
      if (results.length) fixture.reset();
      fixture.prepare();
      fixture.deliver(volume);
      expect(fixture.capture(fixture.close()).ok).toBe(true);
      expect(fixture.conclude().ok).toBe(true);
      results.push(fixture.controller.getSnapshot().trial.id);
    }
    const attempt = fixture.controller.exportAttempt();
    const first = attempt.trials[0]!;
    const serializedFirst = JSON.stringify(first);
    const view = fixture.controller.getSnapshot();
    expect(view.evaluation.statistics.count).toBe(3);
    expect(view.evaluation.statistics.meanVolumeL).toBeCloseTo(0.025, 12);
    expect(view.evaluation.statistics.sampleStandardDeviationL).toBeCloseTo(0.0001, 12);
    expect(view.evaluation.statistics.uncertaintyStatement).toContain('not experimental uncertainty');
    expect(view.evaluation.score.complete).toBe(true);
    expect(view.evaluation.score.total).toBe(100);
    const firstScore = evaluateTrial(attempt, first.id).score;
    expect(firstScore.complete).toBe(false);
    expect(fixture.controller.beginTrial().ok).toBe(false);
    fixture.controller.setInstructionIndex(6);
    trialReplayFrames(first);
    trialPlotPoints(first, attempt.definition);
    expect(JSON.stringify(fixture.controller.exportAttempt().trials[0])).toBe(serializedFirst);
    expect(evaluateTrial(fixture.controller.exportAttempt(), first.id).score).toEqual(firstScore);
    expect(summarizeTrials([...attempt.trials, { ...first, id: fixture.makeId() }], attempt.definition).count).toBe(3);
    fixture.controller.dispose();
  });

  it('reproduces scores on JSON restore and exports complete provenance without running or duplicating actions', () => {
    const fixture = recordedTrialFixture('guided');
    fixture.prepare();
    fixture.deliver(0.025);
    expect(fixture.capture(fixture.close()).ok).toBe(true);
    fixture.conclude();
    const attempt = fixture.controller.exportAttempt();
    const json = serializeLearningState({ schemaVersion: 1, kind: 'MATTERLAB_LEARNING_STATE', attempts: [attempt] });
    const restoredAttempt = parseLearningStateJson(json).attempts[0]!;
    const restored = createChallengeController({ ...fixture.options, attempt: restoredAttempt });
    expect(restored.getSnapshot().evaluation.score).toEqual(fixture.controller.getSnapshot().evaluation.score);
    expect(restored.exportAttempt()).toEqual(attempt);
    const notebook = buildTrialNotebook(restored.exportAttempt());
    expect(notebook.learningState.attempts[0]!.trials[0]!.observations).toEqual(attempt.trials[0]!.observations);
    expect(notebook.rows[0]!.sourceIds.length).toBeGreaterThan(0);
    expect(notebook.rows[0]!.pH).toBe(attempt.trials[0]!.observations.find((record) => record.id === attempt.trials[0]!.endpoint!.observationId)!.observation.quantity.value);
    expect(compareTrialPair(attempt, attempt.activeTrialId, attempt.activeTrialId).comparable).toBe(false);
    restored.dispose();
    fixture.controller.dispose();
  });

  it('keeps cross-station comparisons out of same-station precision goals and rejects foreign citations', () => {
    const fixture = recordedTrialFixture();
    fixture.prepare();
    fixture.deliver(0.025);
    fixture.capture(fixture.close());
    const trial = fixture.controller.getSnapshot().trial;
    expect(fixture.controller.recordConclusion({
      text: 'Foreign evidence is not a valid conclusion.', citedObservationIds: [fixture.makeId()],
      equivalenceAndEndpoint: 'distinct', endpointPosition: 'within', acknowledgesModelLimits: true,
      concentration: fixture.truth.initialConcentration,
    }).ok).toBe(false);
    const foreign = { ...trial, id: fixture.makeId(), scope: { ...trial.scope, stationId: fixture.ids.blankStationId } };
    const attempt = { ...fixture.controller.exportAttempt(), trials: [foreign, trial] };
    expect(evaluateTrial(attempt, trial.id).statistics.count).toBe(1);
    expect(evaluateTrial(attempt, trial.id).score.complete).toBe(false);
    fixture.controller.dispose();
  });
});
