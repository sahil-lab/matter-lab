/**
 * Derives a `ContainerSpec` (liters <-> fill height) and graduation tick positions from the exact
 * revolution profile used to build a vessel's mesh (`geometry/profiles.ts`). Keeping one source of
 * truth for shape means the glass, the liquid level and the printed markings can never disagree.
 *
 * This module only describes geometry. It never reads or writes an instance's actual liquid
 * volume — that is conserved, authoritative state owned by Agent 07 (shared contract §4).
 */
import type { ProfilePoint } from './geometry/profiles';
import type { ContainerSpec, GraduationSpec, GraduationTick } from './types';

const M3_TO_LITERS = 1000;

/** Volume (m^3) of the conical frustum between two circular cross-sections `dh` apart. */
function frustumVolumeM3(r1: number, r2: number, dh: number): number {
  return (Math.PI * dh) / 3 * (r1 * r1 + r1 * r2 + r2 * r2);
}

/**
 * The bounding width (twice the widest radius) and height (the topmost point) of a revolution
 * profile — used so a definition's `dimensionsM` is read off the exact profile that was actually
 * built into the mesh, rather than a hand-typed figure that can silently drift out of sync with it.
 */
export function profileBoundingDimensions(points: readonly ProfilePoint[]): { readonly widthM: number; readonly heightM: number } {
  const widthM = 2 * Math.max(...points.map((p) => p.r));
  const heightM = Math.max(...points.map((p) => p.y));
  return { widthM, heightM };
}

/**
 * Builds a `ContainerSpec` by integrating a revolution profile (sorted ascending by height) as a
 * stack of conical frustums. `fillLevelForVolume`/`volumeForFillHeight` are then exact inverses of
 * each other for any profile (monotonic in height, since radius is never negative).
 */
export function containerFromProfilePoints(points: readonly ProfilePoint[]): ContainerSpec {
  const sorted = [...points].sort((a, b) => a.y - b.y);
  if (sorted.length < 2) throw new Error('A container profile needs at least two points.');

  const cumulativeL: number[] = [0];
  for (let i = 1; i < sorted.length; i++) {
    const dh = sorted[i].y - sorted[i - 1].y;
    const vL = dh > 0 ? frustumVolumeM3(sorted[i - 1].r, sorted[i].r, dh) * M3_TO_LITERS : 0;
    cumulativeL.push(cumulativeL[i - 1] + vL);
  }
  const capacityL = cumulativeL[cumulativeL.length - 1];

  function volumeForFillHeight(heightM: number): number {
    if (heightM <= sorted[0].y) return 0;
    if (heightM >= sorted[sorted.length - 1].y) return capacityL;
    let i = 1;
    while (sorted[i].y < heightM) i++;
    const a = sorted[i - 1];
    const b = sorted[i];
    const dh = heightM - a.y;
    const segHeight = b.y - a.y;
    const t = segHeight > 0 ? dh / segHeight : 0;
    const rAtHeight = a.r + (b.r - a.r) * t;
    return cumulativeL[i - 1] + frustumVolumeM3(a.r, rAtHeight, dh) * M3_TO_LITERS;
  }

  function fillLevelForVolume(volumeL: number): { heightM: number; surfaceRadiusM: number } {
    const target = Math.min(Math.max(volumeL, 0), capacityL);
    if (target <= 0) return { heightM: sorted[0].y, surfaceRadiusM: sorted[0].r };
    if (target >= capacityL) return { heightM: sorted[sorted.length - 1].y, surfaceRadiusM: sorted[sorted.length - 1].r };

    let i = 1;
    while (cumulativeL[i] < target) i++;
    const a = sorted[i - 1];
    const b = sorted[i];
    const segHeight = b.y - a.y;
    const localTargetM3 = (target - cumulativeL[i - 1]) / M3_TO_LITERS;

    // Monotonic in dh (radius never negative), so bisection converges reliably without solving the cubic directly.
    let lo = 0;
    let hi = segHeight;
    const volumeAt = (dh: number): number => {
      const t = segHeight > 0 ? dh / segHeight : 0;
      const r = a.r + (b.r - a.r) * t;
      return frustumVolumeM3(a.r, r, dh);
    };
    for (let iter = 0; iter < 48 && hi - lo > 1e-9; iter++) {
      const mid = (lo + hi) / 2;
      if (volumeAt(mid) < localTargetM3) lo = mid;
      else hi = mid;
    }
    const dh = (lo + hi) / 2;
    const t = segHeight > 0 ? dh / segHeight : 0;
    return { heightM: a.y + dh, surfaceRadiusM: a.r + (b.r - a.r) * t };
  }

  return { capacityL, fillLevelForVolume, volumeForFillHeight };
}

