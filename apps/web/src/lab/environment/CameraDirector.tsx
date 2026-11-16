import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { MathUtils, MOUSE, OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { LabCameraController, CameraDriver } from './CameraController';
import {
  CAMERA_LIMITS, clampFirstPersonPosition, copyCameraView, DEFAULT_CAMERA_VIEW, interpolateCameraView,
} from './cameraMath';
import { projectWorldPoint, rayFromViewport } from './coordinates';
import type { LabBoundsM, LabCameraView } from './types';

interface CameraRuntime { step(deltaS: number): void; resize(width: number, height: number): void }
const movementKeys = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight', 'ShiftLeft', 'ShiftRight']);

export interface CameraDirectorProps {
  readonly controller: LabCameraController;
  readonly navigationBoundsM?: LabBoundsM;
  /** Internal identity retained only across a LabCanvas renderer fallback. */
  readonly canvasOwner?: symbol;
}

/** Camera state is private to this isolated meter-scale canvas, not the molecular renderer. */
export function CameraDirector({ controller, navigationBoundsM, canvasOwner }: CameraDirectorProps) {
  const get = useThree((state) => state.get);
  const size = useThree((state) => state.size);
  const runtime = useRef<CameraRuntime | null>(null);
  const bounds = useRef(navigationBoundsM);
  bounds.current = navigationBoundsM;

  useEffect(() => {
    const state = get();
    const originalCamera = state.camera;
    const canvas = state.gl.domElement;
    const ownerDocument = canvas.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    const originalTabIndex = canvas.getAttribute('tabindex');
    const originalLabel = canvas.getAttribute('aria-label');
    const originalTouchAction = canvas.style.touchAction;
    canvas.tabIndex = 0;
    canvas.setAttribute('aria-label', 'Laboratory 3D viewport, meters. Drag to orbit; right-drag to pan; wheel to zoom. Keys 1–4 change camera, F focuses station, Home resets, Escape skips entry. First-person: drag to look, WASD to move, Q/E down/up.');
    const perspective = Object.assign(new PerspectiveCamera(42, 1, CAMERA_LIMITS.nearM, CAMERA_LIMITS.farM), { manual: true });
    const orthographic = Object.assign(new OrthographicCamera(-3, 3, 3, -3, CAMERA_LIMITS.nearM, CAMERA_LIMITS.farM), { manual: true });
    let camera: PerspectiveCamera | OrthographicCamera = perspective;
    let mode = controller.getView().mode;
    let orbit: OrbitControls | null = null;
    let enabled = true;
    let applying = false;
    let width = state.size.width;
    let height = state.size.height;
    let orthoHeightM = controller.getView().orthographicHeightM;
    let transition: { from: LabCameraView; to: LabCameraView; elapsedS: number; durationS: number; complete?: () => void } | null = null;
    let looking: { pointerId: number; x: number; y: number } | null = null;
    const keys = new Set<string>();
    const target = new Vector3();
    const direction = new Vector3();
    const right = new Vector3();
    const motion = new Vector3();
    const up = new Vector3(0, 1, 0);

    function readView(): LabCameraView {
      return {
        mode, positionM: camera.position.toArray(), targetM: target.toArray(),
        fovDeg: perspective.fov,
        orthographicHeightM: camera === orthographic ? orthoHeightM / orthographic.zoom : orthoHeightM,
      };
    }
    function resize(w: number, h: number) {
      width = Math.max(1, w);
      height = Math.max(1, h);
      const aspect = width / height;
      perspective.aspect = aspect;
      perspective.updateProjectionMatrix();
      orthographic.left = -orthoHeightM * aspect / 2;
      orthographic.right = orthoHeightM * aspect / 2;
      orthographic.top = orthoHeightM / 2;
      orthographic.bottom = -orthoHeightM / 2;
      orthographic.updateProjectionMatrix();
      controller.setAspect(aspect);
      get().invalidate();
    }
    function onOrbitChange() {
      if (!orbit || applying || !enabled) return;
      target.copy(orbit.target);
      camera.position.y = Math.max(camera.position.y, CAMERA_LIMITS.minEyeHeightM);
      camera.updateMatrixWorld();
      get().invalidate();
    }
    function onOrbitStart() {
      if (!enabled) return;
      controller.interruptMotion();
    }
    function onOrbitEnd() {
      if (enabled && !applying) controller.commitView(readView());
    }
    function createOrbit() {
      orbit?.dispose();
      orbit = null;
      if (!enabled || mode === 'first-person') return;
      orbit = new OrbitControls(camera, canvas);
      orbit.target.copy(target);
      // No hidden inertia to resume after an editor lock. Programmatic moves use explicit easing.
      orbit.enableDamping = false;
      orbit.enableRotate = mode !== 'top-down';
      orbit.enablePan = mode !== 'inspection';
      orbit.screenSpacePanning = mode === 'top-down';
      orbit.minPolarAngle = mode === 'top-down' ? 0 : 0.025;
      orbit.maxPolarAngle = mode === 'top-down' ? Math.PI : Math.PI / 2 - 0.015;
      orbit.minDistance = CAMERA_LIMITS.minDistanceM;
      orbit.maxDistance = CAMERA_LIMITS.maxDistanceM;
      orbit.minZoom = orthoHeightM / CAMERA_LIMITS.maxOrthoHeightM;
      orbit.maxZoom = orthoHeightM / CAMERA_LIMITS.minOrthoHeightM;
      orbit.zoomSpeed = 0.7;
      orbit.rotateSpeed = 0.65;
      orbit.panSpeed = 0.7;
      orbit.mouseButtons.LEFT = mode === 'top-down' ? MOUSE.PAN : MOUSE.ROTATE;
      orbit.listenToKeyEvents(canvas);
      orbit.addEventListener('change', onOrbitChange);
      orbit.addEventListener('start', onOrbitStart);
      orbit.addEventListener('end', onOrbitEnd);
      orbit.enabled = transition === null;
      applying = true;
      orbit.update();
      applying = false;
    }
    function applyView(view: LabCameraView) {
      const projection = view.mode === 'top-down' ? orthographic : perspective;
      const changed = projection !== camera || mode !== view.mode;
      camera = projection;
      mode = view.mode;
      if (mode === 'top-down') camera.up.set(0, 0, -1);
      else camera.up.set(0, 1, 0);
      camera.position.set(...view.positionM);
      target.set(...view.targetM);
      perspective.fov = view.fovDeg;
      orthoHeightM = view.orthographicHeightM;
      orthographic.zoom = 1;
      camera.lookAt(target);
      camera.updateMatrixWorld();
      resize(width, height);
      if (get().camera !== camera) get().set({ camera });
      if (changed || !orbit) createOrbit();
      else {
        orbit.target.copy(target);
        orbit.minZoom = orthoHeightM / CAMERA_LIMITS.maxOrthoHeightM;
        orbit.maxZoom = orthoHeightM / CAMERA_LIMITS.minOrthoHeightM;
      }
    }
    function cancelMotion() {
      transition = null;
      keys.clear();
      looking = null;
      if (orbit) orbit.enabled = enabled;
    }
    const driver: CameraDriver = {
      getView: readView,
      cancelMotion,
      moveTo(view, durationS, complete) {
        const from = readView();
        const projectionChanged = (mode === 'top-down') !== (view.mode === 'top-down');
        if (durationS <= 0 || projectionChanged) {
          transition = null;
          applyView(view);
          complete?.();
        } else {
          transition = { from: copyCameraView(from), to: copyCameraView(view), elapsedS: 0, durationS, complete };
          if (orbit) orbit.enabled = false;
        }
        get().invalidate();
      },
      setEnabled(value) {
        enabled = value;
        cancelMotion();
        // Recreate listeners/state on release so an old held pointer never resumes navigation.
        createOrbit();
      },
      getWorldRay: (x, y) => rayFromViewport(camera, x, y, canvas.getBoundingClientRect()),
      projectPoint: (pointM) => projectWorldPoint(camera, pointM, canvas.getBoundingClientRect()),
    };
    const disconnect = controller.connectDriver(driver, canvasOwner);

    function onPointerDown(event: PointerEvent) {
      if (!enabled || event.target !== canvas) return;
      controller.interruptMotion();
      canvas.focus({ preventScroll: true });
      if (mode === 'first-person' && event.button === 0) {
        looking = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      }
    }
    function onPointerMove(event: PointerEvent) {
      if (!enabled || !looking || event.pointerId !== looking.pointerId || mode !== 'first-person') return;
      direction.copy(target).sub(camera.position);
      const distance = Math.max(direction.length(), 0.2);
      direction.normalize();
      const yaw = Math.atan2(direction.x, direction.z) - (event.clientX - looking.x) * 0.003;
      const pitch = MathUtils.clamp(Math.asin(direction.y) - (event.clientY - looking.y) * 0.003, -1.45, 1.45);
      direction.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
      target.copy(camera.position).addScaledVector(direction, distance);
      camera.lookAt(target);
      camera.updateMatrixWorld();
      looking.x = event.clientX;
      looking.y = event.clientY;
      get().invalidate();
    }
    function onPointerUp(event: PointerEvent) {
      if (!looking || event.pointerId !== looking.pointerId) return;
      looking = null;
      if (enabled) controller.commitView(readView());
    }
    function onKeyDown(event: KeyboardEvent) {
      if (!enabled || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.code === 'Escape') { controller.skipCinematic(); return; }
      const modeKeys = { Digit1: 'orbit', Digit2: 'first-person', Digit3: 'top-down', Digit4: 'inspection' } as const;
      if (event.code in modeKeys) {
        event.preventDefault();
        controller.setMode(modeKeys[event.code as keyof typeof modeKeys]);
        return;
      }
      if (event.code === 'Home') { event.preventDefault(); controller.setView(DEFAULT_CAMERA_VIEW); return; }
      if (event.code === 'KeyF') {
        const snapshot = controller.getSnapshot();
        const id = snapshot.activeStationId ?? snapshot.stations[0]?.id;
        if (id) { event.preventDefault(); controller.focusStation(id); }
        return;
      }
      if (mode === 'first-person' && movementKeys.has(event.code)) {
        event.preventDefault();
        if (transition) controller.interruptMotion();
        keys.add(event.code);
        get().invalidate();
      } else if (event.key === '+' || event.key === '=' || event.key === '-') {
        event.preventDefault();
        const view = readView();
        const scale = event.key === '-' ? 1.12 : 1 / 1.12;
        if (mode === 'top-down') {
          controller.setView({ ...view, orthographicHeightM: MathUtils.clamp(view.orthographicHeightM * scale, CAMERA_LIMITS.minOrthoHeightM, CAMERA_LIMITS.maxOrthoHeightM) }, { animate: false });
        } else {
          direction.copy(camera.position).sub(target);
          direction.setLength(MathUtils.clamp(direction.length() * scale, CAMERA_LIMITS.minDistanceM, CAMERA_LIMITS.maxDistanceM));
          const position = target.clone().add(direction);
          position.y = Math.max(position.y, CAMERA_LIMITS.minEyeHeightM);
          controller.setView({ ...view, positionM: position.toArray() }, { animate: false });
        }
      }
    }
    function onKeyUp(event: KeyboardEvent) {
      keys.delete(event.code);
      if (enabled && (movementKeys.has(event.code) || event.code.startsWith('Arrow'))) controller.commitView(readView());
    }
    function onBlur() {
      keys.clear();
      looking = null;
      if (enabled) controller.commitView(readView());
    }
    canvas.addEventListener('pointerdown', onPointerDown, true);
    canvas.addEventListener('keydown', onKeyDown);
    canvas.addEventListener('keyup', onKeyUp);
    canvas.addEventListener('blur', onBlur);
    ownerDocument.addEventListener('pointermove', onPointerMove);
    ownerDocument.addEventListener('pointerup', onPointerUp);
    ownerDocument.addEventListener('pointercancel', onPointerUp);
    ownerWindow?.addEventListener('blur', onBlur);

    runtime.current = {
      resize,
      step(deltaS) {
        if (!enabled) return;
        if (transition) {
          const current = transition;
          current.elapsedS = Math.min(current.durationS, current.elapsedS + Math.min(deltaS, 0.1));
          applyView(interpolateCameraView(current.from, current.to, current.elapsedS / current.durationS));
          if (current.elapsedS >= current.durationS) {
            transition = null;
            if (orbit) orbit.enabled = true;
            controller.commitView(readView());
            current.complete?.();
          }
          get().invalidate();
          return;
        }
        if (mode !== 'first-person' || keys.size === 0) return;
        direction.copy(target).sub(camera.position);
        direction.y = 0;
        if (direction.lengthSq() < 1e-8) direction.set(0, 0, -1);
        direction.normalize();
        right.crossVectors(direction, up).normalize();
        motion.set(0, 0, 0);
        if (keys.has('KeyW') || keys.has('ArrowUp')) motion.add(direction);
        if (keys.has('KeyS') || keys.has('ArrowDown')) motion.sub(direction);
        if (keys.has('KeyD') || keys.has('ArrowRight')) motion.add(right);
        if (keys.has('KeyA') || keys.has('ArrowLeft')) motion.sub(right);
        if (keys.has('KeyE')) motion.y += 1;
        if (keys.has('KeyQ')) motion.y -= 1;
        const speedMPerS = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 2.4 : 0.85;
        motion.normalize().multiplyScalar(speedMPerS * Math.min(deltaS, 0.05));
        const previous = camera.position.clone();
        const next = camera.position.clone().add(motion);
        camera.position.set(...clampFirstPersonPosition(next.toArray(), bounds.current ?? controller.getNavigationBounds()));
        target.add(camera.position.clone().sub(previous));
        camera.updateMatrixWorld();
        get().invalidate();
      },
    };
    resize(width, height);
    return () => {
      disconnect();
      runtime.current = null;
      orbit?.dispose();
      canvas.removeEventListener('pointerdown', onPointerDown, true);
      canvas.removeEventListener('keydown', onKeyDown);
      canvas.removeEventListener('keyup', onKeyUp);
      canvas.removeEventListener('blur', onBlur);
      ownerDocument.removeEventListener('pointermove', onPointerMove);
      ownerDocument.removeEventListener('pointerup', onPointerUp);
      ownerDocument.removeEventListener('pointercancel', onPointerUp);
      ownerWindow?.removeEventListener('blur', onBlur);
      canvas.style.touchAction = originalTouchAction;
      if (originalTabIndex === null) canvas.removeAttribute('tabindex'); else canvas.setAttribute('tabindex', originalTabIndex);
      if (originalLabel === null) canvas.removeAttribute('aria-label'); else canvas.setAttribute('aria-label', originalLabel);
      if (get().camera === camera) get().set({ camera: originalCamera });
    };
  }, [controller, get, canvasOwner]);

  useEffect(() => { runtime.current?.resize(size.width, size.height); }, [size.width, size.height]);
  useFrame((_, deltaS) => runtime.current?.step(deltaS), -1);
  return null;
}
