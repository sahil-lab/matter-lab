import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

export interface ContainerState {
  readonly volumeL: number;
  readonly species: ReadonlyArray<{ speciesId: string; moles: number }>;
  readonly temperatureK: number;
}

export interface Observation {
  readonly type: string;
  readonly apparatusId?: string;
  readonly quantity: { value: number; unit: string };
  readonly evidence: string;
}

/** Typed access to the standalone lab editor exerciser (`/lab-editor.html`) and its `window.__MATTERLAB_LAB_EDITOR__` test hook. */
export class LabEditorPage {
  readonly problems: string[] = [];

  constructor(readonly page: Page) {
    page.on('pageerror', (error) => this.problems.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') this.problems.push(`console: ${message.text()}`);
    });
  }

  async open(): Promise<void> {
    await this.page.goto('/lab-editor.html');
    await this.page.evaluate(() => localStorage.clear());
    await this.page.reload();
    await this.ready();
  }

  async ready(): Promise<void> {
    await this.page.waitForFunction(() => {
      const api = (window as unknown as { __MATTERLAB_LAB_EDITOR__?: { ready(): boolean } }).__MATTERLAB_LAB_EDITOR__;
      return !!api && api.ready();
    });
  }

  eval<T>(body: string): Promise<T> {
    return this.page.evaluate(`(() => { const lab = window.__MATTERLAB_LAB_EDITOR__; ${body} })()`) as Promise<T>;
  }

  apparatusCount(): Promise<number> {
    return this.eval('return lab.labEditor.get().scene.apparatus.size;');
  }

  connectionCount(): Promise<number> {
    return this.eval('return lab.labEditor.get().scene.connections.size;');
  }

  selection(): Promise<string[]> {
    return this.eval('return [...lab.labEditor.get().selection];');
  }

  apparatusKinds(): Promise<string[]> {
    return this.eval('return [...lab.labEditor.get().scene.apparatus.values()].map((a) => a.kind);');
  }

  containerStates(): Promise<Record<string, ContainerState>> {
    return this.eval('return lab.actionSink.getContainerStates();');
  }

  observations(apparatusId: string): Promise<Observation[]> {
    return this.eval(`return lab.actionSink.getObservations(${JSON.stringify(apparatusId)});`);
  }

  lastPh(apparatusId: string): Promise<number | null> {
    return this.eval(`const o = lab.actionSink.getObservations(${JSON.stringify(apparatusId)}).filter((x) => x.type === 'PH').at(-1); return o ? o.quantity.value : null;`);
  }

  cameraPosition(): Promise<[number, number, number] | null> {
    return this.eval('return lab.cameraPosition();');
  }

  historyCounts(): Promise<{ past: number; future: number }> {
    return this.eval('const h = lab.labEditor.get().history; return { past: h.past.length, future: h.future.length };');
  }

  /** Arms placement by clicking a palette entry (the click-to-arm path; equally reachable via native drag-and-drop or a keyboard Enter on the focused button). */
  async armPlacement(definitionId: string): Promise<void> {
    await this.page.getByTestId(`palette-item-${definitionId}`).click({ force: true });
  }

  async canvasBox(): Promise<{ x: number; y: number; width: number; height: number }> {
    const box = await this.page.locator('canvas').boundingBox();
    if (!box) throw new Error('canvas not found');
    return box;
  }

  /** Clicks inside the 3D viewport at a fractional offset from its centre (±0.5 reaches the edges). */
  async clickViewport(dxFrac = 0, dyFrac = 0): Promise<void> {
    const box = await this.canvasBox();
    await this.page.mouse.click(box.x + box.width * (0.5 + dxFrac), box.y + box.height * (0.5 + dyFrac));
  }

  /** Moves the pointer (without clicking) so an armed placement's preview updates, without committing it. */
  async hoverViewport(dxFrac = 0, dyFrac = 0): Promise<void> {
    const box = await this.canvasBox();
    await this.page.mouse.move(box.x + box.width * (0.5 + dxFrac), box.y + box.height * (0.5 + dyFrac));
  }

  /** Arms and commits a placement in one step (click palette item, click viewport). */
  async place(definitionId: string, dxFrac = 0, dyFrac = 0): Promise<void> {
    await this.armPlacement(definitionId);
    await this.clickViewport(dxFrac, dyFrac);
  }

  /** `[dxFraction, dyFraction]` from the viewport centre for a world-space point — the exact pixels `clickViewport`/`hoverViewport` would need to land on it, computed from the live camera (not guessed). `null` if the point is behind the camera. */
  worldToViewportFraction(positionM: readonly [number, number, number]): Promise<[number, number] | null> {
    return this.eval(`return lab.worldToViewportFraction(${JSON.stringify(positionM)});`);
  }

  async dragInViewport(from: [number, number], to: [number, number]): Promise<void> {
    const box = await this.canvasBox();
    const abs = (f: [number, number]): [number, number] => [box.x + box.width * (0.5 + f[0]), box.y + box.height * (0.5 + f[1])];
    const [fx, fy] = abs(from);
    const [tx, ty] = abs(to);
    await this.page.mouse.move(fx, fy);
    await this.page.mouse.down();
    await this.page.mouse.move((fx + tx) / 2, (fy + ty) / 2, { steps: 5 });
    await this.page.mouse.move(tx, ty, { steps: 5 });
    await this.page.mouse.up();
  }

  async click(testId: string): Promise<void> {
    await this.page.getByTestId(testId).click({ force: true });
  }

  expectNoProblems(): void {
    expect(this.problems, 'the page logged errors').toEqual([]);
  }
}
