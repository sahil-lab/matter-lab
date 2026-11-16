import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

export interface Summary {
  formula: string;
  atoms: number;
  bonds: number;
  selectedAtoms: number[];
  selectedBonds: number[];
  errors: number;
  warnings: number;
  undo: number;
  redo: number;
  tool: string;
}

export interface AtomRow {
  id: number;
  z: number;
  n: number | null;
  e: number;
  position: [number, number, number];
}

/** Typed access to the test hook the app installs in development builds. */
export class Lab {
  /** Messages logged at error level or thrown by the page, collected for the "no errors" assertions. */
  readonly problems: string[] = [];

  constructor(readonly page: Page) {
    page.on('pageerror', (error) => this.problems.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') this.problems.push(`console: ${message.text()}`);
    });
  }

  /** Opens the app with empty storage, so every test starts from the same state. */
  async open(): Promise<void> {
    await this.page.goto('/');
    await this.page.evaluate(async () => {
      localStorage.clear();
      await new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase('matterlab');
        request.onsuccess = request.onerror = request.onblocked = () => resolve();
      });
    });
    await this.page.reload();
    await this.ready();
  }

  async ready(): Promise<void> {
    await this.page.waitForFunction(() => {
      const api = (window as unknown as { __MATTERLAB__?: { device(): unknown; viewApi: { getPose(): unknown } } }).__MATTERLAB__;
      return !!api && !!api.device() && !!api.viewApi.getPose();
    });
    await this.settle();
  }

  /** Lets camera transitions and on-demand frames finish. */
  async settle(ms = 350): Promise<void> {
    await this.page.waitForTimeout(ms);
  }

  eval<T>(body: string): Promise<T> {
    return this.page.evaluate(`(() => { const lab = window.__MATTERLAB__; ${body} })()`) as Promise<T>;
  }

  summary(): Promise<Summary> {
    return this.eval('return lab.summary();');
  }

  atoms(): Promise<AtomRow[]> {
    return this.eval('return lab.atoms();');
  }

  async atom(id: number): Promise<AtomRow> {
    const atom = (await this.atoms()).find((a) => a.id === id);
    if (!atom) throw new Error(`atom ${id} not found`);
    return atom;
  }

  bonds(): Promise<Array<{ id: number; a: number; b: number; order: number }>> {
    return this.eval('return lab.bonds();');
  }

  pose(): Promise<string> {
    return this.eval('return JSON.stringify(lab.viewApi.getPose());');
  }

  async atomPoint(id: number): Promise<[number, number]> {
    const point = await this.eval<[number, number] | null>(`return lab.atomPoint(${id});`);
    if (!point) throw new Error(`atom ${id} is not on screen`);
    return point;
  }

  async bondPoint(id: number): Promise<[number, number]> {
    const point = await this.eval<[number, number] | null>(`return lab.bondPoint(${id});`);
    if (!point) throw new Error(`bond ${id} is not on screen`);
    return point;
  }

  hitTest(x: number, y: number): Promise<{ kind: 'atom' | 'bond'; id: number } | null> {
    return this.eval(`return lab.hitTest(${x}, ${y});`);
  }

  async openExample(id: string): Promise<void> {
    await this.eval(`lab.actions.openExample(${JSON.stringify(id)});`);
    await this.settle(500);
  }

  /** A real mouse drag in several steps, as a person would make it. */
  async drag(from: [number, number], to: [number, number], modifier?: 'Shift' | 'Alt'): Promise<void> {
    const { mouse, keyboard } = this.page;
    await mouse.move(from[0], from[1]);
    if (modifier) await keyboard.down(modifier);
    await mouse.down();
    await mouse.move((from[0] + to[0]) / 2, (from[1] + to[1]) / 2, { steps: 5 });
    await mouse.move(to[0], to[1], { steps: 5 });
    await mouse.up();
    if (modifier) await keyboard.up(modifier);
    await this.settle(200);
  }

  async click(at: [number, number], modifier?: 'Shift'): Promise<void> {
    if (modifier) await this.page.keyboard.down(modifier);
    await this.page.mouse.click(at[0], at[1]);
    if (modifier) await this.page.keyboard.up(modifier);
    await this.settle(150);
  }

  /** A point in the 3D view where nothing is drawn. */
  async emptyPoint(): Promise<[number, number]> {
    for (const candidate of [[260, 660], [300, 200], [900, 700], [200, 400]] as Array<[number, number]>) {
      if ((await this.hitTest(candidate[0], candidate[1])) === null) return candidate;
    }
    throw new Error('no empty point found in the view');
  }

  /** Fails if the page logged errors. `allow` names messages a test expects, such as a network error it provoked. */
  expectNoProblems(allow: readonly RegExp[] = []): void {
    expect(
      this.problems.filter((problem) => !allow.some((pattern) => pattern.test(problem))),
      'the page logged errors',
    ).toEqual([]);
  }
}

export function distance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
}
