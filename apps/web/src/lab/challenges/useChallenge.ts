import { useSyncExternalStore } from 'react';
import type { ChallengeController } from './types.ts';

export function useChallenge(controller: ChallengeController) {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}
