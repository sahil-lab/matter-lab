/** Drives one run from QUEUED to a terminal status, off the HTTP request/response cycle. */
import type { Database } from '../db.js';
import { METHOD_REGISTRY } from './methodRegistry.js';
import {
  appendRunEvent,
  finalizeRun,
  isCancelRequested,
  loadForExecution,
  markRunning,
  persistObservations,
} from './repository.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ExecuteOptions {
  /** Delay before computation starts, giving a client a real window to call POST .../cancel. Used by tests; 0 in production. */
  startDelayMs?: number;
}

export async function executeRun(db: Database, runId: string, options: ExecuteOptions = {}): Promise<void> {
  const input = await loadForExecution(db, runId);
  if (!input) return; // run row vanished (deleted scene cascade, or never existed); nothing to execute

  await markRunning(db, runId);
  await appendRunEvent(db, runId, 'RUNNING', 'Run started.');

  if (options.startDelayMs && options.startDelayMs > 0) await sleep(options.startDelayMs);

  if (await isCancelRequested(db, runId)) {
    await finalizeRun(db, runId, 'CANCELLED', { warnings: [], assumptions: [] });
    await appendRunEvent(db, runId, 'CANCELLED', 'Run cancelled before it finished.');
    return;
  }

  const registration = METHOD_REGISTRY[input.methodId];
  if (!registration) {
    const outcome = { warnings: [], assumptions: [], failureCode: 'unknown_method', failureMessage: `No run method is registered for methodId "${input.methodId}".` };
    await finalizeRun(db, runId, 'UNSUPPORTED', outcome);
    await appendRunEvent(db, runId, 'UNSUPPORTED', outcome.failureMessage);
    return;
  }

  try {
    const result = registration.handler({ scene: input.sceneSnapshot, actions: input.actions, settings: input.settings });
    if (result.status === 'SUCCEEDED') {
      await persistObservations(db, runId, input.sceneId, result.observations);
      await finalizeRun(db, runId, 'SUCCEEDED', { warnings: result.warnings, assumptions: result.assumptions, solverDiagnostics: result.solverDiagnostics });
      await appendRunEvent(db, runId, 'SUCCEEDED', `Run succeeded with ${result.observations.length} observation(s).`);
    } else {
      await finalizeRun(db, runId, result.status, { warnings: result.warnings, assumptions: result.assumptions, failureCode: result.failureCode, failureMessage: result.failureMessage });
      await appendRunEvent(db, runId, result.status, result.failureMessage);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await finalizeRun(db, runId, 'FAILED', { warnings: [], assumptions: [], failureCode: 'execution_error', failureMessage: message });
    await appendRunEvent(db, runId, 'FAILED', message);
  }
}
