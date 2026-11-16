import type { Evidence } from '../contracts';

export type RubricDimensionId = 'setup' | 'instrumentOperation' | 'endpointDetection' | 'measurementRepeatability' | 'interpretation';

export interface RubricDimensionScore {
  readonly id: RubricDimensionId;
  readonly label: string;
  /** 0..1. Never set from animation state — always a function of the event log / run results. */
  readonly score01: number;
  readonly weight: number;
  readonly evidence: Evidence;
  readonly detail: string;
}

export type ScoreBand = 'novice' | 'developing' | 'proficient' | 'exemplary';

export interface ScoreBreakdown {
  readonly overall01: number;
  readonly band: ScoreBand;
  readonly dimensions: readonly RubricDimensionScore[];
  /** How many events/trials this score was computed from, so "0 events -> 0 score" is visible, not mysterious. */
  readonly basedOnEventCount: number;
  readonly basedOnTrialCount: number;
  readonly computedAtSimulationS: number;
  /** Same objective + same event log + same run results always produce the same score. */
  readonly deterministic: true;
}
