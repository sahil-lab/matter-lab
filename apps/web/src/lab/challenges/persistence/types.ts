import type { UUID } from '../contracts';
import type { GameMode, TrialRecord } from '../goals';
import type { NotebookData } from '../notebook';
import type { ScoreBand, ScoreBreakdown } from '../scoring';

/**
 * One finished, scored pass at an objective. Everything needed to reproduce the score and
 * notebook offline is included — `trials` is the exact saved event/run-result data the score was
 * computed from, so reopening this record and re-running `scoreAttempt` reproduces `score` exactly.
 */
export interface ChallengeAttempt {
  readonly id: UUID;
  readonly objectiveId: string;
  readonly objectiveTitle: string;
  readonly mode: GameMode;
  readonly startedAt: string;
  readonly savedAt: string;
  readonly trials: readonly TrialRecord[];
  readonly score: ScoreBreakdown;
  readonly notebook: NotebookData;
}

/** A row in the attempt list/history, without the bulky per-trial event logs. */
export interface ChallengeAttemptSummary {
  readonly id: UUID;
  readonly objectiveId: string;
  readonly objectiveTitle: string;
  readonly mode: GameMode;
  readonly savedAt: string;
  readonly overallScore01: number;
  readonly band: ScoreBand;
  readonly trialCount: number;
}

export function summarise(attempt: ChallengeAttempt): ChallengeAttemptSummary {
  return {
    id: attempt.id,
    objectiveId: attempt.objectiveId,
    objectiveTitle: attempt.objectiveTitle,
    mode: attempt.mode,
    savedAt: attempt.savedAt,
    overallScore01: attempt.score.overall01,
    band: attempt.score.band,
    trialCount: attempt.trials.length,
  };
}

/**
 * Agent 09 owns durable persistence. This interface is swappable: the default implementation
 * (`indexedDbAttemptRepository`) stores attempts on-device, exactly as the existing Reaction
 * Laboratory and Discovery Vault do today, until Agent 09's `/api/v1/lab/...` endpoints exist.
 */
export interface ChallengeAttemptRepository {
  list(): Promise<readonly ChallengeAttemptSummary[]>;
  get(id: UUID): Promise<ChallengeAttempt | undefined>;
  save(attempt: ChallengeAttempt): Promise<void>;
  remove(id: UUID): Promise<void>;
}
