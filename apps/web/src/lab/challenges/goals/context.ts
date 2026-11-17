/**
 * Pure read helpers over `EvaluationContext`. Every function here only reads the shared contract
 * types (apparatus, connections, containers, events, observations) — none of them infer a
 * chemical result or a success state from render/animation state.
 */

import type { ApparatusInstance, ApparatusKind, ConnectionKind, ContainerContents, ExperimentScene, LabEventRecord, Observation, ObservationType, UUID } from '../contracts';
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

/** Only successfully-applied actions of `type` targeting `instanceId`, in event order. Never counts a REJECTED or DUPLICATE attempt. */
function appliedActionsOf(events: readonly LabEventRecord[], type: string, instanceId?: UUID): LabEventRecord[] {
  return events.filter((record) => record.outcome === 'APPLIED' && record.action.type === type && (instanceId === undefined || record.action.targetInstanceId === instanceId));
}

/**
 * Sum of real, accepted `TRANSFER` action volumes out of `sourceId` (optionally only those
 * received by `receiverId`). Matches `buildTransferAction` in
 * `apps/web/src/lab/experiments/runtime/actions.ts`: `targetInstanceId` is the *source*;
 * `payload = { toInstanceId, volumeL }`.
 */
export function sumTransferredVolumeL(events: readonly LabEventRecord[], filter: { readonly sourceId?: UUID; readonly receiverId?: UUID }): number {
  let total = 0;
  for (const record of appliedActionsOf(events, 'TRANSFER', filter.sourceId)) {
    const payload = record.action.payload as { toInstanceId?: UUID; volumeL?: number };
    if (filter.receiverId !== undefined && payload.toInstanceId !== filter.receiverId) continue;
    if (typeof payload.volumeL === 'number' && Number.isFinite(payload.volumeL)) total += payload.volumeL;
  }
  return total;
}

/** Number of real, accepted `SET_VALVE` actions on `instanceId` that actually opened it (`valveOpening > 0`). */
export function countValveOpenings(events: readonly LabEventRecord[], instanceId: UUID): number {
  return appliedActionsOf(events, 'SET_VALVE', instanceId).filter((record) => {
    const payload = record.action.payload as { valveOpening?: number };
    return typeof payload.valveOpening === 'number' && payload.valveOpening > 0;
  }).length;
}

export function observationsOfType(observations: readonly Observation[], type: ObservationType, apparatusId?: UUID): Observation[] {
  return observations.filter((obs) => obs.type === type && (apparatusId === undefined || obs.apparatusId === apparatusId));
}

export function latestObservationOfType(observations: readonly Observation[], type: ObservationType, apparatusId?: UUID): Observation | undefined {
  const all = observationsOfType(observations, type, apparatusId);
  return all.length === 0 ? undefined : all.reduce((latest, o) => (o.timeS > latest.timeS ? o : latest));
}

export interface FillCharge {
  readonly volumeL: number;
  readonly totalMoles: number;
}

/** The first real, accepted `FILL` action on `instanceId`: its charged volume and total species moles. Matches `buildFillAction`'s `{ volumeL, species, temperatureK, modelId }` payload. */
export function firstAppliedFill(events: readonly LabEventRecord[], instanceId: UUID): FillCharge | undefined {
  for (const record of appliedActionsOf(events, 'FILL', instanceId)) {
    const payload = record.action.payload as { volumeL?: number; species?: readonly { readonly moles?: number }[] };
    if (typeof payload.volumeL !== 'number' || !Array.isArray(payload.species)) continue;
    const totalMoles = payload.species.reduce((sum, s) => sum + (typeof s.moles === 'number' ? s.moles : 0), 0);
    return { volumeL: payload.volumeL, totalMoles };
  }
  return undefined;
}

/**
 * Molarity of `speciesId` as charged by `instanceId`'s own first, real, accepted `FILL` action —
 * deliberately *not* the vessel's current live concentration. Once titrant starts flowing, a real
 * `TRANSFER` genuinely dilutes the flask (the inventory ledger conserves moles, not
 * concentration), so "did you prepare the right reagent" must be checked against what was actually
 * charged in, or it would silently go from met back to unmet again as the titration progresses.
 */
export function firstFilledMolarityOfSpecies(events: readonly LabEventRecord[], instanceId: UUID, speciesId: string): number {
  for (const record of appliedActionsOf(events, 'FILL', instanceId)) {
    const payload = record.action.payload as { volumeL?: number; species?: readonly { readonly speciesId?: string; readonly moles?: number }[] };
    if (typeof payload.volumeL !== 'number' || !(payload.volumeL > 0) || !Array.isArray(payload.species)) continue;
    const moles = payload.species.filter((s) => s.speciesId === speciesId).reduce((sum, s) => sum + (typeof s.moles === 'number' ? s.moles : 0), 0);
    return moles / payload.volumeL;
  }
  return 0;
}

/**
 * The theoretical equivalence volume: moles of analyte charged into `analyteInstanceId` divided by
 * the titrant's molarity in `titrantInstanceId`, both read from their own first `FILL` action.
 * Pure stoichiometry from the authoritative, conserved inventory — this never asks Agent 06's
 * solver for the answer, so it is available even before any observation has been computed, and it
 * cannot be invalidated by a later solver response.
 */
export function equivalenceVolumeFromFills(events: readonly LabEventRecord[], analyteInstanceId: UUID, titrantInstanceId: UUID): number | undefined {
  const analyte = firstAppliedFill(events, analyteInstanceId);
  const titrant = firstAppliedFill(events, titrantInstanceId);
  if (!analyte || !titrant || !(titrant.volumeL > 0) || !(titrant.totalMoles > 0)) return undefined;
  const titrantMolarityMolPerL = titrant.totalMoles / titrant.volumeL;
  return analyte.totalMoles / titrantMolarityMolPerL;
}
