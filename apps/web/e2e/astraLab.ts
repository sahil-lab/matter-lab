import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/** Typed access to the Astra lab's test hook (`window.__ASTRA_LAB__`, installed by `bootAstraLab.tsx`). */
export class AstraLab {
  readonly problems: string[] = [];

  constructor(readonly page: Page) {
    page.on('pageerror', (error) => this.problems.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') this.problems.push(`console: ${message.text()}`);
    });
  }

  /** Opens `/lab` with a clean session and onboarding already marked seen, so tests land straight on the shell. */
  async open(path = '/lab'): Promise<void> {
    await this.page.goto(path);
    await this.page.evaluate(() => {
      localStorage.setItem('astra-lab:onboarding-seen', '1');
    });
    await this.page.reload();
    await this.ready();
  }

  /** Opens `/lab` with no stored preferences at all, so the first-run onboarding cinematic shows. */
  async openFresh(path = '/lab'): Promise<void> {
    await this.page.goto(path);
    await this.page.evaluate(() => localStorage.clear());
    await this.page.reload();
    await this.ready();
  }

  async ready(): Promise<void> {
    await this.page.waitForFunction(() => Boolean((window as unknown as { __ASTRA_LAB__?: unknown }).__ASTRA_LAB__));
  }

  eval<T>(body: string): Promise<T> {
    return this.page.evaluate(`(() => { const astra = window.__ASTRA_LAB__; ${body} })()`) as Promise<T>;
  }

  async settle(ms = 250): Promise<void> {
    await this.page.waitForTimeout(ms);
  }

  async skipOnboardingIfShown(): Promise<void> {
    const skip = this.page.getByTestId('astra-onboarding-skip');
    if (await skip.count()) await skip.click();
  }

  /** Fails if the page logged errors. `allow` names messages a test expects. */
  expectNoProblems(allow: readonly RegExp[] = []): void {
    expect(this.problems.filter((p) => !allow.some((pattern) => pattern.test(p))), 'the page logged errors').toEqual([]);
  }
}
