import type { WebGLRenderer } from 'three';

export interface PerfSnapshot {
  /** Frames per second over the recent run of consecutive frames; 0 while the view is idle. */
  readonly fps: number;
  readonly frameMs: number;
  readonly frameMsP95: number;
  /** Main-thread time spent updating and submitting a frame (median of recent frames), or `null` before any frame has been measured. */
  readonly cpuMs: number | null;
  /** GPU time per frame (median of recent frames); `null` when the browser does not expose timer queries or nothing has been measured yet. */
  readonly gpuMs: number | null;
  /** False when the browser does not expose GPU timer queries at all. */
  readonly gpuTimingAvailable: boolean;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly geometries: number;
  readonly textures: number;
  readonly programs: number;
  readonly pixelRatio: number;
  readonly heapMb: number | null;
  /** True when no frame has been drawn recently (the view only renders when something changes). */
  readonly idle: boolean;
  readonly framesRendered: number;
}

const WINDOW = 120;
/** A gap longer than this between frames means the view went idle, not that a frame was slow. */
const IDLE_GAP_MS = 250;
/** Frames right after a graphics context is created compile shaders; they are not measured. */
const WARMUP_FRAMES = 6;

interface TimerExtension {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

/**
 * Built-in performance instrumentation. Call `begin` before anything is drawn in a frame and `end`
 * after everything is; the monitor then reports frame pacing, CPU and (where available) GPU time,
 * and renderer workload.
 */
export class PerfMonitor {
  private readonly intervals: number[] = [];
  private readonly cpuTimes: number[] = [];
  private readonly gpuTimes: number[] = [];
  private lastFrameAt = 0;
  private frameStart = 0;
  private frames = 0;
  private warmup = 0;
  private workload = { drawCalls: 0, triangles: 0, geometries: 0, textures: 0, programs: 0, pixelRatio: 1 };

  private timer: TimerExtension | null | undefined;
  private activeQuery: WebGLQuery | null = null;
  private readonly pendingQueries: WebGLQuery[] = [];
  private timerContext: WebGL2RenderingContext | null = null;

  private timerFor(gl: WebGL2RenderingContext): TimerExtension | null {
    if (this.timerContext !== gl) {
      this.timerContext = gl;
      this.timer = undefined;
      this.activeQuery = null;
      this.pendingQueries.length = 0;
      this.warmup = WARMUP_FRAMES;
      this.reset();
    }
    if (this.timer === undefined) {
      this.timer = typeof gl.createQuery === 'function' ? (gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExtension | null) : null;
    }
    return this.timer;
  }

  get gpuTimingAvailable(): boolean {
    return !!this.timer;
  }

  begin(renderer: WebGLRenderer): void {
    renderer.info.reset();
    this.frameStart = performance.now();
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const timer = this.timerFor(gl);
    if (!timer) return;

    // Collect finished queries from earlier frames.
    while (this.pendingQueries.length > 0) {
      const query = this.pendingQueries[0]!;
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;
      this.pendingQueries.shift();
      const disjoint = gl.getParameter(timer.GPU_DISJOINT_EXT) as boolean;
      if (!disjoint) push(this.gpuTimes, (gl.getQueryParameter(query, gl.QUERY_RESULT) as number) / 1e6);
      gl.deleteQuery(query);
    }
    if (this.warmup === 0 && this.pendingQueries.length < 6) {
      this.activeQuery = gl.createQuery();
      if (this.activeQuery) gl.beginQuery(timer.TIME_ELAPSED_EXT, this.activeQuery);
    }
  }

  end(renderer: WebGLRenderer): void {
    const now = performance.now();
    if (this.activeQuery && this.timer) {
      const gl = renderer.getContext() as WebGL2RenderingContext;
      gl.endQuery(this.timer.TIME_ELAPSED_EXT);
      this.pendingQueries.push(this.activeQuery);
      this.activeQuery = null;
    }
    if (this.warmup > 0) this.warmup--;
    else push(this.cpuTimes, now - this.frameStart);
    if (this.lastFrameAt > 0) {
      const gap = now - this.lastFrameAt;
      if (gap < IDLE_GAP_MS) push(this.intervals, gap);
      else this.intervals.length = 0;
    }
    this.lastFrameAt = now;
    this.frames++;
    const info = renderer.info;
    this.workload = {
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs?.length ?? 0,
      pixelRatio: renderer.getPixelRatio(),
    };
  }

  /** Mean interval between recent consecutive frames in milliseconds, or 0 if there are too few. */
  recentFrameMs(): number {
    return this.intervals.length >= 8 ? mean(this.intervals) : 0;
  }

  /** Forgets pacing history, e.g. before a benchmark run. */
  reset(): void {
    this.intervals.length = 0;
    this.cpuTimes.length = 0;
    this.gpuTimes.length = 0;
  }

  snapshot(): PerfSnapshot {
    const idle = performance.now() - this.lastFrameAt > IDLE_GAP_MS * 2 || this.intervals.length < 2;
    const frameMs = this.intervals.length > 0 ? mean(this.intervals) : 0;
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    return {
      fps: !idle && frameMs > 0 ? 1000 / frameMs : 0,
      frameMs,
      frameMsP95: percentile(this.intervals, 0.95),
      // Medians, so one slow frame (shader compilation after a change) does not distort the figure.
      cpuMs: this.cpuTimes.length > 0 ? percentile(this.cpuTimes, 0.5) : null,
      gpuMs: this.timer && this.gpuTimes.length > 0 ? percentile(this.gpuTimes, 0.5) : null,
      gpuTimingAvailable: !!this.timer,
      ...this.workload,
      heapMb: memory ? memory.usedJSHeapSize / 1048576 : null,
      idle,
      framesRendered: this.frames,
    };
  }
}

function push(buffer: number[], value: number): void {
  buffer.push(value);
  if (buffer.length > WINDOW) buffer.shift();
}

function mean(values: readonly number[]): number {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

export const perfMonitor = new PerfMonitor();
