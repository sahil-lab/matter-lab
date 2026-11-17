import { beforeEach, describe, expect, it } from 'vitest';
import { createFakeStrongAcidStrongBaseSolverClient } from '../../experiments/testFixtures/fakeSolverClient';
import { createInMemoryAttemptRepository } from '../persistence';
import { HCL_SPECIES_ID, NAOH_SPECIES_ID } from '../titrationObjective';
import {
  deleteAttempt,
  exportNotebookJson,
  finishAttempt,
  refreshAttempts,
  setAttemptRepository,
  setMode,
  toggleCompare,
  useChallenges,
  useLiveSource,
  useRealEngineSource,
} from './challengesStore';

/**
 * Drives one full guided titration through a real `ExperimentEngine` station (Agent 07's actual
 * runtime), using a fast, in-process, clearly-labelled test solver double (Agent 07's own
 * `createFakeStrongAcidStrongBaseSolverClient`) instead of shelling out to Agent 06's real Python
 * bridge on every assertion — `integration/realEngineSource.test.ts` separately proves the real
 * bridge works. `await settle()` is required after every FILL/TRANSFER on the flask: the engine's
 * observation ledger discards a response as stale once a newer request for the same container has
 * already been issued, so this mirrors how a real user would see one reading land before adding more.
 */
async function driveOneGuidedTitration(markedVolumeL = 0.025): Promise<void> {
  const runtime = useRealEngineSource(createFakeStrongAcidStrongBaseSolverClient({ acidSpeciesId: HCL_SPECIES_ID, baseSpeciesId: NAOH_SPECIES_ID }));
  setMode('guided');
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
  // At least 3 pH readings before marking the endpoint, finishing exactly at `markedVolumeL`.
  for (const step of [markedVolumeL * 0.4, markedVolumeL * 0.4, markedVolumeL * 0.2]) {
    runtime.deliverIncrement(step);
    await runtime.settle();
  }
  runtime.markEndpoint();
  await runtime.settle();
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

  it('drives a full guided attempt through a real engine source, scores it and saves it', async () => {
    await driveOneGuidedTitration();
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
    await driveOneGuidedTitration(0.0249);
    const first = await finishAttempt();
    await driveOneGuidedTitration(0.0255);
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
