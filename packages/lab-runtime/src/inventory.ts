import { parseLabContract } from '@matterlab/contracts';
import type { ContainerContents, ExperimentScene, SpeciesAmount, UUID } from '@matterlab/contracts';
import { fail } from './errors.ts';

export const VOLUME_TOLERANCE_L = 1e-12;
export const MOLE_TOLERANCE = 1e-12;
const keyOf = (species: SpeciesAmount): string => JSON.stringify([species.speciesId, species.sourceId ?? null]);
const sorted = (species: readonly SpeciesAmount[]): readonly SpeciesAmount[] =>
  [...species].sort((a, b) => keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0);

export interface TransferUpdate {
  readonly source: ContainerContents;
  readonly receiver: ContainerContents;
  readonly transferredVolumeL: number;
  readonly transferredSpecies: readonly SpeciesAmount[];
}

/** Pure ledger arithmetic only. Equilibrium species, reagent composition and temperature mixing are not calculated here. */
export function transferInventory(
  sourceInput: ContainerContents, receiverInput: ContainerContents, requestedVolumeL: number, receiverCapacityL: number,
): TransferUpdate {
  const source = parseLabContract('ContainerContents', sourceInput);
  const receiver = parseLabContract('ContainerContents', receiverInput);
  if (!Number.isFinite(requestedVolumeL) || requestedVolumeL <= 0) fail('INVALID_INPUT', 'Transfer volume must be finite and positive.');
  if (!Number.isFinite(receiverCapacityL) || receiverCapacityL <= 0) fail('INVALID_INPUT', 'Receiver capacity must be finite and positive.');
  if (source.volumeL <= 0 || requestedVolumeL > source.volumeL + VOLUME_TOLERANCE_L) fail('INSUFFICIENT_VOLUME', 'Source does not contain the requested volume.');
  const space = receiverCapacityL - receiver.volumeL;
  if (space <= 0 || requestedVolumeL > space + VOLUME_TOLERANCE_L) fail('CAPACITY_EXCEEDED', 'Receiver cannot contain the requested transfer.');
  if (source.mixing !== 'WELL_MIXED') fail('UNSUPPORTED_CONDITIONS', 'Aliquot transfer requires an explicitly well-mixed source.');
  if (source.modelId !== receiver.modelId) fail('UNSUPPORTED_MODEL', 'Transfer between different inventory models is unsupported.');
  if (receiver.volumeL > 0 && Math.abs(source.temperatureK - receiver.temperatureK) > 1e-9) {
    fail('UNSUPPORTED_CONDITIONS', 'Non-isothermal mixing requires a validated thermal model; no temperature is invented.');
  }
  const amount = Math.min(requestedVolumeL, source.volumeL, space);
  const fraction = amount / source.volumeL;
  const moved = sorted(source.species.map((species) => ({ ...species, moles: species.moles * fraction })));
  const sourceSpecies = sorted(source.species.map((species) => ({ ...species, moles: species.moles - species.moles * fraction })));
  const receiverSpecies = new Map(receiver.species.map((species) => [keyOf(species), { ...species }]));
  for (const species of moved) {
    const key = keyOf(species);
    receiverSpecies.set(key, { ...species, moles: (receiverSpecies.get(key)?.moles ?? 0) + species.moles });
  }
  const nextSource = parseLabContract('ContainerContents', { ...source, volumeL: source.volumeL - amount, species: sourceSpecies });
  const nextReceiver = parseLabContract('ContainerContents', {
    ...receiver, volumeL: receiver.volumeL + amount, species: sorted([...receiverSpecies.values()]),
    temperatureK: receiver.volumeL === 0 ? source.temperatureK : receiver.temperatureK,
    mixing: receiver.volumeL === 0 ? source.mixing : receiver.mixing,
  });
  if (Math.abs(source.volumeL + receiver.volumeL - nextSource.volumeL - nextReceiver.volumeL) > VOLUME_TOLERANCE_L) {
    fail('RUNTIME_ERROR', 'Volume conservation check failed; the transfer was not applied.');
  }
  const before = new Map<string, number>();
  const after = new Map<string, number>();
  for (const species of [...source.species, ...receiver.species]) before.set(keyOf(species), (before.get(keyOf(species)) ?? 0) + species.moles);
  for (const species of [...nextSource.species, ...nextReceiver.species]) after.set(keyOf(species), (after.get(keyOf(species)) ?? 0) + species.moles);
  for (const [key, moles] of before) {
    if (Math.abs(moles - (after.get(key) ?? 0)) > MOLE_TOLERANCE * Math.max(1, moles)) {
      fail('RUNTIME_ERROR', 'Component conservation check failed; the transfer was not applied.');
    }
  }
  return Object.freeze({ source: nextSource, receiver: nextReceiver, transferredVolumeL: amount, transferredSpecies: Object.freeze(moved) });
}

export function inventoryTotals(scene: ExperimentScene, stationId?: UUID): { readonly volumeL: number; readonly moles: Readonly<Record<string, number>> } {
  const ids = new Set(scene.apparatus.filter((instance) => stationId === undefined || instance.stationId === stationId).map((instance) => instance.id));
  let volumeL = 0;
  const moles: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const [id, contents] of Object.entries(scene.containerStates)) {
    if (!ids.has(id)) continue;
    volumeL += contents.volumeL;
    for (const species of contents.species) moles[species.speciesId] = (moles[species.speciesId] ?? 0) + species.moles;
  }
  return Object.freeze({ volumeL, moles: Object.freeze(moles) });
}
