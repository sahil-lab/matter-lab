import type { VesselCalibration } from '@matterlab/contracts';

type Profile = VesselCalibration['interiorProfile'];

/** Exact volume of piecewise-conical interiors, from their bottom up to a local height. */
export function profileVolumeL(profile: Profile, heightM = profile[profile.length - 1]!.yM): number {
  let volumeM3 = 0;
  for (let i = 1; i < profile.length; i++) {
    const a = profile[i - 1]!;
    const b = profile[i]!;
    const height = Math.max(0, Math.min(heightM, b.yM) - a.yM);
    if (height === 0) continue;
    const radius = a.radiusM + (b.radiusM - a.radiusM) * height / (b.yM - a.yM);
    volumeM3 += Math.PI * height * (a.radiusM ** 2 + a.radiusM * radius + radius ** 2) / 3;
  }
  return volumeM3 * 1000;
}

/**
 * Calibrates original procedural interiors to a nominal capacity. This defines the model's
 * geometry, not the accuracy of a manufactured instrument.
 */
export function createVesselCalibration(
  capacityL: number,
  profile: Profile,
  graduations?: { minorStepL: number; majorStepL: number; delivered?: boolean },
): VesselCalibration {
  if (!(capacityL > 0) || !Number.isFinite(capacityL) || profile.length < 2) throw new RangeError('A vessel needs a positive capacity and at least two profile points.');
  for (let i = 0; i < profile.length; i++) {
    const point = profile[i]!;
    if (!Number.isFinite(point.yM) || !Number.isFinite(point.radiusM) || point.radiusM <= 0 || (i > 0 && point.yM <= profile[i - 1]!.yM)) {
      throw new RangeError('Vessel profile heights must increase and radii must be positive and finite.');
    }
  }
  const scale = Math.sqrt(capacityL / profileVolumeL(profile));
  const interiorProfile = profile.map((point) => ({ yM: point.yM, radiusM: point.radiusM * scale }));
  const bottom = interiorProfile[0]!.yM;
  const top = interiorProfile[interiorProfile.length - 1]!.yM;
  const heights = [...new Set([
    ...interiorProfile.map((point) => point.yM),
    ...Array.from({ length: 129 }, (_, i) => i === 0 ? bottom : i === 128 ? top : bottom + (top - bottom) * i / 128),
  ])].sort((a, b) => a - b);
  const volumeHeightCurve = heights.map((heightM, i) => ({
    volumeL: i === 0 ? 0 : i === heights.length - 1 ? capacityL : profileVolumeL(interiorProfile, heightM),
    heightM,
  }));
  return {
    capacityL,
    maxFillHeightM: top,
    interiorProfile,
    volumeHeightCurve,
    ...(graduations ? {
      graduations: {
        minorStepL: graduations.minorStepL,
        majorStepL: graduations.majorStepL,
        startHeightM: graduations.delivered ? top : bottom,
        endHeightM: graduations.delivered ? bottom : top,
        direction: graduations.delivered ? 'DOWN' as const : 'UP' as const,
        reading: graduations.delivered ? 'DELIVERED' as const : 'CONTAINED' as const,
      },
    } : {}),
    meniscus: { reference: 'BOTTOM', offsetM: 0 },
    evidence: 'ILLUSTRATIVE',
    sourceIds: ['matterlab:procedural-apparatus-v1'],
    assumptions: [
      'Original axisymmetric model geometry, not certified volumetric glassware.',
      'The calibration covers the upright vessel interior; volume and moles come only from the inventory ledger.',
      'Thermal expansion, wetting films and outlet dead volume are not modeled.',
    ],
  };
}
