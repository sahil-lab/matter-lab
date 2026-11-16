import { boundingSphere } from '@matterlab/core';
import type { AtomId, Vec3 } from '@matterlab/core';
import { CameraControls, OrthographicCamera, PerspectiveCamera } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import type CameraControlsImpl from 'camera-controls';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Fog, MathUtils, Sphere, Vector3 } from 'three';
import type { OrthographicCamera as OrthographicCameraImpl, PerspectiveCamera as PerspectiveCameraImpl } from 'three';
import { lab, useLab } from '../state/store';
import type { CameraPose, LabState } from '../state/store';
import { useSettledScene } from '../state/useSettledScene';
import { requestCapture } from './capture';
import { installViewApi, nearestTurn, publishViewFrame } from './viewApi';
import type { StandardView, ViewApi } from './viewApi';

const FOV = 32;
const ORTHO_DISTANCE = 400;
const BACKGROUND = '#080d18';
/** Screen width, margins included, that the inspector and a workspace's side panel take from the view. */
const INSPECTOR_INSET_PX = 342;
const SIDE_PANEL_INSET_PX = 364;

/** Width that the open panels take from the view, in CSS pixels. */
function panelInsets(s: LabState, width: number): { left: number; right: number } {
  if (width <= 900) return { left: 0, right: 0 };
  return { left: s.workspace !== 'architect' && s.sidePanelOpen ? SIDE_PANEL_INSET_PX : 0, right: s.inspectorOpen ? INSPECTOR_INSET_PX : 0 };
}

/** How far the picture is shifted so the scene stays centred in the area the panels leave free. */
function viewShiftPx(s: LabState, width: number): number {
  const { left, right } = panelInsets(s, width);
  return (right - left) / 2;
}

/**
 * How much smaller a fitted structure has to be drawn so that it fits between the panels. Only
 * matters when the free strip is narrower than the view is high, as on a small laptop with both
 * panels open; otherwise the height limits the size and nothing changes.
 */
function fitShrink(s: LabState, width: number, height: number): number {
  const { left, right } = panelInsets(s, width);
  const free = Math.max(240, width - left - right);
  return Math.max(1, Math.min(width, height) / Math.min(free, height));
}

interface CarriedView {
  readonly target: Vector3;
  /** Unit vector from the target towards the camera. */
  readonly direction: Vector3;
  /** Height of the visible region at the target, in angstrom. */
  readonly height: number;
}

// Kept outside React so the view survives projection switches and canvas remounts.
let carried: CarriedView | null = null;
let pendingPose: CameraPose | null = null;

const STANDARD_VIEWS: Readonly<Record<StandardView, readonly [azimuth: number, polar: number]>> = {
  front: [0, Math.PI / 2],
  back: [Math.PI, Math.PI / 2],
  right: [Math.PI / 2, Math.PI / 2],
  left: [-Math.PI / 2, Math.PI / 2],
  top: [0, 0.0001],
  bottom: [0, Math.PI - 0.0001],
  iso: [Math.PI / 4, Math.acos(1 / Math.sqrt(3))],
};

/** The direction a scene is first shown from, and returns to on "Reset view". */
const OPENING_VIEW: readonly [azimuth: number, polar: number] = [0.42, 1.2];

const isOrtho = (camera: unknown): camera is OrthographicCameraImpl => (camera as OrthographicCameraImpl).isOrthographicCamera === true;

function applyView(controls: CameraControlsImpl, view: CarriedView, viewportHeight: number, animate: boolean): void {
  const t = view.target;
  if (isOrtho(controls.camera)) {
    const p = t.clone().addScaledVector(view.direction, ORTHO_DISTANCE);
    void controls.setLookAt(p.x, p.y, p.z, t.x, t.y, t.z, animate);
    void controls.zoomTo(viewportHeight / view.height, animate);
  } else {
    const distance = view.height / (2 * Math.tan(MathUtils.degToRad(FOV) / 2));
    const p = t.clone().addScaledVector(view.direction, distance);
    void controls.setLookAt(p.x, p.y, p.z, t.x, t.y, t.z, animate);
  }
}

/**
 * Cameras, orbit controls and everything that depends on the camera each frame: depth fog, the view
 * shift that keeps content clear of the inspector, and the data feed for the axis gizmo and scale bar.
 */
