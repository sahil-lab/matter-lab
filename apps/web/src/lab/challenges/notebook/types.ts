import type { Evidence, UUID } from '../contracts';

export interface NotebookTrialRow {
  readonly trialId: UUID;
  /** 1-based, in the order trials were recorded. */
  readonly index: number;
  readonly deliveredVolumeL: number | null;
  readonly equivalenceVolumeL: number | null;
  readonly deviationL: number | null;
  readonly reportedAnalyteMolarity: number | null;
  readonly expectedAnalyteMolarity: number | null;
  readonly evidence: Evidence;
}

export interface NotebookCurvePoint {
  readonly volumeL: number;
  readonly ph: number;
}

export interface NotebookCurve {
  readonly trialId: UUID;
  readonly trialIndex: number;
  readonly points: readonly NotebookCurvePoint[];
  readonly evidence: Evidence;
}

export interface NotebookConclusion {
  readonly headline: string;
  readonly paragraphs: readonly string[];
  readonly evidence: Evidence;
}

export interface NotebookData {
  readonly objectiveTitle: string;
  readonly rows: readonly NotebookTrialRow[];
  readonly curves: readonly NotebookCurve[];
  readonly meanVolumeL: number | null;
  readonly stdDevVolumeL: number | null;
  readonly rsdPercent: number | null;
  readonly conclusion: NotebookConclusion;
  readonly generatedAtSimulationS: number;
}
