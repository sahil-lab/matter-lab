/**
 * Default, on-device attempt repository, following the exact pattern the existing Reaction
 * Laboratory and Discovery Vault already use (`state/db.ts`). Agent 09 owns durable server-side
 * persistence; once `/api/v1/lab/...` exists, swap this for an HTTP-backed
 * `ChallengeAttemptRepository` without changing any caller.
 */

import { deleteOne, getAll, getOne, putOne } from '../../../state/db';
import type { ChallengeAttempt, ChallengeAttemptRepository, ChallengeAttemptSummary } from './types';
import { summarise } from './types';

export function createIndexedDbAttemptRepository(): ChallengeAttemptRepository {
  return {
    async list(): Promise<readonly ChallengeAttemptSummary[]> {
      const records = await getAll<ChallengeAttempt>('labAttempts');
      return records.map(summarise).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    },
    get(id: string): Promise<ChallengeAttempt | undefined> {
      return getOne<ChallengeAttempt>('labAttempts', id);
    },
    async save(attempt: ChallengeAttempt): Promise<void> {
      await putOne('labAttempts', attempt);
    },
    async remove(id: string): Promise<void> {
      await deleteOne('labAttempts', id);
    },
  };
}
