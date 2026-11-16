/**
 * The one authoritative inventory ledger (brief item 4): pure functions for `FILL` (set a
 * container's contents from an external, unconserved reagent source — see note below) and
 * `TRANSFER` (move volume and species moles between two containers, conserved within
 * `VOLUME_CONSERVATION_TOLERANCE_L` / `MOLES_CONSERVATION_TOLERANCE_MOL`). Nothing here talks to
 * the solver or the scene graph; the reducer calls these and decides what to do with the result.
 *
 * **Modeling note (FILL is intentionally unconserved):** P0's reagent bottles are not themselves
 * modeled as finite, depletable `CONTAINER`s (that would require Agent 03 to ship a bottle
 * definition with its own capacity and Agent 06 to track a second ledger entry no acceptance test
 * asks for). `FILL` therefore sets a vessel's contents directly, standing in for "the user poured
 * this in from an external, effectively unlimited source" — it is the one place this reducer does
 * *not* enforce conservation against another vessel, and that is deliberate, not an oversight.
 * `TRANSFER` between two already-filled vessels conserves exactly.
 */
import type { ContainerContents, SpeciesAmount } from '@matterlab/contracts';
import { MOLES_CONSERVATION_TOLERANCE_MOL, VOLUME_CONSERVATION_TOLERANCE_L } from '@matterlab/contracts';
import { fail, ok, type Result } from './result';

/** Floating-point noise smaller than this is rounded to exactly zero so volumes never drift to e.g. `-1e-15`. */
const FLOAT_NOISE_L = 1e-12;

function roundTiny(value: number): number {
  return Math.abs(value) < FLOAT_NOISE_L ? 0 : value;
}

export interface FillRequest {
  readonly volumeL: number;
  readonly species: readonly SpeciesAmount[];
  readonly temperatureK: number;
  readonly modelId: string;
  readonly mixing?: ContainerContents['mixing'];
}

/** Validates and builds the absolute `ContainerContents` a `FILL` action sets. */
export function buildFilledContents(request: FillRequest, capacityL: number | undefined): Result<ContainerContents> {
  if (!Number.isFinite(request.volumeL) || request.volumeL < 0) {
    return fail('FILL volume must be a finite number of liters that is zero or greater.');
  }
  if (capacityL !== undefined && request.volumeL > capacityL + VOLUME_CONSERVATION_TOLERANCE_L) {
    return fail(`FILL volume ${request.volumeL} L exceeds the container's ${capacityL} L capacity.`);
  }
  if (!Number.isFinite(request.temperatureK) || request.temperatureK <= 0) {
    return fail('FILL temperature must be a finite number of kelvin greater than zero.');
  }
  const seen = new Set<string>();
  for (const amount of request.species) {
    if (!amount.speciesId) return fail('Every species amount in a FILL must have a non-empty speciesId.');
    if (seen.has(amount.speciesId)) return fail(`FILL species list repeats speciesId "${amount.speciesId}"; combine the moles into one entry.`);
    seen.add(amount.speciesId);
    if (!Number.isFinite(amount.moles) || amount.moles < 0) {
      return fail(`Species "${amount.speciesId}" has an invalid mole amount; moles must be zero or greater.`);
    }
  }
  if (!request.modelId) return fail('FILL must declare a modelId describing how its contents should be interpreted.');
  return ok({
    volumeL: request.volumeL,
    species: request.species.map((s) => ({ ...s })),
    temperatureK: request.temperatureK,
    mixing: request.mixing ?? 'WELL_MIXED',
    modelId: request.modelId,
  });
}

function mergeSpecies(existing: readonly SpeciesAmount[], moved: readonly SpeciesAmount[]): SpeciesAmount[] {
  const merged = existing.map((s) => ({ ...s }));
  for (const amount of moved) {
    const index = merged.findIndex((s) => s.speciesId === amount.speciesId);
    if (index >= 0) {
      merged[index] = { ...merged[index], moles: Math.max(0, merged[index].moles + amount.moles) };
    } else {
      merged.push({ ...amount, moles: Math.max(0, amount.moles) });
    }
  }
  return merged;
}

/** Volume-weighted mixing temperature: a stated, simple ideal-mixing assumption, not a calorimetry result. */
function mixedTemperatureK(receiver: ContainerContents, incomingTemperatureK: number, incomingVolumeL: number): number {
  const totalVolumeL = receiver.volumeL + incomingVolumeL;
  if (totalVolumeL <= 0) return incomingTemperatureK;
  return (receiver.temperatureK * receiver.volumeL + incomingTemperatureK * incomingVolumeL) / totalVolumeL;
}

