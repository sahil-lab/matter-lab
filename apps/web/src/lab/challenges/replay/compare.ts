/** Compares two saved, already-scored attempts. Pure: works entirely from persisted data. */

import type { ChallengeAttempt } from '../persistence';
import type { AttemptComparison, AttemptComparisonMetric, AttemptComparisonSide } from './types';

type Direction = 'lowerBetter' | 'higherBetter' | 'neutral';

function sideOf(attempt: ChallengeAttempt, label: string): AttemptComparisonSide {
  return {
    label,
    score: attempt.score,
    meanVolumeL: attempt.notebook.meanVolumeL,
    rsdPercent: attempt.notebook.rsdPercent,
    evidence: attempt.notebook.conclusion.evidence,
  };
}

function metric(id: string, label: string, unit: string, a: number | null, b: number | null, direction: Direction): AttemptComparisonMetric {
  let betterSide: 'a' | 'b' | 'tie' | null = null;
  if (direction !== 'neutral' && a !== null && b !== null) {
    if (a === b) betterSide = 'tie';
    else betterSide = direction === 'lowerBetter' ? (a < b ? 'a' : 'b') : a > b ? 'a' : 'b';
  }
  return { id, label, unit, a, b, betterSide };
}

export function compareAttempts(a: ChallengeAttempt, b: ChallengeAttempt, labelA = 'Attempt A', labelB = 'Attempt B'): AttemptComparison {
  const metrics: AttemptComparisonMetric[] = [
    metric('overall', 'Overall score', '%', a.score.overall01 * 100, b.score.overall01 * 100, 'higherBetter'),
    ...a.score.dimensions.map((dim) => {
      const other = b.score.dimensions.find((d) => d.id === dim.id);
      return metric(dim.id, dim.label, '%', dim.score01 * 100, other ? other.score01 * 100 : null, 'higherBetter');
    }),
    metric('meanVolume', 'Mean endpoint volume', 'mL', a.notebook.meanVolumeL !== null ? a.notebook.meanVolumeL * 1000 : null, b.notebook.meanVolumeL !== null ? b.notebook.meanVolumeL * 1000 : null, 'neutral'),
    metric('rsd', 'Repeatability (RSD)', '%', a.notebook.rsdPercent, b.notebook.rsdPercent, 'lowerBetter'),
  ];
  return { a: sideOf(a, labelA), b: sideOf(b, labelB), metrics };
}
