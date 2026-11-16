import type { JobStatus } from '@matterlab/core';
import { create } from 'zustand';
import { JobCancelledError } from './rpc';

export type JobKind = 'optimize' | 'quantum' | 'surface' | 'reaction' | 'chemistry' | 'service';

/** One asynchronous calculation, local or remote, as the interface shows it. */
export interface LabJob {
  readonly id: string;
  readonly kind: JobKind;
  readonly title: string;
  /** What exactly is being computed, e.g. the method and the system. */
  readonly detail?: string;
  readonly status: JobStatus;
  /** Fraction complete, or `null` when the engine cannot say. */
  readonly progress: number | null;
  /** What the engine is doing right now. */
  readonly stage?: string;
  readonly startedAt: number;
  readonly finishedAt?: number;
  /** Why it failed or could not run. */
  readonly message?: string;
}

interface JobsState {
  readonly jobs: readonly LabJob[];
}

/** Recent calculations, newest first. Finished ones stay listed so their outcome can be read. */
export const useJobs = create<JobsState>()(() => ({ jobs: [] }));

const controllers = new Map<string, AbortController>();
const MAX_LISTED = 30;
let counter = 0;

function patch(id: string, change: Partial<LabJob>): void {
  useJobs.setState((s) => ({ jobs: s.jobs.map((job) => (job.id === id ? { ...job, ...change } : job)) }));
}

export interface JobContext {
  readonly signal: AbortSignal;
  /** Reports progress; `fraction` may be `null` when it is not known. */
  report(fraction: number | null, stage?: string): void;
}

/** Thrown by a task to say the engine cannot treat this system at all (as opposed to failing on it). */
export class UnsupportedJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedJobError';
  }
}

/**
 * Runs a calculation as a tracked job. The returned promise settles exactly as the task does;
 * the job list records whether it succeeded, failed, was cancelled, or was unsupported.
 */
export async function runJob<T>(spec: { kind: JobKind; title: string; detail?: string }, task: (context: JobContext) => Promise<T>): Promise<T> {
  const id = `job-${++counter}`;
  const controller = new AbortController();
  controllers.set(id, controller);
  const job: LabJob = { id, ...spec, status: 'running', progress: null, startedAt: Date.now() };
  useJobs.setState((s) => ({ jobs: [job, ...s.jobs].slice(0, MAX_LISTED) }));
  let lastReport = 0;
  try {
    const result = await task({
      signal: controller.signal,
      report(fraction, stage) {
        // Engines may report thousands of times a second; the interface needs a few.
        const now = performance.now();
        if (now - lastReport < 60 && fraction !== 1) return;
        lastReport = now;
        patch(id, { progress: fraction, ...(stage !== undefined ? { stage } : {}) });
      },
    });
    patch(id, { status: 'succeeded', progress: 1, finishedAt: Date.now(), stage: undefined });
    return result;
  } catch (error) {
    const cancelled = error instanceof JobCancelledError || controller.signal.aborted;
    const unsupported = error instanceof Error && /Unsupported/.test(error.name);
    patch(id, {
      status: cancelled ? 'cancelled' : unsupported ? 'unsupported' : 'failed',
      finishedAt: Date.now(),
      stage: undefined,
      message: cancelled ? undefined : error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    controllers.delete(id);
  }
}

export function cancelJob(id: string): void {
  controllers.get(id)?.abort();
}

export function cancelJobsOfKind(kind: JobKind): void {
  for (const job of useJobs.getState().jobs) {
    if (job.kind === kind && job.status === 'running') cancelJob(job.id);
  }
}

export function clearFinishedJobs(): void {
  useJobs.setState((s) => ({ jobs: s.jobs.filter((job) => job.status === 'running' || job.status === 'queued') }));
}

export function isRunning(job: LabJob): boolean {
  return job.status === 'running' || job.status === 'queued';
}
