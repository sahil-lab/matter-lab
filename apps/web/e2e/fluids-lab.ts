import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

export interface DevState {
  scenario: string;
  deliveredMl: number;
  dripping: boolean;
  resetCounter: number;
  indicator: string;
  qualityTier: string;
  reducedMotion: boolean;
}

export interface PerfSnapshot {
  fps: number;
  frameMs: number;
  frameMsP95: number;
  cpuMs: number | null;
  gpuMs: number | null;
  gpuTimingAvailable: boolean;
  drawCalls: number;
  triangles: number;
  pixelRatio: number;
  idle: boolean;
  framesRendered: number;
}

/** Typed access to the standalone `lab/fluids` dev harness at `/fluids-lab.html` (see `dev/devApi.ts`). */
export class FluidsLab {
  readonly problems: string[] = [];

  constructor(readonly page: Page) {
    page.on('pageerror', (error) => this.problems.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') this.problems.push(`console: ${message.text()}`);
    });
  }

  async open(): Promise<void> {
    await this.page.goto('/fluids-lab.html');
    await this.ready();
  }

  async ready(): Promise<void> {
    await this.page.waitForFunction(() => !!(window as unknown as { __FLUIDS_LAB__?: unknown }).__FLUIDS_LAB__);
    await this.page.waitForSelector('canvas');
    await this.settle();
  }

  async settle(ms = 300): Promise<void> {
    await this.page.waitForTimeout(ms);
  }

  eval<T>(body: string): Promise<T> {
    return this.page.evaluate(`(() => { const lab = window.__FLUIDS_LAB__; ${body} })()`) as Promise<T>;
  }

  state(): Promise<DevState> {
    return this.eval('const s = lab.getState(); return { scenario: s.scenario, deliveredMl: s.deliveredMl, dripping: s.dripping, resetCounter: s.resetCounter, indicator: s.indicator, qualityTier: s.qualityTier, reducedMotion: s.reducedMotion };');
  }

  async setScenario(id: string): Promise<void> {
    await this.eval(`lab.setScenario(${JSON.stringify(id)});`);
    await this.settle(250);
  }

  async setDeliveredMl(ml: number): Promise<void> {
    await this.eval(`lab.setDeliveredMl(${ml});`);
    await this.settle();
  }

  async setDripping(active: boolean): Promise<void> {
    await this.eval(`lab.setDripping(${active});`);
  }

  async reset(): Promise<void> {
    await this.eval('lab.reset();');
    await this.settle();
  }

  activeDroplets(): Promise<number> {
    return this.eval('return lab.activeDroplets();');
  }

  buretteReadingML(): Promise<number | null> {
    return this.eval('return lab.buretteReadingML();');
  }

  perfSnapshot(): Promise<PerfSnapshot> {
    return this.eval('return lab.perfSnapshot();');
  }

  async resetPerf(): Promise<void> {
    await this.eval('lab.resetPerf();');
  }

  projectWorldPoint(point: readonly [number, number, number]): Promise<[number, number] | null> {
    return this.eval(`return lab.projectWorldPoint(${JSON.stringify(point)});`);
  }

  /** Average RGB of a small square of real rendered pixels around a CSS-pixel point, read back via `drawImage` from the live WebGL canvas (so it reflects what was actually drawn, not a DOM/material property). */
  async pixelColorAt(x: number, y: number, size = 6): Promise<[number, number, number]> {
    return this.page.evaluate(
      ([x, y, size]) => {
        const canvas = document.querySelector('canvas') as HTMLCanvasElement;
        const off = document.createElement('canvas');
        off.width = canvas.width;
        off.height = canvas.height;
        const ctx = off.getContext('2d')!;
        ctx.drawImage(canvas, 0, 0);
        const scaleX = canvas.width / canvas.clientWidth;
        const scaleY = canvas.height / canvas.clientHeight;
        const px = Math.round(x * scaleX);
        const py = Math.round(y * scaleY);
        const half = Math.max(1, Math.round((size * scaleX) / 2));
        const data = ctx.getImageData(Math.max(0, px - half), Math.max(0, py - half), half * 2, half * 2).data;
        let r = 0;
        let g = 0;
        let b = 0;
        const n = data.length / 4;
        for (let i = 0; i < data.length; i += 4) {
          r += data[i]!;
          g += data[i + 1]!;
          b += data[i + 2]!;
        }
        return [r / n, g / n, b / n] as [number, number, number];
      },
      [x, y, size] as [number, number, number],
    );
  }

  /** Fails if the page logged errors (shader compile failures, uncaught exceptions, ...). */
  expectNoProblems(allow: readonly RegExp[] = []): void {
    expect(
      this.problems.filter((problem) => !allow.some((pattern) => pattern.test(problem))),
      'the page logged errors',
    ).toEqual([]);
  }
}
