import { beforeEach, describe, expect, it } from 'vitest';
import { createInMemoryAttemptRepository } from '../persistence';
import {
  deleteAttempt,
  exportNotebookJson,
  finishAttempt,
  refreshAttempts,
  setAttemptRepository,
  setMode,
  toggleCompare,
  useChallenges,
  useFixtureDemoSource,
  useLiveSource,
} from './challengesStore';

function driveOneGuidedTitration(markedVolumeL = 0.025): void {
  const runtime = useFixtureDemoSource();
  setMode('guided');
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
  runtime.deliverTo(markedVolumeL);
  runtime.markEndpoint();
}

describe('challengesStore', () => {
  beforeEach(() => {
    setAttemptRepository(createInMemoryAttemptRepository());
    useLiveSource();
  });

  it('starts honestly "not connected" until a source is attached', () => {
    const s = useChallenges.getState();
    expect(s.source.connectionStatus).toBe('not-connected');
    expect(s.ctx.scene).toBeNull();
    expect(s.evaluation.complete).toBe(false);
    expect(s.score).toBeNull();
  });

  it('never throws exporting a notebook that does not exist yet', () => {
    expect(() => exportNotebookJson()).not.toThrow();
  });

  it('drives a full guided attempt through the fixture demo source, scores it and saves it', async () => {
    driveOneGuidedTitration();
    const state = useChallenges.getState();
    expect(state.evaluation.complete).toBe(true);
    expect(state.score).not.toBeNull();
    expect(state.notebook).not.toBeNull();
    expect(state.hint).toBeNull(); // every step satisfied

    const summary = await finishAttempt();
    expect(summary).not.toBeNull();
    await refreshAttempts();
    expect(useChallenges.getState().attempts).toHaveLength(1);
    expect(useChallenges.getState().achievements.find((a) => a.id === 'first-titration')!.earned).toBe(true);
  });

  it('compares two saved attempts once both are selected', async () => {
    driveOneGuidedTitration(0.0249);
    const first = await finishAttempt();
    driveOneGuidedTitration(0.0255);
    const second = await finishAttempt();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    toggleCompare(first!.id);
    toggleCompare(second!.id);
    // comparison loads asynchronously; give the microtask queue a turn.
    await Promise.resolve();
    await Promise.resolve();
    expect(useChallenges.getState().comparison).not.toBeNull();
    expect(useChallenges.getState().comparison!.metrics.length).toBeGreaterThan(0);

    await deleteAttempt(first!.id);
    expect(useChallenges.getState().attempts).toHaveLength(1);
  });
});
