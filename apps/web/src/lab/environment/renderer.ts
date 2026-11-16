import { ACESFilmicToneMapping, SRGBColorSpace, WebGLRenderer } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import type { LabRendererBackend, LabRendererPreference, LabRendererStatus } from './types';

export type LabRenderer = WebGLRenderer | WebGPURenderer;
export interface RendererCandidate {
  readonly isWebGLRenderer?: boolean;
  readonly isWebGPURenderer?: boolean;
  readonly backend?: unknown;
  init?(): Promise<unknown>;
  dispose(): void | Promise<void>;
}
export interface RendererAttempt {
  readonly generation: number;
  readonly preference: LabRendererPreference;
  readonly fallbackReason?: string;
}

export function rendererErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return typeof error === 'string' ? error : 'The graphics renderer could not initialize.';
}

export function rendererBackend(renderer: RendererCandidate): LabRendererBackend {
  if (renderer.isWebGLRenderer) return 'webgl2';
  const backend = renderer.backend;
  if (backend && typeof backend === 'object') {
    if ('isWebGPUBackend' in backend && backend.isWebGPUBackend === true) return 'webgpu';
    if ('isWebGLBackend' in backend && backend.isWebGLBackend === true) return 'webgl2';
  }
  throw new Error('Renderer did not expose an initialized, supported graphics backend.');
}

export function nextRendererAttempt(attempt: RendererAttempt, error: unknown): RendererAttempt | null {
  if (attempt.preference === 'webgl2') return null;
  return {
    generation: attempt.generation + 1, preference: 'webgl2',
    fallbackReason: rendererErrorMessage(error),
  };
}

/** Injectable initialization permits deterministic failure-path tests without opening a GPU context. */
export async function initializeLabRenderer<T extends RendererCandidate>(
  preference: LabRendererPreference,
  webGpuAvailable: boolean,
  factories: { webgl2(): T | Promise<T>; webgpu(): T | Promise<T> },
): Promise<{ renderer: T; status: LabRendererStatus }> {
  const modern = preference !== 'webgl2' && webGpuAvailable;
  let renderer: T | undefined;
  try {
    renderer = await (modern ? factories.webgpu() : factories.webgl2());
    await renderer.init?.();
    const backend = rendererBackend(renderer);
    return {
      renderer,
      status: {
        phase: 'ready', preference, backend,
        implementation: renderer.isWebGPURenderer ? 'three-webgpu' : 'three-webgl',
        ...(preference !== 'webgl2' && backend === 'webgl2'
          ? { reason: webGpuAvailable ? 'Three.js selected its WebGL2 fallback backend.' : 'WebGPU is unavailable; using WebGL2.' }
          : {}),
      },
    };
  } catch (error) {
    // A GPU context may already own this canvas. Retry MUST remount a fresh canvas, not reuse it.
    try { await renderer?.dispose(); } catch { /* Failed partial initialization may not support disposal. */ }
    throw error;
  }
}

export async function createLabRenderer(options: {
  canvas: HTMLCanvasElement;
  preference: LabRendererPreference;
  antialias: boolean;
}): Promise<{ renderer: LabRenderer; status: LabRendererStatus }> {
  const { canvas, preference, antialias } = options;
  const result = await initializeLabRenderer<LabRenderer>(
    preference, typeof navigator !== 'undefined' && 'gpu' in navigator && navigator.gpu !== undefined,
    {
      webgl2() {
        const context = canvas.getContext('webgl2', { alpha: false, antialias, depth: true, stencil: false });
        if (!context) throw new Error('WebGL2 is unavailable. The apparatus list and numeric editor remain usable.');
        return new WebGLRenderer({ canvas, context, alpha: false, antialias });
      },
      async webgpu() {
        // Loaded only when requested and the browser exposes WebGPU.
        const { WebGPURenderer: Renderer } = await import('three/webgpu');
        return new Renderer({ canvas, alpha: false, antialias });
      },
    },
  );
  result.renderer.outputColorSpace = SRGBColorSpace;
  result.renderer.toneMapping = ACESFilmicToneMapping;
  result.renderer.toneMappingExposure = 1;
  return result;
}

/** R3F 9.8 still types RootState.gl as WebGLRenderer, although its factory supports async renderers. */
export function isModernLabRenderer(renderer: unknown): renderer is WebGPURenderer {
  return !!renderer && typeof renderer === 'object' &&
    'isWebGPURenderer' in renderer && renderer.isWebGPURenderer === true;
}
