import type { ApparatusDefinition, Quaternion, VesselCalibration } from '@matterlab/contracts';

export const CALIBRATION_VOLUME_TOLERANCE_FRACTION = 0.005;
export const UPRIGHT_TOLERANCE_RAD = 0.001;
const MAX_POINTS = 256;
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-10 * Math.max(1, Math.abs(a), Math.abs(b));
type Profile = VesselCalibration['interiorProfile'];

export type CalibrationCheck =
  | { readonly supported: true; readonly maximumResidualL: number }
  | { readonly supported: false; readonly reason: string };

export interface CalibratedFill {
  readonly status: 'READY' | 'EMPTY' | 'UNSUPPORTED';
  readonly reason?: string;
  readonly volumeL: number;
  readonly capacityL: number;
  readonly referenceHeightM: number;
  readonly edgeHeightM: number;
  readonly bottomHeightM: number;
  readonly radiusM: number;
  readonly meniscusOffsetM: number;
  readonly full: boolean;
  readonly geometricVolumeL: number;
  readonly calibrationResidualL: number;
}

export function profileRadiusM(profile: Profile, heightM: number): number {
  if (heightM <= profile[0]!.yM) return profile[0]!.radiusM;
  for (let i = 1; i < profile.length; i++) {
    const a = profile[i - 1]!;
    const b = profile[i]!;
    if (heightM <= b.yM) {
      return a.radiusM + (b.radiusM - a.radiusM) * (heightM - a.yM) / (b.yM - a.yM);
    }
  }
  return profile[profile.length - 1]!.radiusM;
}

/** A frustum integral, in liters; height and radius are never treated as liters. */
export function integratedProfileVolumeL(profile: Profile, bottomM: number, topM: number): number {
  let volumeM3 = 0;
  for (let i = 1; i < profile.length; i++) {
    const a = profile[i - 1]!;
    const b = profile[i]!;
    const low = Math.max(bottomM, a.yM);
    const high = Math.min(topM, b.yM);
    if (high <= low) continue;
    const slope = (b.radiusM - a.radiusM) / (b.yM - a.yM);
    const r0 = a.radiusM + slope * (low - a.yM);
    const r1 = a.radiusM + slope * (high - a.yM);
    volumeM3 += Math.PI * (high - low) * (r0 * r0 + r0 * r1 + r1 * r1) / 3;
  }
  return volumeM3 * 1000;
}

export function checkVesselCalibration(calibration: VesselCalibration): CalibrationCheck {
  const fail = (reason: string): CalibrationCheck => ({ supported: false, reason });
  const { capacityL, maxFillHeightM, interiorProfile: profile, volumeHeightCurve: curve, meniscus } = calibration;
  if (!Number.isFinite(capacityL) || capacityL <= 0 || !Number.isFinite(maxFillHeightM)) {
    return fail('The vessel has no finite positive capacity and calibrated maximum height.');
  }
  if (profile.length < 2 || curve.length < 2 || profile.length > MAX_POINTS || curve.length > MAX_POINTS) {
    return fail('The interior and calibration curve need 2–256 points.');
  }
  for (let i = 0; i < profile.length; i++) {
    const point = profile[i]!;
    if (!Number.isFinite(point.yM) || !Number.isFinite(point.radiusM) || point.radiusM <= 0 ||
        (i > 0 && point.yM <= profile[i - 1]!.yM)) {
      return fail('Interior heights must strictly increase and radii must be finite and positive.');
    }
  }
  for (let i = 0; i < curve.length; i++) {
    const point = curve[i]!;
    if (!Number.isFinite(point.volumeL) || !Number.isFinite(point.heightM) ||
        (i > 0 && (point.volumeL <= curve[i - 1]!.volumeL || point.heightM <= curve[i - 1]!.heightM))) {
      return fail('Volume and height must strictly increase along the finite calibration curve.');
    }
  }
  const first = curve[0]!;
  const last = curve[curve.length - 1]!;
  if (first.volumeL !== 0 || !close(last.volumeL, capacityL) || !close(last.heightM, maxFillHeightM) ||
      first.heightM < profile[0]!.yM || last.heightM > profile[profile.length - 1]!.yM) {
    return fail('The curve must cover zero to capacity within the interior, ending at maxFillHeightM.');
  }
  if (!Number.isFinite(meniscus.offsetM) || meniscus.offsetM < 0 ||
      (meniscus.reference !== 'BOTTOM' && meniscus.reference !== 'TOP')) {
    return fail('Only a nonnegative, declared top/bottom meniscus offset is supported.');
  }
  const marks = calibration.graduations;
  if (marks && (!Number.isFinite(marks.minorStepL) || !Number.isFinite(marks.majorStepL) ||
      marks.minorStepL <= 0 || marks.majorStepL < marks.minorStepL || marks.majorStepL > capacityL ||
      !close(marks.majorStepL / marks.minorStepL, Math.round(marks.majorStepL / marks.minorStepL)) ||
      !Number.isFinite(marks.startHeightM) || !Number.isFinite(marks.endHeightM) ||
      Math.min(marks.startHeightM, marks.endHeightM) < first.heightM ||
      Math.max(marks.startHeightM, marks.endHeightM) > last.heightM ||
      (marks.direction === 'UP' ? marks.endHeightM <= marks.startHeightM : marks.endHeightM >= marks.startHeightM))) {
    return fail('Graduations contradict the calibrated range, spacing, or direction.');
  }
  let maximumResidualL = 0;
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1]!;
    const b = curve[i]!;
    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      const volumeL = a.volumeL + (b.volumeL - a.volumeL) * fraction;
      const heightM = a.heightM + (b.heightM - a.heightM) * fraction;
      maximumResidualL = Math.max(maximumResidualL,
        Math.abs(integratedProfileVolumeL(profile, first.heightM, heightM) - volumeL));
    }
  }
  if (maximumResidualL > capacityL * CALIBRATION_VOLUME_TOLERANCE_FRACTION) {
    return fail('The interior geometry and liter-to-meter curve differ by more than 0.5% of capacity.');
  }
  return { supported: true, maximumResidualL };
}

