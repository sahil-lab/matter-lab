import { describe, expect, it, vi } from 'vitest';
import { DataUtils } from 'three';
import { initializeLabRenderer, nextRendererAttempt } from './renderer';
import type { RendererCandidate } from './renderer';
import { adaptDpr, FrameMetricsWindow, readRendererCounters } from './qualityMath';
import { createProceduralEnvironment } from './proceduralEnvironment';

describe('renderer selection and bounded fallback (mocked, no GPU context)', () => {
  it.each(['auto', 'webgpu'] as const)('uses explicit WebGL2 when %s cannot access WebGPU', async (preference) => {
    const webgl = { isWebGLRenderer: true, dispose: vi.fn() };
    const factories = { webgl2: vi.fn(() => webgl), webgpu: vi.fn(() => webgl) };
    const result = await initializeLabRenderer(preference, false, factories);
    expect(result.status.backend).toBe('webgl2');
    expect(result.status.reason).toMatch(/unavailable/);
    expect(factories.webgpu).not.toHaveBeenCalled();
  });

  it('force-WebGL2 bypasses the adapter, and reports the actual native fallback backend rather than a WebGPU badge', async () => {
    const modern = { isWebGPURenderer: true, backend: { isWebGLBackend: true }, init: vi.fn(async () => {}), dispose: vi.fn() };
    const webgl = { isWebGLRenderer: true, dispose: vi.fn() };
    const factories = { webgl2: vi.fn(() => webgl), webgpu: vi.fn(() => modern) };
    const forced = await initializeLabRenderer<RendererCandidate>('webgl2', true, factories);
    expect(forced.status.implementation).toBe('three-webgl');
    expect(factories.webgpu).not.toHaveBeenCalled();
    const fallback = await initializeLabRenderer<RendererCandidate>('auto', true, factories);
    expect(modern.init).toHaveBeenCalledOnce();
    expect(fallback.status.backend).toBe('webgl2');
    expect(fallback.status.implementation).toBe('three-webgpu');
  });

  it('disposes failed GPU initialization and requires one fresh-canvas WebGL2 attempt, with no retry loop', async () => {
    const failure = new Error('adapter refused initialization');
    const modern = { isWebGPURenderer: true, init: vi.fn(async () => { throw failure; }), dispose: vi.fn(async () => {}) };
    const gl = { isWebGLRenderer: true, dispose: vi.fn() };
    const factories = { webgl2: vi.fn(() => gl), webgpu: vi.fn(() => modern) };
    await expect(initializeLabRenderer<RendererCandidate>('auto', true, factories)).rejects.toThrow(failure);
    expect(modern.dispose).toHaveBeenCalledOnce();
    expect(factories.webgl2).not.toHaveBeenCalled();
    const next = nextRendererAttempt({ preference: 'auto', generation: 8 }, failure)!;
    expect(next.generation).toBe(9);
    expect(next.preference).toBe('webgl2');
    expect((await initializeLabRenderer<RendererCandidate>(next.preference, true, factories)).status.backend).toBe('webgl2');
    expect(nextRendererAttempt(next, new Error('WebGL2 is also unavailable'))).toBeNull();
  });

  it('reports WebGPU only after init succeeds and refuses an unknown backend', async () => {
    const gpu = { isWebGPURenderer: true, backend: { isWebGPUBackend: true }, init: vi.fn(async () => {}), dispose: vi.fn() };
    const ready = await initializeLabRenderer('webgpu', true, { webgpu: () => gpu, webgl2: () => gpu });
    expect(ready.status.backend).toBe('webgpu');
    expect(gpu.init).toHaveBeenCalledOnce();
    const unknown = { init: vi.fn(async () => {}), dispose: vi.fn() };
    await expect(initializeLabRenderer('webgpu', true, { webgpu: () => unknown, webgl2: () => unknown })).rejects.toThrow(/backend/);
    expect(unknown.dispose).toHaveBeenCalledOnce();
  });
});

describe('honest frame metrics and quality policy', () => {
  it('adapts resolution only after sustained windows and remains within preset bounds', () => {
    let state = { dpr: 1.5, slowWindows: 0, fastWindows: 0 };
    state = adaptDpr(state, 30, [0.85, 1.5]);
    expect(state.dpr).toBe(1.5);
    state = adaptDpr(state, 30, [0.85, 1.5]);
    expect(state.dpr).toBe(1.35);
    for (let i = 0; i < 40; i += 1) state = adaptDpr(state, 40, [0.85, 1.5]);
    expect(state.dpr).toBe(0.85);
    for (let i = 0; i < 5; i += 1) state = adaptDpr(state, 10, [0.85, 1.5]);
    expect(state.dpr).toBe(0.85);
    state = adaptDpr(state, 10, [0.85, 1.5]);
    expect(state.dpr).toBe(0.95);
  });

  it('includes visible long frames, calculates measured percentiles, and resets between windows', () => {
    const window = new FrameMetricsWindow();
    for (let i = 0; i < 50; i += 1) expect(window.addFrame(0.016)).toBeNull();
    const result = window.addFrame(0.25)!;
    expect(result.sampleCount).toBe(51);
    expect(result.elapsedS).toBeCloseTo(1.05);
    expect(result.meanFrameMs).toBeCloseTo(1050 / 51);
    expect(result.p95FrameMs).toBe(16);
    expect(result.fps).toBeCloseTo(51 / 1.05);
    window.reset();
    expect(window.addFrame(0.016)).toBeNull();
  });

  it('distinguishes WebGL draw calls from modern renderer totals and never invents VRAM bytes', () => {
    expect(readRendererCounters({ render: { calls: 21, triangles: 800 }, memory: { geometries: 9, textures: 3 } }))
      .toMatchObject({ drawCalls: 21, gpuMemoryBytes: null });
    expect(readRendererCounters({
      render: { calls: 9876, drawCalls: 28, triangles: 1000 },
      memory: { geometries: 11, textures: 4, total: 102400 },
    })).toMatchObject({ drawCalls: 28, gpuMemoryBytes: 102400 });
  });

  it('generates a deterministic original HDR texture, including radiance above one without network assets', () => {
    const first = createProceduralEnvironment(128, 'daylight');
    const second = createProceduralEnvironment(128, 'daylight');
    try {
      const pixels = first.image.data as Uint16Array;
      expect(pixels).toEqual(second.image.data);
      const linear = Array.from(pixels, (value) => DataUtils.fromHalfFloat(value));
      expect(linear.every((value) => Number.isFinite(value) && value >= 0)).toBe(true);
      expect(Math.max(...linear)).toBeGreaterThan(1);
    } finally { first.dispose(); second.dispose(); }
  });
});
