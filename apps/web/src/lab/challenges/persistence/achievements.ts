/** Achievements are derived, not stored: recomputing them from the same attempts always agrees. */

import type { Evidence } from '../contracts';
import type { ChallengeAttempt } from './types';

export interface Achievement {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly earned: boolean;
  readonly evidence: Evidence;
}

export function deriveAchievements(attempts: readonly ChallengeAttempt[]): readonly Achievement[] {
  const completedTrials = attempts.reduce((sum, a) => sum + a.trials.filter((t) => t.endpoint !== null).length, 0);
  const sharpEye = attempts.some((a) => (a.score.dimensions.find((d) => d.id === 'endpointDetection')?.score01 ?? 0) >= 0.9);
  const precisionGood = attempts.some((a) => a.mode === 'precision' && a.notebook.rsdPercent !== null && a.notebook.rsdPercent <= 2 && a.trials.length >= 3);
  return [
    {
      id: 'first-titration',
      title: 'First titration',
      description: 'Completed a full titration from an empty workbench to a marked endpoint.',
      earned: completedTrials > 0,
      evidence: 'MODEL_CALCULATED',
    },
    {
      id: 'sharp-eye',
      title: 'Sharp eye',
      description: 'Marked an endpoint within 0.2 mL of the computed equivalence point.',
      earned: sharpEye,
      evidence: 'MODEL_CALCULATED',
    },
    {
      id: 'precision-master',
      title: 'Precision master',
      description: 'Repeated a titration at least 3 times with 2% or better repeatability.',
      earned: precisionGood,
      evidence: 'MODEL_CALCULATED',
    },
    {
      id: 'repeat-performer',
      title: 'Repeat performer',
      description: 'Completed 5 or more trials in total.',
      earned: completedTrials >= 5,
      evidence: 'MODEL_CALCULATED',
    },
  ];
}
