/**
 * Pure geometry math for vessel fill levels. Nothing here reads simulation state directly — every
 * function takes `volumeL` (from `ContainerContents.volumeL`, Agent 07's authoritative state) or a
 * height derived from it, so the 3D meniscus and the numeric readout are always computed from the
 * same source and can never drift apart.
 */
import type { VesselGraduation, VesselProfile, VesselProfilePoint, VesselShapeId } from '../contracts';

const LITERS_PER_CUBIC_METER = 1000;
const HEIGHT_SEARCH_ITERATIONS = 48;

/** Linear interpolation of the profile's inner-wall radius at a height measured from the base. */
export function radiusAtHeight(points: readonly VesselProfilePoint[], heightM: number): number {
  if (points.length === 0) return 0;
  const first = points[0]!;
  if (heightM <= first.heightM) return first.radiusM;
  const last = points[points.length - 1]!;
  if (heightM >= last.heightM) return last.radiusM;
  for (let i = 1; i < points.length; i++) {
    const b = points[i]!;
    if (heightM <= b.heightM) {
      const a = points[i - 1]!;
      const span = b.heightM - a.heightM;
      const t = span > 0 ? (heightM - a.heightM) / span : 0;
      return a.radiusM + (b.radiusM - a.radiusM) * t;
    }
  }
  return last.radiusM;
}

/** Volume (liters) of the conical-frustum segment between two adjacent profile points. */
function frustumVolumeL(a: VesselProfilePoint, b: VesselProfilePoint): number {
  const h = b.heightM - a.heightM;
  if (h <= 0) return 0;
  const r1 = a.radiusM;
  const r2 = b.radiusM;
  const cubicMeters = ((Math.PI * h) / 3) * (r1 * r1 + r1 * r2 + r2 * r2);
  return cubicMeters * LITERS_PER_CUBIC_METER;
}

/**
 * Cumulative liquid volume (liters) the vessel holds between its base (height 0) and `heightM`.
 * Strictly increasing in `heightM` for any profile with positive radii, which is what lets
 * `heightForVolume` invert it by search without special-casing non-cylindrical shapes.
 */
export function volumeAtHeight(points: readonly VesselProfilePoint[], heightM: number): number {
  if (points.length < 2 || heightM <= points[0]!.heightM) return 0;
  let volume = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    if (heightM >= b.heightM) {
      volume += frustumVolumeL(a, b);
      continue;
    }
    if (heightM > a.heightM) {
      const partialB: VesselProfilePoint = { heightM, radiusM: radiusAtHeight(points, heightM) };
      volume += frustumVolumeL(a, partialB);
    }
    break;
  }
  return volume;
}

/**
 * Inverse of `volumeAtHeight`: the fill height (meters, from the vessel base) that holds exactly
 * `volumeL` liters, clamped to the profile's own extent. Volume is monotonic in height for every
 * supported shape (including a flask whose radius itself is not monotonic), so a binary search
 * converges exactly without per-shape logic.
 */
