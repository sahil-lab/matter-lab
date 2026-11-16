import { Component, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ErrorInfo, ReactNode } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import type { CanvasProps } from '@react-three/fiber';
import { createLabCameraController } from './CameraController';
import type { LabCameraController } from './CameraController';
import { CameraDirector } from './CameraDirector';
import { LabCameraProvider, useCameraSnapshot, useReducedMotion } from './CameraModes';
import { DEFAULT_CAMERA_VIEW, fitCameraToBounds } from './cameraMath';
import { LabViewportControls } from './LabViewportControls';
import { SCENE_QUALITY } from './qualityMath';
import { SceneMetrics, SceneQualityProvider } from './SceneQuality';
import { createLabRenderer, isModernLabRenderer, nextRendererAttempt, rendererErrorMessage } from './renderer';
import type { RendererAttempt } from './renderer';
import type { LabBoundsM, LabFrameMetrics, LabRendererPreference, LabRendererStatus, SceneQualityPreset } from './types';
import './environment.css';

interface RendererBoundaryProps {
  readonly children?: ReactNode;
  readonly fallback?: ReactNode;
  readonly onError: (error: unknown) => void;
}
class RendererBoundary extends Component<RendererBoundaryProps, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override componentDidCatch(error: Error, _info: ErrorInfo) { this.props.onError(error); }
  override render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function RendererLifecycle({ onFailure }: { onFailure: (error: unknown) => void }) {
  const gl = useThree((state) => state.gl);
  const callback = useRef(onFailure);
  callback.current = onFailure;
  useEffect(() => {
    const canvas = gl.domElement;
    const onLost = (event: Event) => {
      event.preventDefault();
      callback.current(new Error('Graphics context lost. Switching to a fresh WebGL2 canvas.'));
    };
    canvas.addEventListener('webglcontextlost', onLost);
    let restore = () => {};
    if (isModernLabRenderer(gl)) {
      const priorLost = gl.onDeviceLost;
      const priorError = gl.onError;
      gl.onDeviceLost = (info) => callback.current(new Error(`Graphics device lost: ${info.message}`));
      gl.onError = (error: unknown) => callback.current(new Error(rendererErrorMessage(error)));
      restore = () => { gl.onDeviceLost = priorLost; gl.onError = priorError; };
    }
    return () => {
      canvas.removeEventListener('webglcontextlost', onLost);
      restore();
      // The installed R3F owns factory-created renderers and awaits their dispose() on root teardown.
    };
  }, [gl]);
  return null;
}

function CinematicEntry({ controller, enabled, storageKey }: {
  controller: LabCameraController; enabled: boolean; storageKey: string;
}) {
  useEffect(() => {
    if (!enabled) return;
    try { if (sessionStorage.getItem(storageKey) === 'seen') return; } catch { /* Storage can be disabled. */ }
    const first = controller.getSnapshot().stations[0];
    const destination = first
      ? fitCameraToBounds(first.boundsM, { mode: 'orbit', from: DEFAULT_CAMERA_VIEW, padding: 1.3 })
      : DEFAULT_CAMERA_VIEW;
    const wide = { ...destination, positionM: [4.8, 3.8, 5.2] as const };
    if (controller.startCinematic([wide, destination])) {
      try { sessionStorage.setItem(storageKey, 'seen'); } catch { /* Entry still works without persistence. */ }
    }
  }, [controller, enabled, storageKey]);
  return null;
}

function SkipEntry({ controller }: { controller: LabCameraController }) {
  const snapshot = useCameraSnapshot(controller);
  return snapshot.cinematic === 'playing'
    ? <button className="lab-environment-skip" type="button" onClick={() => controller.skipCinematic()}>Skip camera introduction</button>
    : null;
}

export interface LabCanvasProps {
  readonly children?: ReactNode;
  readonly cameraController?: LabCameraController;
  readonly quality?: SceneQualityPreset;
  readonly rendererPreference?: LabRendererPreference;
  readonly reducedMotion?: boolean;
  readonly adaptiveResolution?: boolean;
  readonly frameloop?: 'always' | 'demand';
  readonly navigationBoundsM?: LabBoundsM;
  readonly cinematicEntry?: boolean;
  readonly entryStorageKey?: string;
  readonly showControls?: boolean;
  readonly showRendererStatus?: boolean;
  readonly onRendererStatus?: (status: LabRendererStatus) => void;
  readonly onMetrics?: (metrics: LabFrameMetrics) => void;
  readonly onPointerMissed?: CanvasProps['onPointerMissed'];
  readonly fallback?: ReactNode;
  readonly overlay?: ReactNode;
  readonly className?: string;
  readonly style?: CSSProperties;
}

