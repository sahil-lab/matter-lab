/** In-memory repository: used by unit tests and as a safe fallback where IndexedDB is unavailable. */

import type { ChallengeAttempt, ChallengeAttemptRepository, ChallengeAttemptSummary } from './types';
import { summarise } from './types';

export function createInMemoryAttemptRepository(): ChallengeAttemptRepository {
  const records = new Map<string, ChallengeAttempt>();
  return {
    async list(): Promise<readonly ChallengeAttemptSummary[]> {
      return [...records.values()].map(summarise).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    },
    async get(id: string): Promise<ChallengeAttempt | undefined> {
      return records.get(id);
    },
    async save(attempt: ChallengeAttempt): Promise<void> {
      records.set(attempt.id, attempt);
    },
    async remove(id: string): Promise<void> {
      records.delete(id);
    },
  };
}
