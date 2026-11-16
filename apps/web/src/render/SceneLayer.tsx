import { validateScene } from '@matterlab/core';
import type { AtomId, Scene } from '@matterlab/core';
import { useFrame, useThree } from '@react-three/fiber';
import type CameraControlsImpl from 'camera-controls';
import { useEffect, useMemo, useRef } from 'react';
import { shallow } from 'zustand/shallow';
import { GhostPreview } from '../interaction/GhostPreview';
import { InteractionController } from '../interaction/InteractionController';
import { runCommand } from '../state/commands';
import { lab } from '../state/store';
import { FieldLayer } from './FieldLayer';
import { GhostOverlay } from './GhostOverlay';
import { LabelLayer } from './Labels';
import { cylinderSegmentsFor, sphereDetailFor } from './quality';
import type { QualitySettings } from './quality';
import { SceneView } from './SceneView';
import type { GeometryDetail } from './SceneView';
import { MODE_STYLES, lerpStyle } from './style';
import type { ModeStyle } from './style';
import { installStageApi, subscribeViewFrame } from './viewApi';

const TRANSITION_MS = 380;
/** Above this size a representation change is applied at once rather than animated. */
const ANIMATE_LIMIT = 12000;
const OUTLINE_PX = 2.3;
const NOTHING_FLAGGED: ReadonlyMap<AtomId, 'error' | 'warning'> = new Map();

function detailFor(quality: QualitySettings, scene: Scene): GeometryDetail {
  return {
    sphereDetail: sphereDetailFor(quality, scene.atoms.size),
    cylinderSegments: cylinderSegmentsFor(quality, scene.bonds.size),
    clearcoat: quality.clearcoat,
  };
}

function flaggedAtoms(scene: Scene): ReadonlyMap<AtomId, 'error' | 'warning'> {
  const flagged = new Map<AtomId, 'error' | 'warning'>();
  for (const issue of validateScene(scene).issues) {
    if (issue.severity === 'info') continue;
    for (const id of issue.atomIds) {
      if (issue.severity === 'error' || !flagged.has(id)) flagged.set(id, issue.severity);
    }
  }
  return flagged;
}

/**
 * Connects the store to MatterRender: creates the instanced scene view, keeps it in step with the
 * scene, selection and representation, and wires up pointer and keyboard interaction.
 */
