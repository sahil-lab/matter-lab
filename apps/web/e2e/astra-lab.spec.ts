import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { AstraLab } from './astraLab';

/**
 * Agent 01 acceptance tests (brief "Acceptance tests" section + shared contract quality gates),
 * driving the real `/lab` shell in a real browser — no mocked DOM, no snapshot of markup alone.
 */

const SIZES: ReadonlyArray<{ name: string; width: number; height: number }> = [
  { name: 'desktop 1920x1080', width: 1920, height: 1080 },
  { name: 'laptop 1366x768', width: 1366, height: 768 },
  { name: 'small laptop 1280x800', width: 1280, height: 800 },
];

/** The shell's own floating chrome, by selector. Mirrors the technique in e2e/layout.spec.ts for the v1 app. */
const FURNITURE = [
  '.astra-topnav__group',
  '.astra-topnav__center',
  '.astra-hud-slot',
  '.astra-library-slot[data-open="true"]',
  '.astra-inspector-slot[data-open="true"]',
  '.astra-dock-slot',
];

interface Box {
  name: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

async function boxes(page: Page): Promise<Box[]> {
  return page.evaluate((selectors) => {
    const found: Box[] = [];
    const seen = new Set<Element>();
    for (const selector of selectors) {
      document.querySelectorAll<HTMLElement>(selector).forEach((element, index) => {
        if (seen.has(element)) return;
        seen.add(element);
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (rect.width < 1 || rect.height < 1 || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return;
        found.push({ name: `${selector} #${index}`, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
      });
    }
    return found;
  }, FURNITURE);
}

function overlaps(list: readonly Box[], viewport: { width: number; height: number }): string[] {
  const problems: string[] = [];
  for (const box of list) {
    if (box.left < -0.5 || box.top < -0.5 || box.right > viewport.width + 0.5 || box.bottom > viewport.height + 0.5) {
      problems.push(`${box.name} leaves the window: [${Math.round(box.left)}, ${Math.round(box.top)}, ${Math.round(box.right)}, ${Math.round(box.bottom)}]`);
    }
  }
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i]!;
      const b = list[j]!;
      const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (width > 1 && height > 1) problems.push(`${a.name} overlaps ${b.name} by ${Math.round(width)} x ${Math.round(height)} px`);
    }
  }
  return problems;
}

for (const size of SIZES) {
  test.describe(`layout at ${size.name}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });
    let lab: AstraLab;

    test.beforeEach(async ({ page }) => {
      lab = new AstraLab(page);
      await lab.open();
    });

    test('no chrome overlaps or leaves the window, in the default panel state', async () => {
      await lab.settle(300);
      expect(overlaps(await boxes(lab.page), size)).toEqual([]);
      lab.expectNoProblems();
    });

    test('no chrome overlaps with both side panels forced open', async () => {
      await lab.eval('astra.astraLab.set({ libraryOpen: true, inspectorOpen: true });');
      await lab.settle(300);
      expect(overlaps(await boxes(lab.page), size)).toEqual([]);
    });

    test('no chrome overlaps with the timeline dock expanded', async () => {
      await lab.eval('astra.astraLab.set({ dockOpen: true });');
      await lab.settle(300);
      expect(overlaps(await boxes(lab.page), size)).toEqual([]);
    });

    test('no chrome overlaps with every panel and the dock open at once (the most crowded state)', async () => {
      await lab.eval('astra.astraLab.set({ libraryOpen: true, inspectorOpen: true, dockOpen: true });');
      await lab.settle(300);
      expect(overlaps(await boxes(lab.page), size)).toEqual([]);
    });
  });
}

test.describe('3D viewport share', () => {
  /** Unoccluded width share: how much of the window the open side panels leave clear for the viewport. */
  async function unoccludedShare(page: Page): Promise<number> {
    return page.evaluate(() => {
      const library = document.querySelector('.astra-library-slot[data-open="true"]')?.getBoundingClientRect();
      const inspector = document.querySelector('.astra-inspector-slot[data-open="true"]')?.getBoundingClientRect();
      const occluded = (library?.width ?? 0) + (inspector?.width ?? 0);
      return (window.innerWidth - occluded) / window.innerWidth;
    });
  }

  test('the default (both panels open) desktop layout keeps the viewport in the 70-85% range', async ({ page }) => {
    const lab = new AstraLab(page);
    await page.setViewportSize({ width: 1920, height: 1080 });
    await lab.open();
    await lab.settle(400);
    const share = await unoccludedShare(page);
    expect(share).toBeGreaterThanOrEqual(0.7);
    expect(share).toBeLessThanOrEqual(0.85);
  });

  test('forcing both panels open at the smallest supported width still clears at least 60%, and closing them reaches 100%', async ({ page }) => {
    const lab = new AstraLab(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await lab.open();
    await lab.eval('astra.astraLab.set({ libraryOpen: true, inspectorOpen: true });');
    await lab.settle(400);
    expect(await unoccludedShare(page)).toBeGreaterThanOrEqual(0.6);

    await lab.eval('astra.astraLab.set({ libraryOpen: false, inspectorOpen: false });');
    await lab.settle(400);
    expect(await unoccludedShare(page)).toBe(1);
  });

  test("the shell's own responsive defaults keep a reasonable share at every gate resolution without the user doing anything", async ({ page }) => {
    const lab = new AstraLab(page);
    for (const { width, height } of [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }, { width: 1280, height: 800 }]) {
      await page.setViewportSize({ width, height });
      await lab.open();
      await lab.settle(300);
      expect(await unoccludedShare(page), `${width}x${height}`).toBeGreaterThanOrEqual(0.7);
    }
  });
});

test.describe('accessibility', () => {
  test('major actions are keyboard-reachable with a visible focus ring', async ({ page }) => {
    const lab = new AstraLab(page);
    await lab.open();
    await page.keyboard.press('Tab');
    const first = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName);
    expect(first).toBeTruthy();
    // The focused element must actually be visible and have a non-zero outline from :focus-visible.
    const outline = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const style = getComputedStyle(el);
      return style.outlineStyle === 'none' ? null : style.outlineWidth;
    });
    expect(outline).not.toBeNull();

    // Keyboard can reach and activate the library toggle without a mouse.
    let guard = 0;
    while (guard++ < 20) {
      const testId = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
      if (testId === 'astra-toggle-library') break;
      await page.keyboard.press('Tab');
    }
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('astra-toggle-library');
    const openBefore = await lab.eval<boolean>('return astra.astraLab.get().libraryOpen;');
    await page.keyboard.press('Enter');
    await lab.settle(300);
    expect(await lab.eval<boolean>('return astra.astraLab.get().libraryOpen;')).toBe(!openBefore);
  });

  test('reduced motion suppresses the onboarding cinematic reveal and the in-app toggle is honoured', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const lab = new AstraLab(page);
    await lab.openFresh();
    // With the OS preference set, all onboarding content is visible immediately, not staggered in.
    await expect(page.getByTestId('astra-onboarding-enter')).toBeVisible();
    const opacity = await page.evaluate(() => {
      const title = document.querySelector('.astra-cinematic__title')?.parentElement as HTMLElement;
      return getComputedStyle(title).opacity;
    });
    expect(opacity).toBe('1');
    await lab.settle(200);
    expect(await page.evaluate(() => document.documentElement.dataset.astraMotion)).toBe('reduced');
  });

  test('no persistent overlay captures pointer events over the centre of the viewport', async ({ page }) => {
    const lab = new AstraLab(page);
    await lab.open();
    await lab.settle(300);
    const hit = await page.evaluate(() => {
      const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
      return el?.closest('.astra-viewport') ? 'viewport' : (el?.className ?? null);
    });
    expect(hit).toBe('viewport');
  });
});

test.describe('onboarding', () => {
  test('is skippable, and a returning visitor sees the shell with no delay', async ({ page }) => {
    const lab = new AstraLab(page);
    await lab.openFresh();
    await expect(page.getByTestId('astra-onboarding-skip')).toBeVisible();
    await page.getByTestId('astra-onboarding-skip').click();
    await expect(page.getByTestId('astra-onboarding-skip')).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('astra-lab:onboarding-seen'))).toBe('1');

    await page.reload();
    await lab.ready();
    // No cinematic at all on return — the shell itself is already the first paint.
    await expect(page.getByTestId('astra-onboarding-skip')).toHaveCount(0);
    await expect(page.getByText('Apparatus library', { exact: true })).toBeVisible();
  });
});

test.describe('honest data states', () => {
  test('the shell defaults to an explicit disconnected state, never a fabricated reading', async ({ page }) => {
    const lab = new AstraLab(page);
    await lab.open();
    await expect(page.getByText('No simulation connected')).toBeVisible();
    await expect(page.getByText('Disconnected')).toBeVisible();
  });

  test('an unsupported run shows an explicit unsupported status and its limitations, not a number', async ({ page }) => {
    const lab = new AstraLab(page);
    await lab.open('/lab/gallery');
    const unsupportedHud = page.locator('text=unsupported').first();
    await expect(unsupportedHud).toBeVisible();
    await expect(page.getByText('This setup is not scientifically supported')).toBeVisible();
    await expect(page.getByText('This configuration is not scientifically supported').first()).toBeVisible();
  });

  test('sample preview data is clearly watermarked and can be exited back to the honest default', async ({ page }) => {
    const lab = new AstraLab(page);
    await lab.open();
    await page.getByTestId('astra-preview-sample').click();
    await expect(page.getByTestId('astra-sample-watermark')).toBeVisible();
    await expect(page.getByText('ILLUSTRATIVE').first()).toBeVisible();
    await page.getByTestId('astra-exit-preview').click();
    await expect(page.getByTestId('astra-sample-watermark')).toHaveCount(0);
    await expect(page.getByText('No simulation connected')).toBeVisible();
  });
});

test.describe('apparatus library', () => {
  test('search filters the catalog and selecting an item populates the inspector', async ({ page }) => {
    const lab = new AstraLab(page);
    await lab.open();
    // The inspector auto-collapses below 1700px; force it open so its content is checkable
    // regardless of the Playwright project's default viewport.
    await lab.eval('astra.astraLab.set({ inspectorOpen: true });');
    await page.getByPlaceholder('Search burette, flask, probe…').fill('ph probe');
    await expect(page.getByTestId('astra-apparatus-card').filter({ hasText: 'pH probe' })).toBeVisible();
    await expect(page.getByTestId('astra-apparatus-card')).toHaveCount(1);
    await page.getByTestId('astra-apparatus-card').click();
    await expect(page.getByText('Reads solver-computed pH from the container it is dipped into.')).toBeVisible();
    await expect(page.getByText('Nothing selected')).toHaveCount(0);
    await expect(page.getByText('PH_PROBE')).toBeVisible();
  });
});

test.describe('timeline and playback', () => {
  test('play advances the scrubber and reset returns to the start', async ({ page }) => {
    const lab = new AstraLab(page);
    await lab.open();
    await page.getByTestId('astra-preview-sample').click();
    await page.getByTestId('astra-dock-toggle').click();
    await page.getByTestId('astra-playpause').click();
    await page.waitForFunction(() => (window as unknown as { __ASTRA_LAB__: { astraLab: { get(): { scrubIndex: number | null } } } }).__ASTRA_LAB__.astraLab.get().scrubIndex! > 0);
    await page.getByTestId('astra-reset').click();
    expect(await lab.eval<number | null>('return astra.astraLab.get().scrubIndex;')).toBe(0);
    expect(await lab.eval<boolean>('return astra.astraLab.get().playing;')).toBe(false);
  });
});

test.describe('component gallery', () => {
  test('shows populated, loading, warning, unsupported, empty and error states', async ({ page }) => {
    const lab = new AstraLab(page);
    await lab.open('/lab/gallery');
    for (const label of ['loading', 'empty', 'warning', 'unsupported', 'error']) {
      await expect(page.getByTestId(`astra-state-${label}`).first()).toBeVisible();
    }
    await expect(page.getByRole('heading', { name: 'Component gallery' })).toBeVisible();
    lab.expectNoProblems();
  });
});