/** Call only after checkVesselCalibration; this interpolation never extrapolates. */
export function calibratedHeightM(calibration: VesselCalibration, volumeL: number): number {
  const curve = calibration.volumeHeightCurve;
  if (volumeL <= 0) return curve[0]!.heightM;
  if (volumeL >= calibration.capacityL) return curve[curve.length - 1]!.heightM;
  let left = 0;
  let right = curve.length - 1;
  while (right - left > 1) {
    const middle = (left + right) >> 1;
    if (curve[middle]!.volumeL < volumeL) left = middle;
    else right = middle;
  }
  const a = curve[left]!;
  const b = curve[right]!;
  return a.heightM + (b.heightM - a.heightM) * (volumeL - a.volumeL) / (b.volumeL - a.volumeL);
}

export function isUpright(quaternion: Quaternion): boolean {
  if (quaternion.some((value) => !Number.isFinite(value)) || Math.abs(Math.hypot(...quaternion) - 1) > 1e-6) return false;
  const [x, , z] = quaternion;
  return 1 - 2 * (x * x + z * z) >= Math.cos(UPRIGHT_TOLERANCE_RAD);
}

export function evaluateVesselFill(
  definition: ApparatusDefinition, volumeL: number, orientation: Quaternion,
  checked?: CalibrationCheck,
): CalibratedFill {
  const calibration = definition.vesselCalibration;
  const empty: CalibratedFill = {
    status: 'UNSUPPORTED', volumeL, capacityL: calibration?.capacityL ?? 0,
    referenceHeightM: 0, edgeHeightM: 0, bottomHeightM: 0, radiusM: 0,
    meniscusOffsetM: 0, full: false, geometricVolumeL: 0, calibrationResidualL: 0,
  };
  const unsupported = (reason: string): CalibratedFill => ({ ...empty, reason });
  if (!calibration) return unsupported('No vessel calibration is defined; no guessed liquid geometry is drawn.');
  const check = checked ?? checkVesselCalibration(calibration);
  if (!check.supported) return unsupported(check.reason);
  if (definition.capacityL === undefined || !close(definition.capacityL, calibration.capacityL)) {
    return unsupported('Definition and calibration capacities do not agree.');
  }
  if (!Number.isFinite(volumeL) || volumeL < 0 || volumeL > calibration.capacityL) {
    return unsupported('Authoritative volume is outside the calibrated range; it is not silently clamped.');
  }
  if (!isUpright(orientation)) {
    return unsupported('Only upright calibration is supported; a tilted fill or spill is not simulated.');
  }
  const bottomHeightM = calibration.volumeHeightCurve[0]!.heightM;
  const referenceHeightM = calibratedHeightM(calibration, volumeL);
  const full = volumeL === calibration.capacityL;
  const direction = calibration.meniscus.reference === 'BOTTOM' ? 1 : -1;
  const meniscusOffsetM = Math.min(calibration.meniscus.offsetM,
    (referenceHeightM - bottomHeightM) / 4,
    (calibration.maxFillHeightM - referenceHeightM) / 4);
  const edgeHeightM = referenceHeightM + direction * meniscusOffsetM;
  const geometricVolumeL = integratedProfileVolumeL(calibration.interiorProfile, bottomHeightM, referenceHeightM);
  return {
    status: volumeL === 0 ? 'EMPTY' : 'READY',
    volumeL, capacityL: calibration.capacityL, referenceHeightM, edgeHeightM, bottomHeightM,
    radiusM: profileRadiusM(calibration.interiorProfile, edgeHeightM),
    meniscusOffsetM, full, geometricVolumeL,
    calibrationResidualL: geometricVolumeL - volumeL,
  };
}

export interface GraduationMark {
  readonly heightM: number;
  readonly radiusM: number;
  readonly readingL: number;
  readonly major: boolean;
}

export function calibratedGraduations(calibration: VesselCalibration, maxMarks = 512): readonly GraduationMark[] {
  if (!checkVesselCalibration(calibration).supported || !calibration.graduations) return [];
  const marks = calibration.graduations;
  const count = Math.floor(calibration.capacityL / marks.minorStepL + 1e-8);
  if (count + 1 > Math.max(0, Math.min(2048, maxMarks))) return [];
  const output: GraduationMark[] = [];
  for (let i = 0; i <= count; i++) {
    const readingL = i * marks.minorStepL;
    const containedL = marks.reading === 'DELIVERED' ? calibration.capacityL - readingL : readingL;
    const heightM = calibratedHeightM(calibration, containedL);
    if (heightM < Math.min(marks.startHeightM, marks.endHeightM) - 1e-10 ||
        heightM > Math.max(marks.startHeightM, marks.endHeightM) + 1e-10) continue;
    output.push({
      heightM, radiusM: profileRadiusM(calibration.interiorProfile, heightM), readingL,
      major: close(readingL / marks.majorStepL, Math.round(readingL / marks.majorStepL)),
    });
  }
  return output;
}
