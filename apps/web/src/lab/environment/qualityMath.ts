import type { SceneQualityPreset } from './types';

export interface SceneQualitySettings {
  readonly preset: SceneQualityPreset;
  readonly dpr: readonly [number, number];
  readonly shadowMapSize: 0 | 1024 | 2048;
  readonly environmentWidth: 128 | 256 | 512;
  readonly lodDistanceM: number;
  readonly antialias: boolean;
}
export const SCENE_QUALITY: Readonly<Record<SceneQualityPreset, SceneQualitySettings>> = {
  low: { preset: 'low', dpr: [0.75, 1], shadowMapSize: 0, environmentWidth: 128, lodDistanceM: 7, antialias: false },
  balanced: { preset: 'balanced', dpr: [0.85, 1.5], shadowMapSize: 1024, environmentWidth: 256, lodDistanceM: 11, antialias: true },
  high: { preset: 'high', dpr: [1, 2], shadowMapSize: 2048, environmentWidth: 512, lodDistanceM: 16, antialias: true },
};

export interface AdaptiveDprState { readonly dpr: number; readonly slowWindows: number; readonly fastWindows: number }
export function adaptDpr(
  state: AdaptiveDprState, meanFrameMs: number, range: readonly [number, number],
): AdaptiveDprState {
  const dpr = Math.max(range[0], Math.min(state.dpr, range[1]));
  if (!Number.isFinite(meanFrameMs) || meanFrameMs <= 0) return { ...state, dpr };
  const slowWindows = meanFrameMs > 23 ? state.slowWindows + 1 : 0;
  const fastWindows = meanFrameMs < 15 ? state.fastWindows + 1 : 0;
  if (slowWindows >= 2) return { dpr: Math.max(range[0], +(dpr - 0.15).toFixed(2)), slowWindows: 0, fastWindows: 0 };
  if (fastWindows >= 6) return { dpr: Math.min(range[1], +(dpr + 0.1).toFixed(2)), slowWindows: 0, fastWindows: 0 };
  return { dpr, slowWindows, fastWindows };
}

export class FrameMetricsWindow {
  private samples: number[] = [];
  private elapsedS = 0;

  reset(): void { this.samples.length = 0; this.elapsedS = 0; }

  addFrame(deltaS: number): {
    sampleCount: number; elapsedS: number; meanFrameMs: number; p95FrameMs: number; fps: number;
  } | null {
    if (!Number.isFinite(deltaS) || deltaS <= 0) return null;
    this.samples.push(deltaS * 1000);
    this.elapsedS += deltaS;
    if (this.elapsedS < 1 && this.samples.length < 1000) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const meanFrameMs = this.elapsedS * 1000 / sorted.length;
    const result = {
      sampleCount: sorted.length, elapsedS: this.elapsedS, meanFrameMs,
      p95FrameMs: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)], fps: 1000 / meanFrameMs,
    };
    this.reset();
    return result;
  }
}

export interface RendererInfoLike {
  readonly render?: { readonly calls?: number; readonly drawCalls?: number; readonly triangles?: number };
  readonly memory?: { readonly geometries?: number; readonly textures?: number; readonly total?: number };
}
export function readRendererCounters(info: RendererInfoLike) {
  return {
    drawCalls: info.render?.drawCalls ?? info.render?.calls ?? 0,
    triangles: info.render?.triangles ?? 0,
    geometries: info.memory?.geometries ?? 0,
    textures: info.memory?.textures ?? 0,
    gpuMemoryBytes: info.memory?.total ?? null,
  };
}