export function SceneLayer({ quality }: { quality: QualitySettings }) {
  const gl = useThree((s) => s.gl);
  const get = useThree((s) => s.get);
  const invalidate = useThree((s) => s.invalidate);

  const view = useMemo(() => new SceneView(detailFor(quality, lab.get().scene)), []); // eslint-disable-line react-hooks/exhaustive-deps
  const ghost = useMemo(() => new GhostPreview(), []);
  const compare = useMemo(() => new GhostOverlay(), []);
  const fields = useMemo(() => new FieldLayer(), []);
  const labels = useMemo(() => new LabelLayer(() => invalidate()), []); // eslint-disable-line react-hooks/exhaustive-deps
  const transition = useRef<{ from: ModeStyle; to: ModeStyle; start: number } | null>(null);
  const currentStyle = useRef<ModeStyle>(MODE_STYLES[lab.get().renderMode]);

  useEffect(() => {
    return () => {
      view.dispose();
      ghost.dispose();
      compare.dispose();
      fields.dispose();
      labels.dispose();
    };
  }, [view, ghost, compare, fields, labels]);

  // Computed results (an optimiser's path, a geometry to compare with, fields) reach the stage through here.
  useEffect(() => {
    // Surfaces can be cut open along the cutting plane.
    gl.localClippingEnabled = true;
    return installStageApi({
      setTransient(positions) {
        view.setTransient(positions);
        invalidate();
      },
      setGhost(geometry) {
        compare.set(geometry);
        invalidate();
      },
      setSurfaces(surfaces) {
        fields.setSurfaces(surfaces);
        invalidate();
      },
      setSlice(slice) {
        fields.setSlice(slice);
        invalidate();
      },
      setCloud(cloud) {
        fields.setCloud(cloud);
        invalidate();
      },
      setCut(cut) {
        fields.setCut(cut);
        invalidate();
      },
    });
  }, [gl, view, compare, fields, invalidate]);

  // Atom labels follow the instanced atoms.
  useEffect(() => {
    const rebuild = () => labels.rebuild(lab.get().scene, view, lab.get().labelMode);
    view.onChange = (kind) => (kind === 'rebuild' ? rebuild() : labels.reposition(view));
    rebuild();
    const stop = lab.subscribe(
      (s) => s.labelMode,
      () => {
        rebuild();
        invalidate();
      },
    );
    return () => {
      view.onChange = null;
      stop();
    };
  }, [view, labels, invalidate]);

  // Quality presets and level of detail.
  useEffect(() => {
    view.configure(detailFor(quality, lab.get().scene));
    invalidate();
  }, [view, quality, invalidate]);

  useEffect(() => {
    view.setStyle(currentStyle.current);
    view.sync(lab.get().scene, null);

    const applyHighlights = () => {
      const s = lab.get();
      view.setHighlights({
        selectedAtoms: s.selectedAtoms,
        selectedBonds: s.selectedBonds,
        hoveredAtom: s.hoveredAtom,
        hoveredBond: s.hoveredBond,
        picks: s.measurePicks,
        flagged: s.editMode === 'physics' ? flaggedAtoms(s.scene) : NOTHING_FLAGGED,
      });
      invalidate();
    };
    applyHighlights();

    const stopScene = lab.subscribe(
      (s) => s.scene,
      (scene) => {
        view.configure(detailFor(quality, scene));
        view.sync(scene, lab.get().lastPatch);
        invalidate();
      },
    );
    const stopHighlights = lab.subscribe(
      (s) => [s.selectedAtoms, s.selectedBonds, s.hoveredAtom, s.hoveredBond, s.measurePicks, s.editMode, s.scene] as const,
      applyHighlights,
      { equalityFn: shallow },
    );
    const stopMode = lab.subscribe(
      (s) => s.renderMode,
      (mode) => {
        const target = MODE_STYLES[mode];
        if (lab.get().scene.atoms.size > ANIMATE_LIMIT) {
          transition.current = null;
          currentStyle.current = target;
          view.setStyle(target);
        } else {
          transition.current = { from: currentStyle.current, to: target, start: performance.now() };
        }
        invalidate();
      },
    );
    // Keep selection rims a constant width on screen as the camera zooms.
    const stopFrame = subscribeViewFrame((frame) => view.setOutlineWidth(Math.max(0.012, frame.angstromPerPixel * OUTLINE_PX)));

    return () => {
      stopScene();
      stopHighlights();
      stopMode();
      stopFrame();
    };
  }, [view, quality, invalidate]);

  // Pointer and keyboard interaction.
  useEffect(() => {
    const element = gl.domElement.closest<HTMLElement>('.ml-viewport');
    const marquee = element?.querySelector<HTMLElement>('.ml-marquee');
    if (!element || !marquee) return;
    const controller = new InteractionController({
      element,
      marquee,
      view,
      ghost,
      getCamera: () => get().camera,
      getControls: () => get().controls as unknown as CameraControlsImpl | null,
      invalidate,
      onCommand: runCommand,
    });
    return controller.connect();
  }, [gl, get, invalidate, view, ghost]);

  // Representation changes ease from one style to the next.
  useFrame((state) => {
    const t = transition.current;
    if (!t) return;
    const progress = Math.min(1, (performance.now() - t.start) / TRANSITION_MS);
    const eased = progress * progress * (3 - 2 * progress);
    currentStyle.current = progress >= 1 ? t.to : lerpStyle(t.from, t.to, eased);
    view.setStyle(currentStyle.current);
    if (progress >= 1) transition.current = null;
    else state.invalidate();
  });

  return (
    <>
      <primitive object={view.object} />
      <primitive object={labels.object} />
      <primitive object={ghost.object} />
      <primitive object={compare.object} />
      <primitive object={fields.object} />
    </>
  );
}