export function heightForVolume(points: readonly VesselProfilePoint[], volumeL: number): number {
  if (points.length < 2) return 0;
  const minHeight = points[0]!.heightM;
  const maxHeight = points[points.length - 1]!.heightM;
  if (volumeL <= 0) return minHeight;
  const fullVolume = volumeAtHeight(points, maxHeight);
  if (volumeL >= fullVolume) return maxHeight;

  let lo = minHeight;
  let hi = maxHeight;
  for (let i = 0; i < HEIGHT_SEARCH_ITERATIONS; i++) {
    const mid = (lo + hi) / 2;
    if (volumeAtHeight(points, mid) < volumeL) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * The profile points from the base up to `heightM` (clamped to the profile's extent), with a final
 * point synthesized exactly at `heightM` so the liquid mesh's rim sits precisely at the meniscus
 * height. Used to build the liquid LatheGeometry; always returns at least two points.
 */
export function profilePointsUpTo(points: readonly VesselProfilePoint[], heightM: number): VesselProfilePoint[] {
  if (points.length === 0) return [];
  const minHeight = points[0]!.heightM;
  const maxHeight = points[points.length - 1]!.heightM;
  const clamped = Math.min(Math.max(heightM, minHeight), maxHeight);

  const result: VesselProfilePoint[] = [];
  for (const p of points) {
    if (p.heightM <= clamped) result.push(p);
    else break;
  }
  const lastIncluded = result[result.length - 1];
  if (!lastIncluded || clamped - lastIncluded.heightM > 1e-9) {
    result.push({ heightM: clamped, radiusM: radiusAtHeight(points, clamped) });
  }
  if (result.length < 2) result.push({ heightM: clamped, radiusM: result[0]!.radiusM });
  return result;
}

/**
 * The instrument reading (milliliters) for a graduated vessel at the given liquid volume. Reads the
 * same profile and the same `heightForVolume` the 3D meniscus uses, so the numeric readout and the
 * visible fill level can never disagree. Vessels without a `graduation` just report the raw volume.
 */
export function readingML(profile: VesselProfile, volumeL: number): number {
  const g = profile.graduation;
  if (!g) return volumeL * 1000;
  const heightM = heightForVolume(profile.points, volumeL);
  const volTop = volumeAtHeight(profile.points, g.topHeightM);
  const volBottom = volumeAtHeight(profile.points, g.bottomHeightM);
  const volHere = volumeAtHeight(profile.points, heightM);
  const span = volTop - volBottom;
  const lo = Math.min(g.minML, g.maxML);
  const hi = Math.max(g.minML, g.maxML);
  if (span <= 0) return g.minML;
  const fractionFromTop = (volTop - volHere) / span; // 0 at the top mark, 1 at the bottom mark
  const reading = g.zeroAtTop ? g.minML + fractionFromTop * (g.maxML - g.minML) : g.maxML - fractionFromTop * (g.maxML - g.minML);
  return Math.min(Math.max(reading, lo), hi);
}

/**
 * Inverse of `readingML`: the fill height (meters) at which a graduated vessel would read exactly
 * `targetML`. Used to place graduation tick marks and their highlighted "current reading" tick at
 * the same height the meniscus itself would sit at that reading, so the printed scale and the 3D
 * liquid surface are built from one calculation and cannot disagree.
 */
export function heightForReadingML(profile: VesselProfile, targetML: number): number {
  const g = profile.graduation;
  if (!g) return heightForVolume(profile.points, targetML / 1000);
  const span = g.maxML - g.minML;
  if (span <= 0) return profile.points[0]?.heightM ?? 0;
  const clampedML = Math.min(Math.max(targetML, Math.min(g.minML, g.maxML)), Math.max(g.minML, g.maxML));
  const volTop = volumeAtHeight(profile.points, g.topHeightM);
  const volBottom = volumeAtHeight(profile.points, g.bottomHeightM);
  const volSpan = volTop - volBottom;
  const fractionFromTop = g.zeroAtTop ? (clampedML - g.minML) / span : (g.maxML - clampedML) / span;
  const volumeL = volTop - fractionFromTop * volSpan;
  return heightForVolume(profile.points, volumeL);
}

function buildProfile(id: string, shape: VesselShapeId, points: readonly VesselProfilePoint[], wallThicknessM: number, graduation?: VesselGraduation): VesselProfile {
  const capacityL = volumeAtHeight(points, points[points.length - 1]!.heightM);
  return { id, shape, points, capacityL, wallThicknessM, graduation };
}

/**
 * A representative 50 mL class-A burette: a short tapered tip (unmarked dead volume below the
 * stopcock, as on real glassware) below a constant-bore graduated column. `graduatedCapacityML` sets
 * the 0 mark (top of the column) to the bottom-of-column mark span; the tip below it holds a little
 * extra liquid that is real (it drains last) but never shows on the printed scale.
 */
export function buretteProfile(id: string, graduatedCapacityML = 50): VesselProfile {
  const innerRadiusM = 0.0055;
  const tipHeightM = 0.025;
  const capacityM3 = graduatedCapacityML / 1_000_000; // mL -> L (/1000) -> m^3 (/1000)
  const cylinderHeightM = capacityM3 / (Math.PI * innerRadiusM * innerRadiusM);
  const topHeightM = tipHeightM + cylinderHeightM;
  const points: VesselProfilePoint[] = [
    { heightM: 0, radiusM: 0.0006 },
    { heightM: tipHeightM * 0.55, radiusM: 0.0006 },
    { heightM: tipHeightM, radiusM: innerRadiusM },
    { heightM: topHeightM, radiusM: innerRadiusM },
  ];
  return buildProfile(id, 'burette', points, 0.0016, {
    minML: 0,
    maxML: graduatedCapacityML,
    majorStepML: graduatedCapacityML / 10,
    minorStepML: graduatedCapacityML / 50,
    zeroAtTop: true,
    topHeightM,
    bottomHeightM: tipHeightM,
  });
}

/** A representative 250 mL conical (Erlenmeyer) flask: flat base, conical body, cylindrical neck. */
export function erlenmeyerFlaskProfile(id: string): VesselProfile {
  const points: VesselProfilePoint[] = [
    { heightM: 0, radiusM: 0 },
    { heightM: 0.004, radiusM: 0.038 },
    { heightM: 0.05, radiusM: 0.038 },
    { heightM: 0.1, radiusM: 0.014 },
    { heightM: 0.122, radiusM: 0.0135 },
    { heightM: 0.128, radiusM: 0.016 },
  ];
  return buildProfile(id, 'erlenmeyer-flask', points, 0.0014);
}

/** A representative 250 mL low-form beaker with coarse printed volume lines. */
export function beakerProfile(id: string): VesselProfile {
  const points: VesselProfilePoint[] = [
    { heightM: 0, radiusM: 0 },
    { heightM: 0.003, radiusM: 0.034 },
    { heightM: 0.095, radiusM: 0.0345 },
    { heightM: 0.098, radiusM: 0.037 },
  ];
  return buildProfile(id, 'beaker', points, 0.0015, {
    minML: 0,
    maxML: 250,
    majorStepML: 50,
    minorStepML: 25,
    zeroAtTop: false,
    topHeightM: 0.095,
    bottomHeightM: 0.003,
  });
}

/** A representative 500 mL reagent (Woulfe-style) bottle: round body, narrow stoppered neck. */
export function reagentBottleProfile(id: string): VesselProfile {
  const points: VesselProfilePoint[] = [
    { heightM: 0, radiusM: 0 },
    { heightM: 0.006, radiusM: 0.044 },
    { heightM: 0.1, radiusM: 0.046 },
    { heightM: 0.13, radiusM: 0.02 },
    { heightM: 0.158, radiusM: 0.0115 },
    { heightM: 0.165, radiusM: 0.013 },
  ];
  return buildProfile(id, 'reagent-bottle', points, 0.0018);
}