/**
 * The uniform radius multiplier `scaleProfileRadiiForCapacity` applies: `sqrt(targetCapacityL /
 * currentCapacityL)`, since volume scales with radius squared for a fixed height profile. Exposed
 * separately so a geometry builder can apply the *same* factor to auxiliary hardware whose size
 * must track the vessel's radius (a bottle's cap, a burette's stopcock housing) without having to
 * re-derive it or risk it drifting out of sync with the scaled glass.
 */
export function capacityScaleFactor(points: readonly ProfilePoint[], targetCapacityL: number): number {
  const current = containerFromProfilePoints(points).capacityL;
  if (current <= 0) throw new Error('Cannot scale a profile with zero capacity.');
  return Math.sqrt(targetCapacityL / current);
}

/**
 * Uniformly scales every profile radius so the profile's integrated capacity becomes exactly
 * `targetCapacityL`, leaving heights (and so the researched overall proportions) untouched — used
 * so a "250 mL" flask models exactly 250 mL rather than whatever a hand-picked radius happens to
 * integrate to. `targetCapacityL` is the vessel's declared simulated capacity (for most glassware,
 * its nominal rated volume), not necessarily the true brim-to-overflow volume: real glassware
 * carries extra headspace above its rated line, and this simplified single-surface procedural
 * silhouette does not model glass wall thickness, so treating the nominal rating as the hard
 * simulated ceiling is the documented simplification (see each definition's `provenance.notes`).
 */
export function scaleProfileRadiiForCapacity(points: readonly ProfilePoint[], targetCapacityL: number): ProfilePoint[] {
  const factor = capacityScaleFactor(points, targetCapacityL);
  return points.map((p) => ({ ...p, r: p.r * factor }));
}

function formatTickLabel(valueML: number): string {
  return Number.isInteger(valueML) ? String(valueML) : valueML.toFixed(1);
}

/**
 * Computes the physical height of every graduation line. For `zeroAtTop` glassware (every
 * burette), the printed value at a height is "capacity minus the volume still below that height"
 * (so it reads the volume *delivered* if filled to the top first); otherwise it is simply the
 * contained volume below that height (graduated cylinders, volumetric glassware).
 */
export function buildGraduationTicks(graduation: GraduationSpec, container: ContainerSpec): GraduationTick[] {
  const ticks: GraduationTick[] = [];
  const stepCount = Math.round(graduation.capacityML / graduation.minorIntervalML);
  const majorEveryNMinor = Math.max(1, Math.round(graduation.majorIntervalML / graduation.minorIntervalML));

  for (let i = 0; i <= stepCount; i++) {
    const markValueML = round2(i * graduation.minorIntervalML);
    const containedML = graduation.zeroAtTop ? graduation.capacityML - markValueML : markValueML;
    const { heightM } = container.fillLevelForVolume(containedML / 1000);
    const major = i % majorEveryNMinor === 0;
    const majorIndex = Math.round(markValueML / graduation.majorIntervalML);
    const label = major && majorIndex % graduation.labelEveryNMajor === 0 ? formatTickLabel(markValueML) : undefined;
    ticks.push({ heightM, valueML: markValueML, major, label });
  }
  return ticks;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
