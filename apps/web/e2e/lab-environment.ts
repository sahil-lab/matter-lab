import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

export interface PoseRow {
  position: [number, number, number];
  target: [number, number, number];
  zoom: number;
  projection: 'perspective' | 'orthographic';
}

export interface StationSlotRow {
  id: string;
  name: string;
  index: number;
  position: [number, number, number];
  footprint: { widthM: number; depthM: number };
}

export interface PerfRow {
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
  framesRendered: number;
  idle: boolean;
}

/** Typed access to the test hook the lab-environment harness installs in development builds. */
export class LabEnvironmentPage {
  readonly problems: string[] = [];

  constructor(readonly page: Page) {
    page.on('pageerror', (error) => this.problems.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') this.problems.push(`console: ${message.text()}`);
    });
  }

  async open(): Promise<void> {
    await this.page.goto('/lab-environment.html');
    await this.ready();
  }

  async ready(): Promise<void> {
    await this.page.waitForFunction(() => {
      const api = (window as unknown as { __LAB_ENV__?: { camera: { getPose(): unknown } } }).__LAB_ENV__;
      return !!api && !!api.camera.getPose();
    });
    await this.settle();
  }

  /** Lets camera transitions and on-demand frames finish. */
  async settle(ms = 350): Promise<void> {
    await this.page.waitForTimeout(ms);
  }

  eval<T>(body: string): Promise<T> {
    return this.page.evaluate(`(() => { const lab = window.__LAB_ENV__; ${body} })()`) as Promise<T>;
  }

  pose(): Promise<PoseRow | null> {
    return this.eval('return lab.camera.getPose();');
  }

  mode(): Promise<string> {
    return this.eval('return lab.camera.getMode();');
  }

  stationSlots(): Promise<StationSlotRow[]> {
    return this.eval('return lab.stationSlots();');
  }

  perf(): Promise<PerfRow> {
    return this.eval('return lab.perf();');
  }

  environment(): Promise<Record<string, unknown>> {
    return this.eval('return lab.environment.get();');
  }

  setCameraMode(mode: string): Promise<void> {
    return this.eval(`lab.actions.setCameraMode(${JSON.stringify(mode)});`);
  }

  setEnvironmentMode(mode: string): Promise<void> {
    return this.eval(`lab.actions.setEnvironmentMode(${JSON.stringify(mode)});`);
  }

  setLightingPreset(id: string): Promise<void> {
    return this.eval(`lab.actions.setLightingPreset(${JSON.stringify(id)});`);
  }

  setQuality(id: string): Promise<void> {
    return this.eval(`lab.actions.setQuality(${JSON.stringify(id)});`);
  }

  addStation(): Promise<void> {
    return this.eval('lab.actions.addStation();');
  }

  fitAllStations(animate = false): Promise<void> {
    return this.eval(`lab.actions.fitAllStations(${animate});`);
  }

  focusActiveStation(animate = false): Promise<void> {
    return this.eval(`lab.actions.focusActiveStation(${animate});`);
  }

  pauseCamera(ownerId: string): Promise<void> {
    return this.eval(`lab.camera.pause(${JSON.stringify(ownerId)});`);
  }

  resumeCamera(ownerId: string): Promise<void> {
    return this.eval(`lab.camera.resume(${JSON.stringify(ownerId)});`);
  }

  isPaused(): Promise<boolean> {
    return this.eval('return lab.camera.isPaused();');
  }

  /** Fails if the page logged errors. `allow` names messages a test expects. */
  expectNoProblems(allow: readonly RegExp[] = []): void {
    expect(
      this.problems.filter((problem) => !allow.some((pattern) => pattern.test(problem))),
      'the page logged errors',
    ).toEqual([]);
  }
}
