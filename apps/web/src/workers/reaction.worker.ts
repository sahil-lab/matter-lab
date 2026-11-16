import { runExperiment, serializeExperimentResult } from '@matterlab/reactions';
import type { ExperimentInput, ExperimentStepId } from '@matterlab/reactions';
import { serve } from '../science/rpc';

export interface ReactionProgress {
  readonly fraction: number;
  readonly step: ExperimentStepId;
}

/**
 * Runs reaction experiments off the main thread. The result travels back as the same JSON text
 * that is written when an experiment is saved, so what is shown is exactly what can be reopened.
 */
const methods = {
  run({ input }: { input: ExperimentInput }, progress: (value: ReactionProgress) => void): string {
    let last = 0;
    const result = runExperiment(input, {
      onProgress(fraction, step) {
        // The integrator reports after every step; a few hundred messages are plenty.
        if (fraction - last >= 0.004 || fraction >= 1) {
          last = fraction;
          progress({ fraction, step });
        }
      },
    });
    return serializeExperimentResult(result);
  },
};

export type ReactionMethods = typeof methods;

serve(methods);
