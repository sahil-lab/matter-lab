import type { Evidence, UUID } from '../contracts';
import type { ScoreBreakdown } from '../scoring';

export interface ReplayStep {
  readonly index: number;
  readonly atSimulationS: number;
  readonly description: string;
  readonly cumulativeVolumeL: number;
  readonly latestPh: number | null;
}

export interface ReplayTimeline {
  readonly trialId: UUID;
  readonly steps: readonly ReplayStep[];
}

export interface AttemptComparisonMetric {
  readonly id: string;
  readonly label: string;
  readonly unit: string;
  readonly a: number | null;
  readonly b: number | null;
  /** Which attempt is better on this metric, or `null` when the metric has no "better" direction or data is missing. */
  readonly betterSide: 'a' | 'b' | 'tie' | null;
}

export interface AttemptComparisonSide {
  readonly label: string;
  readonly score: ScoreBreakdown;
  readonly meanVolumeL: number | null;
  readonly rsdPercent: number | null;
  readonly evidence: Evidence;
}

export interface AttemptComparison {
  readonly a: AttemptComparisonSide;
  readonly b: AttemptComparisonSide;
  readonly metrics: readonly AttemptComparisonMetric[];
}
