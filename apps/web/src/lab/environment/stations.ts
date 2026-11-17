/**
 * Multi-station layout. A "station" is an independently identifiable work area that hosts one
 * apparatus arrangement; this module only assigns each station a stable position (and, in studio
 * mode, a grid cell) so that two or more experiments can run side by side in isolation. It knows
 * nothing about what is placed on a station — apparatus, connections and chemical state are Agent
 * 03/07's domain.
 *
 * Layout is a pure function of the station list's order, so saved scenes reproduce the same
 * positions on reopening (see `RoomConfig.ts`), and reordering the list is the only thing that
 * reflows it.
 */
import { IDENTITY_QUATERNION } from './types';
import type { EnvironmentMode, StationRecord, UUID, WorldTransform } from './types';
import { createId } from './types';

export interface StationFootprint {
  readonly widthM: number;
  readonly depthM: number;
}

export interface StationSlot {
  readonly station: StationRecord;
  /** Position in `stations`; layout is derived only from this, never from the station id. */
  readonly index: number;
  readonly origin: WorldTransform;
  readonly footprintM: StationFootprint;
}

export const DEFAULT_STATION_FOOTPRINT_M: StationFootprint = { widthM: 1.2, depthM: 0.7 };

/** Centre-to-centre spacing between adjacent stations, large enough that benches never overlap. */
export const STATION_SPACING_M = 1.6;

export function createStation(name: string): StationRecord {
  return { id: createId('station'), name };
}

/**
 * Assigns each station a world position.
 * - `room`: a single row along the back wall, centred on X, all facing the same way into the room.
 * - `studio`: a roughly square grid centred on the origin, for an open, walk-around arrangement.
 */
export function layoutStations(
  stations: readonly StationRecord[],
  mode: EnvironmentMode,
  spacingM: number = STATION_SPACING_M,
): StationSlot[] {
  if (stations.length === 0) return [];
  return mode === 'room' ? layoutRow(stations, spacingM) : layoutGrid(stations, spacingM);
}

function layoutRow(stations: readonly StationRecord[], spacingM: number): StationSlot[] {
  const totalWidth = (stations.length - 1) * spacingM;
  return stations.map((station, index) => ({
    station,
    index,
    origin: { positionM: [index * spacingM - totalWidth / 2, 0, 0], quaternion: IDENTITY_QUATERNION },
    footprintM: DEFAULT_STATION_FOOTPRINT_M,
  }));
}

function layoutGrid(stations: readonly StationRecord[], spacingM: number): StationSlot[] {
  const columns = Math.max(1, Math.ceil(Math.sqrt(stations.length)));
  const rows = Math.ceil(stations.length / columns);
  return stations.map((station, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    return {
      station,
      index,
      origin: {
        positionM: [(col - (columns - 1) / 2) * spacingM, 0, (row - (rows - 1) / 2) * spacingM],
        quaternion: IDENTITY_QUATERNION,
      },
      footprintM: DEFAULT_STATION_FOOTPRINT_M,
    };
  });
}

export function findSlot(slots: readonly StationSlot[], stationId: UUID): StationSlot | undefined {
  return slots.find((slot) => slot.station.id === stationId);
}

export interface PlanBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

/** The plan-view (X/Z) bounding box of every station's footprint, for sizing a room or floor around them. */
export function layoutBounds(slots: readonly StationSlot[]): PlanBounds {
  if (slots.length === 0) return { minX: -STATION_SPACING_M / 2, maxX: STATION_SPACING_M / 2, minZ: -STATION_SPACING_M / 2, maxZ: STATION_SPACING_M / 2 };
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const slot of slots) {
    const [x, , z] = slot.origin.positionM;
    const hw = slot.footprintM.widthM / 2;
    const hd = slot.footprintM.depthM / 2;
    minX = Math.min(minX, x - hw);
    maxX = Math.max(maxX, x + hw);
    minZ = Math.min(minZ, z - hd);
    maxZ = Math.max(maxZ, z + hd);
  }
  return { minX, maxX, minZ, maxZ };
}

/**
 * The smallest centre-to-centre distance between any two station origins, or `Infinity` for fewer
 * than two stations. Used to confirm the layout never overlaps benches.
 */
export function minimumSeparation(slots: readonly StationSlot[]): number {
  let min = Infinity;
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      const a = slots[i]!.origin.positionM;
      const b = slots[j]!.origin.positionM;
      min = Math.min(min, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    }
  }
  return min;
}
