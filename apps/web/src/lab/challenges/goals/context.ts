/**
 * Pure read helpers over `EvaluationContext`. Every function here only reads the shared contract
 * types (apparatus, connections, containers, events, run results) — none of them infer a chemical
 * result or a success state from render/animation state.
 */

import type { ApparatusInstance, ApparatusKind, ConnectionKind, ContainerContents, ExperimentScene, LabEvent, Observation, ObservationType, RunResult, UUID } from '../contracts';
import type { GoalRoleBindings, RelativeRelation } from './types';

export function apparatusById(scene: ExperimentScene | null, id: UUID): ApparatusInstance | undefined {
  return scene?.apparatus.find((a) => a.id === id);
}

/** The first placed instance of `kind` not already claimed by another role binding. */
export function findUnboundApparatusByKind(scene: ExperimentScene | null, kind: ApparatusKind, bindings: GoalRoleBindings): ApparatusInstance | undefined {
  if (!scene) return undefined;
  const bound = new Set(Object.values(bindings));
  return scene.apparatus.find((a) => a.kind === kind && !bound.has(a.id));
}

export function areConnected(scene: ExperimentScene | null, aId: UUID, bId: UUID, kind?: ConnectionKind): boolean {
  if (!scene) return false;
  return scene.connections.some(
    (c) => c.enabled && (kind === undefined || c.kind === kind) && ((c.from.instanceId === aId && c.to.instanceId === bId) || (c.from.instanceId === bId && c.to.instanceId === aId)),
  );
}

export function containerOf(scene: ExperimentScene | null, instanceId: UUID): ContainerContents | undefined {
  return scene?.containerStates[instanceId];
}

export function molarityOfSpecies(container: ContainerContents | undefined, speciesId: string): number {
  if (!container || !(container.volumeL > 0)) return 0;
  const moles = container.species.filter((s) => s.speciesId === speciesId).reduce((sum, s) => sum + s.moles, 0);
  return moles / container.volumeL;
}

const DEFAULT_RELATIVE_TOLERANCE_M = 0.05;
/** How far off the perpendicular axis two instances may be and still count as "under"/"over" one another. */
const ALIGNMENT_TOLERANCE_M = 0.12;

/** Scene coordinates are meters with Y up (shared contract section 3); this is a geometric check, not a scientific one. */
export function relationHolds(a: ApparatusInstance, b: ApparatusInstance, relation: RelativeRelation, toleranceM = DEFAULT_RELATIVE_TOLERANCE_M): boolean {
  const [ax, ay, az] = a.transform.positionM;
  const [bx, by, bz] = b.transform.positionM;
  const aligned = Math.hypot(ax - bx, az - bz) <= ALIGNMENT_TOLERANCE_M;
  switch (relation) {
    case 'below':
      return ay < by - toleranceM && aligned;
    case 'above':
      return ay > by + toleranceM && aligned;
    case 'leftOf':
      return ax < bx - toleranceM;
    case 'rightOf':
      return ax > bx + toleranceM;
    default:
      return false;
  }
}

/**
 * Sum of `TRANSFER` action volumes matching the given source/receiver instance. The shared
 * contract types `LabAction.payload` as an open record; this reads the `sourceInstanceId` /
 * `receiverInstanceId` / `volumeL` fields the vertical slice (contract section 6) implies a
 * TRANSFER carries. Flagged for reconciliation once Agent 07 publishes the exact payload shape.
 */
export function sumTransferredVolumeL(events: readonly LabEvent[], filter: { readonly sourceId?: UUID; readonly receiverId?: UUID }): number {
  let total = 0;
  for (const event of events) {
    if (event.kind !== 'ACTION_APPLIED' || event.action.type !== 'TRANSFER') continue;
    const payload = event.action.payload as { sourceInstanceId?: UUID; receiverInstanceId?: UUID; volumeL?: number };
    if (filter.sourceId !== undefined && payload.sourceInstanceId !== filter.sourceId) continue;
    if (filter.receiverId !== undefined && payload.receiverInstanceId !== filter.receiverId) continue;
    if (typeof payload.volumeL === 'number' && Number.isFinite(payload.volumeL)) total += payload.volumeL;
  }
  return total;
}

/** Number of `SET_VALVE` actions on `instanceId` that actually opened it (opening > 0). */
export function countValveOpenings(events: readonly LabEvent[], instanceId: UUID): number {
  return events.filter((event) => {
    if (event.kind !== 'ACTION_APPLIED' || event.action.type !== 'SET_VALVE' || event.action.targetInstanceId !== instanceId) return false;
    const payload = event.action.payload as { opening?: number };
    return typeof payload.opening === 'number' && payload.opening > 0;
  }).length;
}

export function observationsOfType(runResults: readonly RunResult[], type: ObservationType, apparatusId?: UUID): Observation[] {
  const out: Observation[] = [];
  for (const run of runResults) {
    for (const obs of run.observations) {
      if (obs.type === type && (apparatusId === undefined || obs.apparatusId === apparatusId)) out.push(obs);
    }
  }
  return out;
}

export function latestObservationOfType(runResults: readonly RunResult[], type: ObservationType, apparatusId?: UUID): Observation | undefined {
  const all = observationsOfType(runResults, type, apparatusId);
  return all.length === 0 ? undefined : all.reduce((latest, o) => (o.timeS > latest.timeS ? o : latest));
}

/**
 * Reads the equivalence-point volume from `RunResult.solverDiagnostics.equivalenceVolumeL`.
 * FLAGGED INTEGRATION POINT: the shared contract types `solverDiagnostics` as an open record
 * specifically for method-specific extras, and Agent 06's brief requires computing an
 * "equivalence estimate" among its reference quantities — this is the key we expect that estimate
 * under. Returns `undefined` (never a guess) until a real run result supplies it.
 */
export function equivalenceVolumeL(runResults: readonly RunResult[]): number | undefined {
  for (let i = runResults.length - 1; i >= 0; i--) {
    const value = runResults[i]!.solverDiagnostics?.['equivalenceVolumeL'];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}
