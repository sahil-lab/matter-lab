import { Canvas } from '@react-three/fiber';
import { AgXToneMapping, NoToneMapping } from 'three';
import { notify } from '../state/actions';
import { useLab } from '../state/store';
import { Annotations } from './Annotations';
import { CameraRig } from './CameraRig';
import { Effects } from './Effects';
import { DirectRender, FrameEnd, FrameStart } from './FrameHooks';
import { QUALITY, detectDevice } from './quality';
import type { DeviceInfo } from './quality';
import { SceneLayer } from './SceneLayer';
import { Stage } from './Stage';

let device: DeviceInfo | null = null;

/** Facts about the graphics device, available once the canvas has been created. */
export function getDeviceInfo(): DeviceInfo | null {
  return device;
}

/**
 * Reports a lost graphics context. A canvas that has been replaced (for example after switching
 * render pipeline) has its context released on purpose, so only a canvas still on the page counts.
 */
function watchContext(canvas: HTMLCanvasElement): void {
  canvas.addEventListener('webglcontextlost', (event) => {
    if (!canvas.isConnected) return;
    event.preventDefault();
    notify('warning', 'The graphics context was lost', 'The browser is restoring it. Your work is safe.');
  });
  canvas.addEventListener('webglcontextrestored', () => {
    if (canvas.isConnected) notify('success', 'Graphics restored');
  });
}

/**
 * MatterRender's entry point: the full-bleed WebGL 2 canvas and everything drawn in it. The view
 * renders on demand (only when the camera, the scene or an animation changes), which keeps an idle
 * workspace from loading the GPU.
 */
export function MatterCanvas() {
  const qualityId = useLab((s) => s.quality);
  const ambientMotion = useLab((s) => s.ambientMotion);
  const quality = QUALITY[qualityId];
  const direct = quality.pipeline === 'direct';
  const toneMapping = direct ? AgXToneMapping : NoToneMapping;

  return (
    <div className="ml-viewport" data-testid="viewport">
      <Canvas
        // The two pipelines need different context settings, so switching between them recreates the canvas.
        key={quality.pipeline}
        frameloop={ambientMotion ? 'always' : 'demand'}
        dpr={Math.min(window.devicePixelRatio || 1, quality.dpr[1])}
        gl={{ antialias: direct, alpha: false, stencil: false, powerPreference: 'high-performance', toneMapping }}
        onCreated={({ gl }) => {
          device = detectDevice(gl.getContext());
          watchContext(gl.domElement);
        }}
      >
        <FrameStart toneMapping={toneMapping} />
        <CameraRig />
        <Stage quality={quality} drift={ambientMotion} />
        <SceneLayer quality={quality} />
        <Annotations />
        {direct ? <DirectRender /> : <Effects quality={quality} />}
        <FrameEnd quality={quality} />
      </Canvas>
      <div className="ml-marquee" />
    </div>
  );
}