function resolveModelId(sourceModelId: string, receiver: ContainerContents): { modelId: string; warning?: string } {
  const receiverWasEmpty = receiver.volumeL <= VOLUME_CONSERVATION_TOLERANCE_L && receiver.species.length === 0;
  if (receiverWasEmpty || receiver.modelId === sourceModelId || !receiver.modelId) {
    return { modelId: sourceModelId };
  }
  return {
    modelId: receiver.modelId,
    warning: `Receiver already has contents modeled as "${receiver.modelId}"; incoming contents were modeled as "${sourceModelId}". Keeping the receiver's model id — flag for Agent 06 reconciliation if these models are not compatible.`,
  };
}

/** Pure preview of how much volume a transfer would actually move, with no mutation and no validation errors thrown. */
export function clampTransferVolume(
  source: ContainerContents,
  receiver: ContainerContents,
  requestedVolumeL: number,
  receiverCapacityL: number | undefined,
): { readonly appliedVolumeL: number; readonly warnings: readonly string[] } {
  const warnings: string[] = [];
  let applied = Math.max(0, requestedVolumeL);
  const availableSource = Math.max(0, source.volumeL);
  if (applied > availableSource + VOLUME_CONSERVATION_TOLERANCE_L) {
    warnings.push(
      `Requested ${requestedVolumeL.toFixed(6)} L but only ${availableSource.toFixed(6)} L is available in the source; clamped to the available volume.`,
    );
    applied = availableSource;
  }
  if (receiverCapacityL !== undefined) {
    const headroom = Math.max(0, receiverCapacityL - receiver.volumeL);
    if (applied > headroom + VOLUME_CONSERVATION_TOLERANCE_L) {
      warnings.push(
        `Receiver has ${headroom.toFixed(6)} L of headroom left before its ${receiverCapacityL.toFixed(6)} L capacity; clamped to avoid overflow.`,
      );
      applied = headroom;
    }
  }
  return { appliedVolumeL: Math.max(0, applied), warnings };
}

export interface TransferOutcome {
  readonly source: ContainerContents;
  readonly receiver: ContainerContents;
  /** The volume actually moved, which may be less than requested (see `clampTransferVolume`). */
  readonly appliedVolumeL: number;
  readonly warnings: readonly string[];
}

/**
 * Moves `requestedVolumeL` (or whatever of it fits, see `clampTransferVolume`) from `source` to
 * `receiver`, moving each species' moles in the same proportion (well-mixed assumption — declared,
 * not hidden). Conserves volume and every species' moles exactly, modulo float rounding smaller
 * than `VOLUME_CONSERVATION_TOLERANCE_L` / `MOLES_CONSERVATION_TOLERANCE_MOL`.
 */
export function applyTransfer(
  source: ContainerContents,
  receiver: ContainerContents,
  requestedVolumeL: number,
  receiverCapacityL: number | undefined,
): Result<TransferOutcome> {
  if (!Number.isFinite(requestedVolumeL) || requestedVolumeL <= 0) {
    return fail('TRANSFER volume must be a finite positive number of liters.');
  }
  const { appliedVolumeL, warnings: clampWarnings } = clampTransferVolume(source, receiver, requestedVolumeL, receiverCapacityL);
  const warnings = [...clampWarnings];
  if (appliedVolumeL <= VOLUME_CONSERVATION_TOLERANCE_L) {
    return fail('No volume could be transferred: the source is empty or the receiver is already full.');
  }
  const fraction = appliedVolumeL / source.volumeL;
  const movedSpecies: SpeciesAmount[] = source.species.map((s) => ({
    speciesId: s.speciesId,
    moles: s.moles * fraction,
    sourceId: s.sourceId,
  }));
  const remainingSourceSpecies: SpeciesAmount[] = source.species.map((s, i) => ({
    ...s,
    moles: Math.max(0, s.moles - movedSpecies[i]!.moles),
  }));
  const { modelId, warning: modelWarning } = resolveModelId(source.modelId, receiver);
  if (modelWarning) warnings.push(modelWarning);

  const newSource: ContainerContents = {
    ...source,
    volumeL: roundTiny(source.volumeL - appliedVolumeL),
    species: remainingSourceSpecies,
  };
  const newReceiver: ContainerContents = {
    volumeL: roundTiny(receiver.volumeL + appliedVolumeL),
    species: mergeSpecies(receiver.species, movedSpecies),
    temperatureK: mixedTemperatureK(receiver, source.temperatureK, appliedVolumeL),
    mixing: receiver.species.length === 0 ? source.mixing : receiver.mixing,
    modelId,
  };
  return ok({ source: newSource, receiver: newReceiver, appliedVolumeL, warnings });
}

/** Total moles of one species across a set of containers; used by conservation tests. */
export function totalMoles(contents: readonly ContainerContents[], speciesId: string): number {
  let total = 0;
  for (const c of contents) {
    for (const s of c.species) {
      if (s.speciesId === speciesId) total += s.moles;
    }
  }
  return total;
}

export { VOLUME_CONSERVATION_TOLERANCE_L, MOLES_CONSERVATION_TOLERANCE_MOL };
