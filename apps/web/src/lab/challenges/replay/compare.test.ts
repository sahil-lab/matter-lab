import { describe, expect, it } from 'vitest';
import { buildPrecisionFixtureContext } from '../fixtures/strongAcidStrongBaseFixture';
import { PRECISION_TITRATION_OBJECTIVE } from '../titrationObjective';
import { buildNotebook } from '../notebook';
import type { ChallengeAttempt } from '../persistence';
import { scoreAttempt } from '../scoring';
import { compareAttempts } from './compare';

function attemptFrom(markedVolumesL: readonly number[], id: string): ChallengeAttempt {
  const ctx = buildPrecisionFixtureContext(markedVolumesL);
  return {
    id,
    objectiveId: PRECISION_TITRATION_OBJECTIVE.id,
    objectiveTitle: PRECISION_TITRATION_OBJECTIVE.title,
    mode: 'precision',
    startedAt: '2025-01-01T00:00:00.000Z',
    savedAt: '2025-01-01T00:05:00.000Z',
    trials: ctx.trials,
    score: scoreAttempt(PRECISION_TITRATION_OBJECTIVE, ctx),
    notebook: buildNotebook(PRECISION_TITRATION_OBJECTIVE, ctx),
  };
}

describe('compareAttempts', () => {
  it('flags the more repeatable attempt as better on the RSD metric', () => {
    const tight = attemptFrom([0.0249, 0.025, 0.0251], 'tight');
    const loose = attemptFrom([0.02, 0.025, 0.032], 'loose');
    const comparison = compareAttempts(tight, loose, 'Tight', 'Loose');
    const rsd = comparison.metrics.find((m) => m.id === 'rsd')!;
    expect(rsd.betterSide).toBe('a');
    const meanVolume = comparison.metrics.find((m) => m.id === 'meanVolume')!;
    expect(meanVolume.betterSide).toBeNull();
  });

  it('is symmetric: swapping the two attempts swaps the better side', () => {
    const tight = attemptFrom([0.0249, 0.025, 0.0251], 'tight');
    const loose = attemptFrom([0.02, 0.025, 0.032], 'loose');
    const swapped = compareAttempts(loose, tight);
    const rsd = swapped.metrics.find((m) => m.id === 'rsd')!;
    expect(rsd.betterSide).toBe('b');
  });
});
