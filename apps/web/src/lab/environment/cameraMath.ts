import { MathUtils, Vector3 } from 'three';
import { assertBoundsM, assertPointM, boundsCenter } from './coordinates';
import type { LabBoundsM, LabCameraMode, LabCameraView, WorldPointM } from './types';

export const LAB_CAMERA_MODES: readonly LabCameraMode[] = ['orbit', 'first-person', 'top-down', 'inspection'];
export const DEFAULT_CAMERA_VIEW: LabCameraView = {
  mode: 'orbit', positionM: [3.6, 2.65, 4.1], targetM: [0, 1, 0], fovDeg: 42, orthographicHeightM: 5,
};
export const CAMERA_LIMITS = Object.freeze({
  nearM: 0.005, farM: 150, minDistanceM: 0.06, maxDistanceM: 60,
  minOrthoHeightM: 0.08, maxOrthoHeightM: 80, minEyeHeightM: 0.04,
});

export function copyCameraView(view: LabCameraView): LabCameraView {
  return { ...view, positionM: [...view.positionM], targetM: [...view.targetM] };
}

export function validateCameraView(view: LabCameraView): void {
  if (!LAB_CAMERA_MODES.includes(view.mode)) throw new RangeError('Unknown lab camera mode.');
  assertPointM(view.positionM, 'camera position');
  assertPointM(view.targetM, 'camera target');
  if (new Vector3(...view.positionM).distanceToSquared(new Vector3(...view.targetM)) < 1e-8) {
    throw new RangeError('Camera position and target must differ.');
  }
  if (!Number.isFinite(view.fovDeg) || view.fovDeg < 15 || view.fovDeg > 90 ||
      !Number.isFinite(view.orthographicHeightM) ||
      view.orthographicHeightM < CAMERA_LIMITS.minOrthoHeightM ||
      view.orthographicHeightM > CAMERA_LIMITS.maxOrthoHeightM) {
    throw new RangeError('Camera field of view or orthographic span is outside supported limits.');
  }
  if (view.positionM[1] < CAMERA_LIMITS.minEyeHeightM) throw new RangeError('Camera cannot pass below the floor.');
}

export function fitCameraToBounds(
  bounds: LabBoundsM,
  options: { mode?: LabCameraMode; aspect?: number; padding?: number; from?: LabCameraView } = {},
): LabCameraView {
  assertBoundsM(bounds);
  const from = options.from ?? DEFAULT_CAMERA_VIEW;
  const mode = options.mode ?? from.mode;
  const aspect = options.aspect ?? 1;
  const padding = options.padding ?? 1.25;
  if (!Number.isFinite(aspect) || aspect <= 0 || !Number.isFinite(padding) || padding < 1 || padding > 4) {
    throw new RangeError('Fit requires a positive aspect ratio and padding between 1 and 4.');
  }
  const target = new Vector3(...boundsCenter(bounds));
  const size = new Vector3(...bounds.maxM).sub(new Vector3(...bounds.minM));
  const orthoHeight = MathUtils.clamp(
    Math.max(size.z, size.x / aspect, 0.12) * padding,
    CAMERA_LIMITS.minOrthoHeightM, CAMERA_LIMITS.maxOrthoHeightM,
  );
  if (mode === 'top-down') {
    return {
      ...from, mode, targetM: target.toArray(),
      positionM: [target.x, Math.max(bounds.maxM[1] + 3, 4), target.z],
      orthographicHeightM: orthoHeight,
    };
  }
  const radius = Math.max(size.length() / 2, 0.04);
  const vFov = MathUtils.degToRad(from.fovDeg);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const distance = Math.min(radius * padding / Math.sin(Math.min(vFov, hFov) / 2), CAMERA_LIMITS.maxDistanceM);
  const direction = from.mode === 'top-down'
    ? new Vector3(1, 0.7, 1).normalize()
    : new Vector3(...from.positionM).sub(new Vector3(...from.targetM)).normalize();
  const eye = target.clone().addScaledVector(direction, Math.max(distance, CAMERA_LIMITS.minDistanceM));
  eye.y = Math.max(eye.y, CAMERA_LIMITS.minEyeHeightM);
  return { ...from, mode, positionM: eye.toArray(), targetM: target.toArray(), orthographicHeightM: orthoHeight };
}

export function cameraViewForMode(view: LabCameraView, mode: LabCameraMode): LabCameraView {
  if (!LAB_CAMERA_MODES.includes(mode)) throw new RangeError('Unknown lab camera mode.');
  const target = new Vector3(...view.targetM);
  const distance = new Vector3(...view.positionM).distanceTo(target);
  if (mode === 'top-down') {
    return {
      ...view, mode,
      positionM: [target.x, Math.max(target.y + distance, 3), target.z],
      orthographicHeightM: MathUtils.clamp(
        2 * distance * Math.tan(MathUtils.degToRad(view.fovDeg / 2)),
        CAMERA_LIMITS.minOrthoHeightM, CAMERA_LIMITS.maxOrthoHeightM,
      ),
    };
  }
  if (view.mode === 'top-down') {
    const orbitDistance = view.orthographicHeightM / (2 * Math.tan(MathUtils.degToRad(view.fovDeg / 2)));
    const eye = target.clone().addScaledVector(new Vector3(1, 0.7, 1).normalize(), orbitDistance);
    return { ...view, mode, positionM: eye.toArray() };
  }
  return { ...view, mode };
}

export function interpolateCameraView(from: LabCameraView, to: LabCameraView, fraction: number): LabCameraView {
  const t = MathUtils.clamp(fraction, 0, 1);
  const eased = t * t * (3 - 2 * t);
  const positionM = new Vector3(...from.positionM).lerp(new Vector3(...to.positionM), eased).toArray();
  const targetM = new Vector3(...from.targetM).lerp(new Vector3(...to.targetM), eased).toArray();
  return {
    ...to, positionM, targetM,
    fovDeg: MathUtils.lerp(from.fovDeg, to.fovDeg, eased),
    orthographicHeightM: MathUtils.lerp(from.orthographicHeightM, to.orthographicHeightM, eased),
  };
}

export function clampFirstPersonPosition(pointM: WorldPointM, bounds: LabBoundsM): WorldPointM {
  assertPointM(pointM);
  assertBoundsM(bounds);
  return [
    MathUtils.clamp(pointM[0], bounds.minM[0], bounds.maxM[0]),
    MathUtils.clamp(pointM[1], Math.max(bounds.minM[1], CAMERA_LIMITS.minEyeHeightM), bounds.maxM[1]),
    MathUtils.clamp(pointM[2], bounds.minM[2], bounds.maxM[2]),
  ];
}