export function CameraRig() {
  const projection = useLab((s) => s.projection);
  const panels = useLab((s) => `${s.inspectorOpen}-${s.workspace}-${s.sidePanelOpen}`);
  const scene = useLab((s) => s.scene);
  const [controls, setControls] = useState<CameraControlsImpl | null>(null);
  const invalidate = useThree((s) => s.invalidate);
  const get = useThree((s) => s.get);
  const threeScene = useThree((s) => s.scene);

  // The depth fog only needs the rough size of the structure, so for a large one it follows once editing pauses.
  const { scene: sizedScene } = useSettledScene(scene);
  const sceneRadius = useMemo(() => boundingSphere(sizedScene, undefined, 1.6)?.radius ?? 4, [sizedScene]);
  const radiusRef = useRef(sceneRadius);
  radiusRef.current = sceneRadius;
  const shift = useRef(viewShiftPx(lab.get(), window.innerWidth));
  const fog = useMemo(() => new Fog(BACKGROUND, 10, 80), []);

  useEffect(() => {
    threeScene.fog = fog;
    return () => {
      threeScene.fog = null;
    };
  }, [threeScene, fog]);

  // Runs whenever the controls are (re)created: on mount and after every projection switch.
  useEffect(() => {
    if (!controls) return;
    const height = get().size.height;
    const fit = (ids: Iterable<AtomId> | undefined, animate: boolean, minRadius: number) => {
      const sphere = boundingSphere(lab.get().scene, ids, 1.1);
      if (!sphere) {
        void controls.setLookAt(0, 2.2, 13, 0, 0, 0, animate);
        if (isOrtho(controls.camera)) void controls.zoomTo(get().size.height / 12, animate);
      } else {
        const [x, y, z] = sphere.center;
        const { width, height } = get().size;
        const radius = Math.max(minRadius, sphere.radius) * 1.06 * fitShrink(lab.get(), width, height);
        void controls.fitToSphere(new Sphere(new Vector3(x, y, z), radius), animate);
      }
      get().invalidate();
    };

    if (pendingPose && pendingPose.projection === lab.get().projection) {
      const pose = pendingPose;
      pendingPose = null;
      void controls.setLookAt(...pose.position, ...pose.target, false);
      if (isOrtho(controls.camera)) void controls.zoomTo(pose.zoom, false);
    } else if (carried) {
      applyView(controls, carried, height, false);
    } else {
      void controls.rotateTo(OPENING_VIEW[0], OPENING_VIEW[1], false);
      fit(undefined, false, 2.4);
    }
    controls.update(0);
    invalidate();

    const scratchA = new Vector3();
    const scratchB = new Vector3();
    const api: ViewApi = {
      fitAll: (animate = true) => fit(undefined, animate, 2.4),
      focusAtoms: (ids, animate = true) => fit(ids, animate, 2.6),
      setStandardView: (view) => {
        const [azimuth, polar] = STANDARD_VIEWS[view];
        void controls.rotateTo(nearestTurn(controls.azimuthAngle, azimuth), polar, true);
        invalidate();
      },
      resetView: (animate = true) => {
        void controls.rotateTo(nearestTurn(controls.azimuthAngle, OPENING_VIEW[0]), OPENING_VIEW[1], animate);
        fit(undefined, animate, 2.4);
      },
      zoomBy: (factor) => {
        if (isOrtho(controls.camera)) void controls.zoom(controls.camera.zoom * (factor - 1), true);
        else void controls.dolly(controls.distance * (1 - 1 / factor), true);
        invalidate();
      },
      getPose: () => {
        const p = controls.getPosition(scratchA);
        const t = controls.getTarget(scratchB);
        return {
          position: [p.x, p.y, p.z],
          target: [t.x, t.y, t.z],
          zoom: controls.camera.zoom,
          projection: isOrtho(controls.camera) ? 'orthographic' : 'perspective',
        };
      },
      setPose: (pose, animate = true) => {
        const current = isOrtho(controls.camera) ? 'orthographic' : 'perspective';
        if (pose.projection !== current) {
          pendingPose = pose;
          return;
        }
        void controls.setLookAt(...pose.position, ...pose.target, animate);
        if (isOrtho(controls.camera)) void controls.zoomTo(pose.zoom, animate);
        invalidate();
      },
      getBasis: () => {
        const e = controls.camera.matrixWorld.elements;
        return {
          right: [e[0]!, e[1]!, e[2]!] as Vec3,
          up: [e[4]!, e[5]!, e[6]!] as Vec3,
          forward: [-e[8]!, -e[9]!, -e[10]!] as Vec3,
        };
      },
      getTarget: () => {
        const t = controls.getTarget(scratchB);
        return [t.x, t.y, t.z];
      },
      capture: (maxWidth) => {
        const promise = requestCapture(maxWidth);
        invalidate();
        return promise;
      },
      redraw: () => invalidate(),
      project: ([x, y, z]) => {
        const { camera, size } = get();
        camera.updateMatrixWorld();
        const p = scratchA.set(x, y, z).project(camera);
        if (p.z < -1 || p.z > 1) return null;
        return [(p.x * 0.5 + 0.5) * size.width, (-p.y * 0.5 + 0.5) * size.height];
      },
    };
    return installViewApi(api);
  }, [controls, get, invalidate]);

  const position = useRef(new Vector3());
  const target = useRef(new Vector3());
  const published = useRef({ a: 0, b: 0, c: 0, scale: 0 });

  useFrame((state, delta) => {
    if (!controls) return;
    const camera = controls.camera as PerspectiveCameraImpl | OrthographicCameraImpl;
    const { width, height } = state.size;
    controls.getPosition(position.current);
    controls.getTarget(target.current);
    const distance = position.current.distanceTo(target.current);
    const ortho = isOrtho(camera);
    const visibleHeight = ortho ? height / camera.zoom : 2 * distance * Math.tan(MathUtils.degToRad(FOV) / 2);

    if (distance > 1e-6) {
      carried = {
        target: target.current.clone(),
        direction: position.current.clone().sub(target.current).divideScalar(distance),
        height: visibleHeight,
      };
    }

    // Shift the projection so the scene stays centred in the area not covered by panels.
    const wanted = viewShiftPx(lab.get(), width);
    if (Math.abs(wanted - shift.current) > 0.3) {
      shift.current += (wanted - shift.current) * (1 - Math.exp(-delta * 11));
      state.invalidate();
    } else shift.current = wanted;
    const view = camera.view;
    if (!view || !view.enabled || view.offsetX !== shift.current || view.fullWidth !== width || view.fullHeight !== height) {
      camera.setViewOffset(width, height, shift.current, 0, width, height);
    }

    // Fog starts near the front of the structure and deepens behind it, as a depth cue.
    const r = radiusRef.current;
    fog.near = Math.max(0.1, distance - r * 0.35);
    fog.far = distance + r * 2.7 + 14;

    const e = camera.matrixWorldInverse.elements;
    const scale = visibleHeight / height;
    const last = published.current;
    if (Math.abs(e[0]! - last.a) + Math.abs(e[5]! - last.b) + Math.abs(e[10]! - last.c) > 1e-5 || Math.abs(scale - last.scale) > scale * 1e-3) {
      published.current = { a: e[0]!, b: e[5]!, c: e[10]!, scale };
      publishViewFrame({
        rotation: [e[0]!, e[4]!, e[8]!, e[1]!, e[5]!, e[9]!, e[2]!, e[6]!, e[10]!],
        angstromPerPixel: scale,
        orthographic: ortho,
      });
    }
  });

  useEffect(() => invalidate(), [panels, invalidate]);

  return (
    <>
      <PerspectiveCamera makeDefault={projection === 'perspective'} fov={FOV} near={0.1} far={4000} position={[0, 0, 14]} />
      <OrthographicCamera makeDefault={projection === 'orthographic'} near={0.1} far={4000} position={[0, 0, ORTHO_DISTANCE]} zoom={60} />
      <CameraControls
        ref={setControls}
        makeDefault
        smoothTime={0.2}
        draggingSmoothTime={0.075}
        dollyToCursor
        dollySpeed={0.9}
        minDistance={1}
        maxDistance={2500}
        minZoom={2}
        maxZoom={4000}
        restThreshold={0.002}
      />
    </>
  );
}
