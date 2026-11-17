/**
 * Drives the camera for every required mode (orbit, inspect, top-down, first-person, cinematic),
 * installs `cameraDirectorApi` so other code can command it, and pauses on request so Agent 04 can
 * drag apparatus without fighting the orbit controls. Orbit/inspect/top-down/cinematic ride on the
 * proven `camera-controls` library (as the existing molecular-editor stage does, see
 * `render/CameraRig.tsx`); first-person is a small custom WASD + drag-look controller layered on
 * top, since it needs free movement rather than orbiting a target.
 */
import { CameraControls, OrthographicCamera, PerspectiveCamera } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import CameraControlsImpl from 'camera-controls';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Euler, Quaternion, Sphere, Vector3 } from 'three';
import type { OrthographicCamera as OrthographicCameraImpl, PerspectiveCamera as PerspectiveCameraImpl } from 'three';
import { CAMERA_MODE_CONFIG, FIRST_PERSON_CONFIG, clampPolar, effectiveAnimate, encompassingSphere, orthoZoomForHeight, sampleCinematicPath, visibleHeightForZoom } from './cameraModes';
import type { CinematicWaypoint, FocusTarget } from './cameraModes';
import { installCameraDirectorApi } from './cameraDirectorApi';
import type { CameraDirectorApi } from './cameraDirectorApi';
import type { CameraMode, Vec3M } from './types';

const FOV_DEG = 50;
const NEAR_M = 0.02;
const FAR_M = 500;
const HORIZON = Math.PI / 2;
/** Vertical placement for the drei orthographic camera; direction, not distance, is what matters once `camera-controls` takes over. */
const ORTHO_START_M = 12;

const isOrtho = (camera: unknown): camera is OrthographicCameraImpl => (camera as OrthographicCameraImpl).isOrthographicCamera === true;

/** Yaw/pitch (matching the first-person rig's convention) that look from `position` towards `target`. */
function yawPitchLookingAt(position: Vector3, target: Vector3): { yaw: number; pitch: number } {
  const forward = target.clone().sub(position);
  const r = forward.length();
  if (r < 1e-6) return { yaw: 0, pitch: HORIZON };
  return { yaw: Math.atan2(forward.x, forward.z), pitch: clampPolar('first-person', Math.acos(-forward.y / r)) };
}

/** The inverse of {@link yawPitchLookingAt}: the unit look direction for a given yaw/pitch, matching the render loop's `Euler('YXZ')` convention. */
function lookVectorFromYawPitch(yaw: number, pitch: number): Vector3 {
  const euler = new Euler(HORIZON - pitch, yaw, 0, 'YXZ');
  return new Vector3(0, 0, -1).applyEuler(euler);
}

/** Enough to reconstruct a pose regardless of which concrete camera (perspective/orthographic) is attached. */
interface CarriedView {
  readonly target: Vector3;
  /** Unit vector from the target towards the camera. */
  readonly direction: Vector3;
  /**
   * World-space height visible at the target — projection-agnostic, unlike `distance` (meaningless
   * for an orthographic camera) or `zoom` (meaningless for a perspective one, always 1). Restoring
   * this one number is what lets a mode switch that also changes projection (e.g. orbit to
   * top-down) land on a comparable framing instead of an arbitrary one.
   */
  readonly visibleHeightM: number;
}

/** Distance a perspective camera needs from its target to make `visibleHeightM` fill the vertical field of view. */
function perspectiveDistanceFor(visibleHeightM: number): number {
  return visibleHeightM / (2 * Math.tan((FOV_DEG * Math.PI) / 360));
}

/** The world-space height a perspective camera at `distance` shows, inverting {@link perspectiveDistanceFor}. */
function perspectiveVisibleHeight(distance: number): number {
  return 2 * distance * Math.tan((FOV_DEG * Math.PI) / 360);
}

export interface CameraDirectorProps {
  readonly mode: CameraMode;
  readonly reducedMotion?: boolean;
  /** Where the camera looks when it first mounts (metres); typically a station's bench height. */
  readonly initialTarget?: Vec3M;
  readonly initialPosition?: Vec3M;
}

/**
 * Cameras, `camera-controls`, the first-person rig and the cinematic player. One instance belongs
 * to one `<Canvas>`; `LabWorld` mounts exactly one even when several stations are visible.
 */