export function LabCanvas({
  children, cameraController, quality = 'balanced', rendererPreference = 'auto', reducedMotion,
  adaptiveResolution = true, frameloop = 'always', navigationBoundsM,
  cinematicEntry = false, entryStorageKey = 'matterlab.lab.entry.v1',
  showControls = false, showRendererStatus = true, onRendererStatus, onMetrics, onPointerMissed,
  fallback, overlay, className, style,
}: LabCanvasProps) {
  const [ownedController] = useState(() => createLabCameraController());
  const canvasOwner = useRef(Symbol('LabCanvas'));
  const controller = cameraController ?? ownedController;
  const reduced = useReducedMotion(reducedMotion);
  const [attempt, setAttempt] = useState<RendererAttempt>({ generation: 0, preference: rendererPreference });
  const [status, setStatus] = useState<LabRendererStatus>({
    phase: 'initializing', preference: rendererPreference, backend: null, implementation: null,
  });
  const statusCallback = useRef(onRendererStatus);
  statusCallback.current = onRendererStatus;
  const attemptRef = useRef(attempt);
  attemptRef.current = attempt;
  const mounted = useRef(true);
  const handledFailure = useRef(-1);
  const initialPreference = useRef(rendererPreference);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => { controller.setReducedMotion(reduced); }, [controller, reduced]);
  const report = useCallback((next: LabRendererStatus) => {
    if (!mounted.current) return;
    setStatus(next);
    statusCallback.current?.(next);
  }, []);
  useEffect(() => {
    if (initialPreference.current === rendererPreference) return;
    initialPreference.current = rendererPreference;
    handledFailure.current = -1;
    setAttempt((current) => ({ generation: current.generation + 1, preference: rendererPreference }));
    report({ phase: 'initializing', preference: rendererPreference, backend: null, implementation: null });
  }, [rendererPreference, report]);

  const onFailure = useCallback((error: unknown) => {
    const current = attempt;
    if (attemptRef.current.generation !== current.generation) return;
    if (handledFailure.current === current.generation || !mounted.current) return;
    handledFailure.current = current.generation;
    const next = nextRendererAttempt(current, error);
    if (next) {
      report({ phase: 'fallback', preference: rendererPreference, backend: null, implementation: null, reason: next.fallbackReason });
      setAttempt(next);
    } else {
      report({ phase: 'unavailable', preference: rendererPreference, backend: null, implementation: null, reason: rendererErrorMessage(error) });
    }
  }, [attempt, rendererPreference, report]);

  const rendererFactory = useCallback(
    async (defaults: { canvas: unknown }) => {
      if (!(defaults.canvas instanceof HTMLCanvasElement)) throw new Error('LabCanvas requires its own HTML canvas.');
      const result = await createLabRenderer({
        canvas: defaults.canvas, preference: attempt.preference, antialias: SCENE_QUALITY[quality].antialias,
      });
      if (attemptRef.current.generation === attempt.generation) {
        report({
          ...result.status, preference: rendererPreference,
          ...(attempt.fallbackReason ? { reason: attempt.fallbackReason } : {}),
        });
      }
      return result.renderer;
    }, [attempt, quality, rendererPreference, report],
  );
  const retry = () => {
    handledFailure.current = -1;
    setAttempt((current) => ({ ...current, generation: current.generation + 1 }));
    report({ phase: 'initializing', preference: rendererPreference, backend: null, implementation: null });
  };
  const unavailable = (
    <div className="lab-environment-fallback" role="alert">
      {fallback ?? <p>3D is unavailable. Use the apparatus list and numeric editor to continue.</p>}
      <button type="button" onClick={retry}>Retry 3D viewport</button>
    </div>
  );
  const rendererLabel = status.phase === 'ready'
    ? status.backend === 'webgpu' ? 'WebGPU · experimental' : status.reason ? 'WebGL2 fallback' : 'WebGL2'
    : status.phase === 'unavailable' ? '3D unavailable' : status.phase === 'fallback' ? 'Starting WebGL2 fallback…' : 'Starting 3D…';

  return (
    <LabCameraProvider controller={controller}>
      <SceneQualityProvider preset={quality}>
        <div
          className={`lab-environment${className ? ` ${className}` : ''}`} style={style}
          data-lab-units="m" data-lab-renderer-backend={status.backend ?? 'none'}
          data-lab-renderer-phase={status.phase} data-lab-renderer-implementation={status.implementation ?? 'none'}
          data-lab-renderer-fallback={Boolean(status.reason)} data-lab-quality={quality}
          data-lab-reduced-motion={reduced}
        >
          {status.phase === 'unavailable' ? unavailable : <RendererBoundary key={attempt.generation} onError={onFailure} fallback={unavailable}>
            <Suspense fallback={<div className="lab-environment-loading" role="status">Preparing laboratory…</div>}>
              <Canvas
                gl={rendererFactory} frameloop={frameloop}
                dpr={[SCENE_QUALITY[quality].dpr[0], SCENE_QUALITY[quality].dpr[1]]}
                camera={{ position: [...DEFAULT_CAMERA_VIEW.positionM], near: 0.005, far: 150, fov: 42 }}
                onPointerMissed={onPointerMissed} fallback={unavailable}
              >
                <CameraDirector controller={controller} navigationBoundsM={navigationBoundsM} canvasOwner={canvasOwner.current} />
                <RendererLifecycle onFailure={onFailure} />
                <SceneMetrics backend={status.backend ?? 'webgl2'} adaptive={adaptiveResolution} frameloop={frameloop} onMetrics={onMetrics} />
                {children}
                <CinematicEntry controller={controller} enabled={cinematicEntry} storageKey={entryStorageKey} />
              </Canvas>
            </Suspense>
          </RendererBoundary>}
          {showControls && <LabViewportControls controller={controller} />}
          <SkipEntry controller={controller} />
          {showRendererStatus && (
            <output className="lab-environment-status" aria-live="polite" title={status.reason}>
              <span>{rendererLabel}</span><span>m · tabletop 0.90 m</span>
            </output>
          )}
          {status.phase === 'unavailable' && <div className="lab-environment-error">{status.reason}</div>}
          {overlay}
        </div>
      </SceneQualityProvider>
    </LabCameraProvider>
  );
}
