/**
 * Append-only event log helpers (brief item 3) plus the idempotency check the engine runs before
 * ever calling the reducer (acceptance test: "duplicate commands with same ID are idempotent").
 * `sequence` is assigned here, monotonically, and is what replay iterates over — never the action's
 * own `atSimulationS`, which a caller could (accidentally or not) submit out of order.
 */
import { nextEventSequence, type LabAction, type LabEventOutcome, type LabEventRecord, type UUID } from '@matterlab/contracts';

export function findEventByActionId(events: readonly LabEventRecord[], actionId: UUID): LabEventRecord | undefined {
  return events.find((e) => e.action.actionId === actionId);
}

export interface AppendEventInput {
  readonly action: LabAction;
  readonly sceneRevisionBefore: number;
  readonly sceneRevisionAfter: number;
  readonly outcome: LabEventOutcome;
  readonly rejectionReason?: string;
  readonly warnings?: readonly string[];
  readonly pendingObservationRequestIds?: readonly string[];
  /** Overridable only for deterministic tests; production callers should omit this and take `Date.now()`. */
  readonly receivedAt?: string;
}

export function appendEvent(
  events: readonly LabEventRecord[],
  input: AppendEventInput,
): { readonly events: readonly LabEventRecord[]; readonly record: LabEventRecord } {
  const record: LabEventRecord = {
    sequence: nextEventSequence(events),
    action: input.action,
    receivedAt: input.receivedAt ?? new Date().toISOString(),
    sceneRevisionBefore: input.sceneRevisionBefore,
    sceneRevisionAfter: input.sceneRevisionAfter,
    outcome: input.outcome,
    ...(input.rejectionReason !== undefined ? { rejectionReason: input.rejectionReason } : {}),
    ...(input.warnings && input.warnings.length > 0 ? { warnings: input.warnings } : {}),
    ...(input.pendingObservationRequestIds && input.pendingObservationRequestIds.length > 0
      ? { pendingObservationRequestIds: input.pendingObservationRequestIds }
      : {}),
  };
  return { events: [...events, record], record };
}

/**
 * Records a repeat of an `actionId` the log has already seen. The scene is untouched (both
 * revisions equal the current one): re-sending the same action id is a safe no-op, not a second
 * application and not an error.
 */
export function appendDuplicateEvent(
  events: readonly LabEventRecord[],
  action: LabAction,
  currentSceneRevision: number,
): { readonly events: readonly LabEventRecord[]; readonly record: LabEventRecord } {
  return appendEvent(events, {
    action,
    sceneRevisionBefore: currentSceneRevision,
    sceneRevisionAfter: currentSceneRevision,
    outcome: 'DUPLICATE',
  });
}