export function CameraDirector({ mode, reducedMotion = false, initialTarget = [0, 0.9, 0], initialPosition = [2.6, 2.0, 3.4] }: CameraDirectorProps) {
  const [controls, setControls] = useState<CameraControlsImpl | null>(null);
  const invalidate = useThree((s) => s.invalidate);
  const get = useThree((s) => s.get);

  const modeRef = useRef(mode);
  modeRef.current = mode;
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;

  const pauseReasons = useRef<Set<string>>(new Set());
  const introState = useRef<{ waypoints: readonly CinematicWaypoint[]; startedAt: number; resolve: () => void } | null>(null);
  const firstPerson = useRef({ position: new Vector3(...initialPosition), yaw: 0, pitch: HORIZON, dragging: false });
  const keysDown = useRef<Set<string>>(new Set());
  // Perspective and orthographic cameras are two separate `camera-controls` instances under the
  // hood (drei recreates the instance whenever the default camera itself changes, i.e. on every
  // projection switch), so the view has to be carried across that recreation by hand, exactly as
  // `render/CameraRig.tsx` does for the molecular editor.
  const carried = useRef<CarriedView | null>(null);

  const applyEnabled = (): void => {
    if (!controls) return;
    const cfg = CAMERA_MODE_CONFIG[modeRef.current];
    controls.enabled = cfg.userControllable && modeRef.current !== 'first-person' && !introState.current && pauseReasons.current.size === 0;
  };

  // ---------- Restore the carried view, then apply this mode's constraints ----------
  // Runs on mount, on every mode change, and whenever `controls` is recreated by a projection
  // switch — the last case is why restoring the view happens unconditionally here rather than in
  // a separate "only once" effect, which would miss it.
  useEffect(() => {
    if (!controls) return;
    const cfg = CAMERA_MODE_CONFIG[mode];

    if (carried.current) {
      const t = carried.current.target;
      const distance = perspectiveDistanceFor(carried.current.visibleHeightM);
      const p = t.clone().addScaledVector(carried.current.direction, distance);
      void controls.setLookAt(p.x, p.y, p.z, t.x, t.y, t.z, false);
      if (isOrtho(controls.camera)) {
        const canvasHeightPx = get().size.height || 800;
        void controls.zoomTo(orthoZoomForHeight(carried.current.visibleHeightM, canvasHeightPx), false);
      }
    } else {
      void controls.setLookAt(...initialPosition, ...initialTarget, false);
    }

    if (mode !== 'first-person') {
      controls.minDistance = cfg.minDistanceM;
      controls.maxDistance = cfg.maxDistanceM;
    }
    controls.minPolarAngle = cfg.minPolarRad;
    controls.maxPolarAngle = cfg.maxPolarRad;
    controls.smoothTime = cfg.smoothTime;
    controls.draggingSmoothTime = cfg.smoothTime * 0.4;

    if (mode === 'top-down') {
      // Locked straight down, pan and zoom only: no spin, so the layout reads like a plan drawing.
      controls.minAzimuthAngle = controls.azimuthAngle;
      controls.maxAzimuthAngle = controls.azimuthAngle;
      controls.mouseButtons.left = CameraControlsImpl.ACTION.TRUCK;
      controls.mouseButtons.wheel = CameraControlsImpl.ACTION.DOLLY;
      controls.mouseButtons.right = CameraControlsImpl.ACTION.NONE;
      controls.mouseButtons.middle = CameraControlsImpl.ACTION.NONE;
      void controls.rotateTo(controls.azimuthAngle, cfg.minPolarRad, false);
    } else {
      controls.minAzimuthAngle = -Infinity;
      controls.maxAzimuthAngle = Infinity;
      controls.mouseButtons.left = CameraControlsImpl.ACTION.ROTATE;
      controls.mouseButtons.wheel = CameraControlsImpl.ACTION.DOLLY;
      controls.mouseButtons.right = CameraControlsImpl.ACTION.TRUCK;
      controls.mouseButtons.middle = CameraControlsImpl.ACTION.DOLLY;
    }

    if (mode === 'first-person') {
      // Hand off from wherever camera-controls was looking to the free-look rig, so switching modes never jumps.
      controls.getPosition(firstPerson.current.position);
      const target = new Vector3();
      controls.getTarget(target);
      const { yaw, pitch } = yawPitchLookingAt(firstPerson.current.position, target);
      firstPerson.current.yaw = yaw;
      firstPerson.current.pitch = pitch;
    }

    applyEnabled();
    invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controls, mode, get, invalidate]);

  // ---------- Install the imperative API once `camera-controls` exists ----------
  useEffect(() => {
    if (!controls) return;
    const scratchA = new Vector3();
    const scratchB = new Vector3();

    const fitSphere = (target: FocusTarget, animate: boolean): void => {
      const sphere = new Sphere(new Vector3(target.center[0], target.center[1], target.center[2]), Math.max(0.02, target.radiusM) * 1.2);
      void controls.fitToSphere(sphere, animate);
      invalidate();
    };

    const api: CameraDirectorApi = {
      getMode: () => modeRef.current,
      getPose: () => {
        if (modeRef.current === 'first-person') {
          const fp = firstPerson.current;
          const forward = lookVectorFromYawPitch(fp.yaw, fp.pitch);
          const target = scratchB.copy(fp.position).addScaledVector(forward, 1);
          return { position: [fp.position.x, fp.position.y, fp.position.z], target: [target.x, target.y, target.z], zoom: 1, projection: 'perspective' };
        }
        const p = controls.getPosition(scratchA);
        const t = controls.getTarget(scratchB);
        return {
          position: [p.x, p.y, p.z],
          target: [t.x, t.y, t.z],
          zoom: controls.camera.zoom,
          projection: isOrtho(controls.camera) ? 'orthographic' : 'perspective',
        };
      },
      goToPose: (pose, animate = true) => {
        if (modeRef.current === 'first-person') {
          const fp = firstPerson.current;
          fp.position.set(...pose.position);
          const { yaw, pitch } = yawPitchLookingAt(fp.position, scratchA.set(...pose.target));
          fp.yaw = yaw;
          fp.pitch = pitch;
          invalidate();
          return;
        }
        const run = effectiveAnimate(animate, reducedMotionRef.current);
        void controls.setLookAt(...pose.position, ...pose.target, run);
        if (isOrtho(controls.camera)) void controls.zoomTo(pose.zoom, run);
        invalidate();
      },
      focus: (target, animate = true) => fitSphere(target, effectiveAnimate(animate, reducedMotionRef.current)),
      fitAll: (targets, animate = true) => fitSphere(encompassingSphere(targets), effectiveAnimate(animate, reducedMotionRef.current)),
      pause: (ownerId) => {
        pauseReasons.current.add(ownerId);
        applyEnabled();
      },
      resume: (ownerId) => {
        pauseReasons.current.delete(ownerId);
        applyEnabled();
      },
      isPaused: () => pauseReasons.current.size > 0,
      project: ([x, y, z]) => {
        const { camera, size } = get();
        camera.updateMatrixWorld();
        const p = scratchA.set(x, y, z).project(camera);
        if (p.z < -1 || p.z > 1) return null;
        return [(p.x * 0.5 + 0.5) * size.width, (-p.y * 0.5 + 0.5) * size.height];
      },
      redraw: () => invalidate(),
      playIntro: (waypoints) =>
        new Promise<void>((resolve) => {
          if (reducedMotionRef.current || waypoints.length < 2) {
            resolve();
            return;
          }
          pauseReasons.current.add('cinematic-intro');
          applyEnabled();
          introState.current = {
            waypoints,
            startedAt: performance.now(),
            resolve: () => {
              pauseReasons.current.delete('cinematic-intro');
              introState.current = null;
              applyEnabled();
              invalidate();
              resolve();
            },
          };
          invalidate();
        }),
      skipIntro: () => {
        if (introState.current) introState.current.startedAt = -Infinity;
        invalidate();
      },
    };
    return installCameraDirectorApi(api);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controls, get, invalidate]);

  // ---------- Keyboard (first-person movement; Escape skips a running intro) ----------
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      keysDown.current.add(e.key.toLowerCase());
      if (e.key === 'Escape' && introState.current) introState.current.startedAt = -Infinity;
    };
    const onUp = (e: KeyboardEvent) => keysDown.current.delete(e.key.toLowerCase());
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
    };
  }, []);

  // ---------- Pointer drag-to-look, active only in first-person mode ----------
  useEffect(() => {
    const canvas = get().gl.domElement;
    const onDown = (e: PointerEvent) => {
      if (modeRef.current !== 'first-person') return;
      firstPerson.current.dragging = true;
      canvas.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!firstPerson.current.dragging) return;
      const fp = firstPerson.current;
      fp.yaw -= e.movementX * FIRST_PERSON_CONFIG.lookSensitivityRadPerPx;
      fp.pitch = clampPolar('first-person', fp.pitch - e.movementY * FIRST_PERSON_CONFIG.lookSensitivityRadPerPx);
      invalidate();
    };
    const onUp = (e: PointerEvent) => {
      firstPerson.current.dragging = false;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    };
    canvas.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [get, invalidate]);

  const lookEuler = useMemo(() => new Euler(0, 0, 0, 'YXZ'), []);
  const lookQuat = useMemo(() => new Quaternion(), []);
  const carryScratchPos = useMemo(() => new Vector3(), []);
  const carryScratchTarget = useMemo(() => new Vector3(), []);

  useFrame((state, dt) => {
    // First-person movement: WASD/arrows translate in the look-flattened plane at a fixed eye height.
    if (modeRef.current === 'first-person') {
      const fp = firstPerson.current;
      const keys = keysDown.current;
      const forward = new Vector3(Math.sin(fp.yaw), 0, Math.cos(fp.yaw));
      const right = new Vector3(forward.z, 0, -forward.x);
      const move = new Vector3();
      if (keys.has('w') || keys.has('arrowup')) move.add(forward);
      if (keys.has('s') || keys.has('arrowdown')) move.sub(forward);
      if (keys.has('d') || keys.has('arrowright')) move.add(right);
      if (keys.has('a') || keys.has('arrowleft')) move.sub(right);
      if (move.lengthSq() > 0) move.normalize().multiplyScalar(FIRST_PERSON_CONFIG.moveSpeedMps * dt);
      fp.position.add(move);
      fp.position.y = FIRST_PERSON_CONFIG.eyeHeightM;

      // Pitch is measured like camera-controls' polarAngle (0 = down, PI/2 = level, PI = up),
      // so it reuses the same clamp as every other mode; the Euler below converts it to a tilt from level.
      lookEuler.set(HORIZON - fp.pitch, fp.yaw, 0, 'YXZ');
      lookQuat.setFromEuler(lookEuler);
      const camera = state.camera as PerspectiveCameraImpl;
      camera.position.copy(fp.position);
      camera.quaternion.copy(lookQuat);
      camera.updateMatrixWorld();
      if (move.lengthSq() > 0 || fp.dragging) invalidate();
      return;
    }

    if (!controls) return;

    // Scripted intro: sample the path directly, bypassing camera-controls' own damping.
    const intro = introState.current;
    if (intro) {
      const elapsed = (performance.now() - intro.startedAt) / 1000;
      const sample = sampleCinematicPath(intro.waypoints, elapsed);
      void controls.setLookAt(...sample.pose.position, ...sample.pose.target, false);
      invalidate();
      if (sample.finished) intro.resolve();
    }

    // Remember the current view (direction/visible-height, not the raw camera, which may be about
    // to be replaced) so a projection switch — a different mode, or the cinematic intro leaving a
    // perspective camera — can restore a comparable framing instead of resetting to the initial pose.
    const distance = controls.distance;
    if (distance > 1e-6) {
      controls.getPosition(carryScratchPos);
      controls.getTarget(carryScratchTarget);
      const ortho = isOrtho(controls.camera);
      carried.current = {
        target: carryScratchTarget.clone(),
        direction: carryScratchPos.clone().sub(carryScratchTarget).divideScalar(distance),
        visibleHeightM: ortho ? visibleHeightForZoom(controls.camera.zoom, get().size.height || 800) : perspectiveVisibleHeight(distance),
      };
    }
  });

  return (
    <>
      <PerspectiveCamera makeDefault={CAMERA_MODE_CONFIG[mode].projection === 'perspective'} fov={FOV_DEG} near={NEAR_M} far={FAR_M} position={initialPosition} />
      <OrthographicCamera makeDefault={CAMERA_MODE_CONFIG[mode].projection === 'orthographic'} near={NEAR_M} far={FAR_M} position={[initialPosition[0], ORTHO_START_M, initialPosition[2]]} zoom={orthoZoomForHeight(6, get().size.height || 800)} />
      <CameraControls ref={setControls} makeDefault={mode !== 'first-person'} dollyToCursor minDistance={0.05} maxDistance={60} />
    </>
  );
}
