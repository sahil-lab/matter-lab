/**
 * Hosts the editor inside an R3F `<Canvas>`: apparatus meshes, the placement ghost, a minimal
 * ground reference (a stand-in for Agent 02's `LabWorld`/`Workbench`), and the camera/gesture
 * wiring that keeps orbiting and editing mutually exclusive (brief item 6). `LabEditorCanvas` is
 * the whole mountable unit; `LabEditorContents` is what actually has to live inside the `<Canvas>`
 * and is exported separately so a future host (Agent 02's real environment) can embed it directly
 * instead of this file's own `<Canvas>`/lighting/orbit-controls stand-in.
 */
import { OrbitControls } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import type { Camera } from 'three';
import { GestureController } from '../GestureController';
import { labEditor, useLabEditor } from '../editorStore';
import { installKeyboardShortcuts } from '../keyboard';
import { ApparatusMesh } from './ApparatusMesh';
import { PlacementGhost } from './PlacementGhost';

export interface LabEditorContentsProps {
  readonly marqueeElement: HTMLElement;
  readonly onGesturesReady?: (gestures: GestureController) => void;
  /** Called once per rendered frame with the elapsed seconds, so a host can advance the (provisional) reducer's simulation clock without this module depending on it directly. */
  readonly onFrame?: (deltaS: number) => void;
  /** Exposes the live camera object (position/target), purely for diagnostics — e.g. the e2e suite's "the camera never moves while dragging apparatus" check. Nothing in this module reads it back. */
  readonly onCameraReady?: (camera: Camera) => void;
}

export function LabEditorContents({ marqueeElement, onGesturesReady, onFrame, onCameraReady }: LabEditorContentsProps): JSX.Element {
  const { camera, gl, invalidate } = useThree();
  // Select the Map itself (a stable reference between unrelated store updates, such as hover or
  // selection changes) and only derive the array when that reference actually changes - selecting
  // `[...map.values()]` directly would allocate a new array on every store notification, which
  // zustand's `useSyncExternalStore`-backed hook treats as "always different" and loops forever.
  const apparatusMap = useLabEditor((s) => s.scene.apparatus);
  const apparatus = useMemo(() => [...apparatusMap.values()], [apparatusMap]);
  const gestureActive = useLabEditor((s) => s.gesture.kind !== 'idle' && s.gesture.kind !== 'camera');
  const gestures = useMemo(() => new GestureController({ element: gl.domElement, marquee: marqueeElement, getCamera: () => camera, invalidate }), [camera, gl, invalidate, marqueeElement]);

  useEffect(() => gestures.connect(), [gestures]);
  useEffect(() => {
    onCameraReady?.(camera);
  }, [camera, onCameraReady]);
  useEffect(() => {
    onGesturesReady?.(gestures);
  }, [gestures, onGesturesReady]);

  useFrame((_, delta) => onFrame?.(delta));

  return (
    <>
      <ambientLight intensity={0.6} />
      <directionalLight position={[2, 4, 2]} intensity={1.1} castShadow />
      <OrbitControls enabled={!gestureActive} makeDefault enableDamping dampingFactor={0.12} target={[0, 0.2, 0]} />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.001, 0]} receiveShadow>
        <planeGeometry args={[6, 6]} />
        <meshStandardMaterial color="#141b28" />
      </mesh>
      <gridHelper args={[6, 24, '#2a3444', '#1d2531']} />
      {apparatus.map((instance) => (
        <ApparatusMesh key={instance.id} instance={instance} gestures={gestures} />
      ))}
      <PlacementGhost />
    </>
  );
}

export interface LabEditorCanvasProps {
  readonly onGesturesReady?: (gestures: GestureController) => void;
  readonly onFrame?: (deltaS: number) => void;
  readonly onCameraReady?: (camera: Camera) => void;
}

/** The whole mountable editor: canvas + camera + the marquee overlay div `GestureController` draws into. Installs keyboard shortcuts for as long as it is mounted. */
export function LabEditorCanvas({ onGesturesReady, onFrame, onCameraReady }: LabEditorCanvasProps): JSX.Element {
  // A ref's assignment does not itself trigger a re-render, and children need the real DOM node
  // (for GestureController's marquee overlay) before they can mount — state (set from a callback
  // ref) is what makes that second render happen once the div exists.
  const [marqueeElement, setMarqueeElement] = useState<HTMLDivElement | null>(null);

  useEffect(() => installKeyboardShortcuts(), []);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }} data-testid="lab-editor-viewport">
      <Canvas shadows camera={{ position: [1.1, 0.9, 1.3], fov: 45 }} onPointerMissed={() => labEditor.set({ selection: new Set() })}>
        {marqueeElement && <LabEditorContents marqueeElement={marqueeElement} onGesturesReady={onGesturesReady} onFrame={onFrame} onCameraReady={onCameraReady} />}
      </Canvas>
      <div
        ref={setMarqueeElement}
        data-testid="lab-editor-marquee"
        style={{ position: 'fixed', display: 'none', border: '1px solid #55e2d1', background: 'rgba(85,226,209,0.12)', pointerEvents: 'none', zIndex: 20 }}
      />
    </div>
  );
}
