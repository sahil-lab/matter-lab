import { describe, expect, it } from 'vitest';
import { buildFixtureContext } from '../fixtures/strongAcidStrongBaseFixture';
import { buildNotebook } from '../notebook';
import { GUIDED_TITRATION_OBJECTIVE } from '../titrationObjective';
import { scoreAttempt } from '../scoring';
import { deriveAchievements } from './achievements';
import { createInMemoryAttemptRepository } from './memoryStore';
import type { ChallengeAttempt } from './types';

function sampleAttempt(id: string): ChallengeAttempt {
  const ctx = buildFixtureContext();
  return {
    id,
    objectiveId: GUIDED_TITRATION_OBJECTIVE.id,
    objectiveTitle: GUIDED_TITRATION_OBJECTIVE.title,
    mode: 'guided',
    startedAt: '2025-01-01T00:00:00.000Z',
    savedAt: '2025-01-01T00:05:00.000Z',
    trials: ctx.trials,
    score: scoreAttempt(GUIDED_TITRATION_OBJECTIVE, ctx),
    notebook: buildNotebook(GUIDED_TITRATION_OBJECTIVE, ctx),
  };
}

describe('createInMemoryAttemptRepository', () => {
  it('saves, lists, fetches and removes attempts without touching authoritative experiment state', async () => {
    const repo = createInMemoryAttemptRepository();
    await repo.save(sampleAttempt('attempt-1'));
    const list = await repo.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.overallScore01).toBeGreaterThan(0);

    const fetched = await repo.get('attempt-1');
    expect(fetched?.trials).toHaveLength(1);

    await repo.remove('attempt-1');
    expect(await repo.list()).toHaveLength(0);
  });
});

describe('deriveAchievements', () => {
  it('derives badges from attempt history rather than storing them redundantly', () => {
    const noneYet = deriveAchievements([]);
    expect(noneYet.every((a) => !a.earned)).toBe(true);

    const withOne = deriveAchievements([sampleAttempt('attempt-1')]);
    expect(withOne.find((a) => a.id === 'first-titration')!.earned).toBe(true);
    expect(withOne.find((a) => a.id === 'repeat-performer')!.earned).toBe(false);
  });
});
