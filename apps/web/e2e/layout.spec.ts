import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { Lab } from './lab';

/**
 * No control may cover another, at any of the window sizes people actually use. The check is
 * geometric: every piece of interface furniture is measured in the running app and every pair is
 * tested for intersection.
 */

const SIZES: ReadonlyArray<{ name: string; width: number; height: number }> = [
  { name: 'small laptop 1280x720', width: 1280, height: 720 },
  { name: 'laptop 1366x768', width: 1366, height: 768 },
  { name: 'laptop 1440x900', width: 1440, height: 900 },
  { name: 'laptop 1536x864', width: 1536, height: 864 },
  { name: 'desktop 1920x1080', width: 1920, height: 1080 },
];

/** The pieces of furniture, by selector. Each matched element is one box. */
const FURNITURE = [
  '.ml-top > .ml-panel',
  '.ml-top__center > *',
  '.ml-stage-info > *',
  '.ml-left > .ml-panel',
  '.ml-sidepanel',
  '.ml-inspector',
  '.ml-gizmo',
  '.ml-bottom__side > *',
  '.ml-bottom__center > *',
  '.ml-perf',
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
    // An element matched by two selectors is still one box.
    const seen = new Set<Element>();
    for (const selector of selectors) {
      document.querySelectorAll<HTMLElement>(selector).forEach((element, index) => {
        if (seen.has(element)) return;
        seen.add(element);
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (rect.width < 1 || rect.height < 1 || style.display === 'none' || style.visibility === 'hidden') return;
        const label = element.getAttribute('data-testid') ?? element.getAttribute('aria-label') ?? (element.textContent ?? '').trim().slice(0, 24);
        found.push({ name: `${selector} #${index} (${label})`, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
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
      // Boxes may touch; they may not share area.
      if (width > 1 && height > 1) problems.push(`${a.name} overlaps ${b.name} by ${Math.round(width)} x ${Math.round(height)} px`);
    }
  }
  return problems;
}

for (const size of SIZES) {
  test.describe(`layout at ${size.name}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });
    let lab: Lab;

    test.beforeEach(async ({ page }) => {
      lab = new Lab(page);
      await lab.open();
    });

    test('architect: no controls overlap in any tool', async ({ page }) => {
      await lab.eval('lab.lab.set({ showPerf: true });');
      for (const tool of ['select', 'build', 'erase', 'measure']) {
        await lab.eval(`lab.lab.set({ tool: '${tool}' }); lab.actions.selectOnly(${tool === 'select' ? '[1, 2, 3]' : '[]'});`);
        await lab.settle(250);
        expect(overlaps(await boxes(page), size), `tool ${tool}`).toEqual([]);
      }
      // With the inspector closed the view bar and context bar still share the bottom row.
      await lab.eval("lab.lab.set({ inspectorOpen: false, tool: 'build' });");
      await lab.settle(250);
      expect(overlaps(await boxes(page), size), 'inspector closed').toEqual([]);
      // The read-out of a keyboard transform takes the place of the context bar.
      await lab.eval("lab.lab.set({ inspectorOpen: true, tool: 'select' }); lab.actions.selectOnly([1, 2, 3]);");
      // The gizmo glides out of the way of the reopened inspector; measure once it has arrived.
      await lab.settle(400);
      await page.mouse.move(size.width / 2 - 100, size.height / 2);
      await page.keyboard.press('g');
      await expect(page.getByTestId('transform-hud')).toBeVisible();
      expect(overlaps(await boxes(page), size), 'during a keyboard transform').toEqual([]);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('transform-hud')).toHaveCount(0);
    });

    test('dialogs: every dialog fits inside the window, with its header and its last line reachable', async ({ page }) => {
      await lab.eval('lab.actions.selectOnly([1]);');
      for (const dialog of ['periodic-table', 'library', 'export', 'shortcuts', 'nucleus']) {
        await lab.eval(`lab.lab.set({ dialog: '${dialog}' });`);
        await lab.settle(450);
        const frame = (await page.locator('.ml-dialog').boundingBox())!;
        expect(frame.x, dialog).toBeGreaterThanOrEqual(0);
        expect(frame.y, dialog).toBeGreaterThanOrEqual(0);
        expect(frame.x + frame.width, dialog).toBeLessThanOrEqual(size.width);
        expect(frame.y + frame.height, dialog).toBeLessThanOrEqual(size.height);
        // What does not fit scrolls inside the dialog instead of running off the screen.
        const body = (await page.locator('.ml-dialog__body').boundingBox())!;
        expect(body.y + body.height, dialog).toBeLessThanOrEqual(frame.y + frame.height + 0.5);
        const close = (await page.locator('.ml-dialog__head button').last().boundingBox())!;
        expect(close.y, dialog).toBeGreaterThanOrEqual(frame.y);
        expect(close.x + close.width, dialog).toBeLessThanOrEqual(frame.x + frame.width);
      }
      // The library keeps its place whichever of its sections is shown.
      await lab.eval("lab.lab.set({ dialog: 'library' });");
      await lab.settle(450);
      const tabs = page.getByRole('group', { name: 'Library section' });
      const at = (await tabs.boundingBox())!;
      for (const section of ['Find', 'Saved', 'Files', 'Examples']) {
        await tabs.getByRole('button', { name: section, exact: true }).click();
        await lab.settle(150);
        const now = (await tabs.boundingBox())!;
        expect([Math.round(now.x), Math.round(now.y)], section).toEqual([Math.round(at.x), Math.round(at.y)]);
      }
    });

    test('architect: the legends of computed fields overlap nothing and stay inside their panel', async ({ page }) => {
      await lab.openExample('water');
      await lab.eval("lab.lab.set({ showPerf: true, inspectorTab: 'compute' }); return lab.quantum.runQuantum();");
      const idle = () =>
        page.waitForFunction(() => {
          const s = (window as unknown as { __MATTERLAB__: { quantum: { useQuantum: { getState(): Record<string, unknown> } } } }).__MATTERLAB__.quantum.useQuantum.getState();
          return !s.running && !s.fieldBusy && !s.sliceBusy && !s.molecularBusy;
        });
      // The fullest legend there is: a mapped potential, a cutting plane and a molecular surface at once.
      await lab.eval("lab.quantum.setField({ kind: 'potential' }); lab.quantum.setSlice({ enabled: true, field: 'orbital' }); lab.quantum.setMolecular({ enabled: true });");
      await lab.settle(200);
      await idle();
      await expect(page.getByTestId('legend-field')).toBeVisible();
      await expect(page.getByTestId('legend-plane')).toBeVisible();
      await expect(page.getByTestId('legend-molecular')).toBeVisible();
      for (const inspectorOpen of [true, false]) {
        await lab.eval(`lab.lab.set({ inspectorOpen: ${inspectorOpen} });`);
        await lab.settle(400);
        expect(overlaps(await boxes(page), size), `inspector ${inspectorOpen ? 'open' : 'closed'}`).toEqual([]);
        // Nothing written in the legend may stick out of it.
        const spill = await page.evaluate(() => {
          const legend = document.querySelector('[data-testid="field-legend"]')!;
          const frame = legend.getBoundingClientRect();
          const out: string[] = [];
          legend.querySelectorAll<HTMLElement>('.ml-legend__row > *, .ml-legend__note, .ml-scalestrip__ticks b').forEach((element) => {
            const box = element.getBoundingClientRect();
            if (box.width === 0) return;
            if (box.left < frame.left - 0.5 || box.right > frame.right + 0.5 || box.top < frame.top - 0.5 || box.bottom > frame.bottom + 0.5) {
              out.push(`${(element.textContent ?? '').trim().slice(0, 30)}: [${Math.round(box.left)}, ${Math.round(box.right)}] outside [${Math.round(frame.left)}, ${Math.round(frame.right)}]`);
            }
          });
          return out;
        });
        expect(spill, `legend contents, inspector ${inspectorOpen ? 'open' : 'closed'}`).toEqual([]);
      }
    });

    test('discovery vault: no controls overlap on any tab', async ({ page }) => {
      await lab.openExample('aspirin');
      await lab.eval("lab.lab.set({ showPerf: true }); lab.actions.enterWorkspace('vault');");
      await expect(page.getByTestId('vault-side')).toBeVisible();
      // Before a candidate is chosen: the explainer on the right, no banner.
      await lab.settle(300);
      expect(overlaps(await boxes(page), size), 'no candidate selected').toEqual([]);
      await lab.eval("return lab.vault.addCandidate({ title: 'A candidate with a deliberately long title to see how the banner copes with it' });");
      await expect(page.getByTestId('vault-banner')).toBeVisible();
      for (const tab of ['status', 'searches', 'evidence']) {
        await lab.eval(`lab.vault.setVaultTab('${tab}');`);
        await lab.settle(300);
        expect(overlaps(await boxes(page), size), `tab ${tab}`).toEqual([]);
      }
      await lab.eval('lab.lab.set({ sidePanelOpen: false });');
      await lab.settle(300);
      expect(overlaps(await boxes(page), size), 'candidate list hidden').toEqual([]);
      await lab.eval('lab.lab.set({ inspectorOpen: false });');
      await lab.settle(400);
      expect(overlaps(await boxes(page), size), 'both panels hidden').toEqual([]);
    });

    test('reaction laboratory: no controls overlap, with and without a time course', async ({ page }) => {
      await lab.eval("lab.actions.enterWorkspace('reactions'); lab.lab.set({ showPerf: true });");
      for (const preset of ['no-o3-kinetics', 'methane-combustion', 'iron-oxidation-missing-data']) {
        await lab.eval(`lab.reaction.loadPreset('${preset}'); return lab.reaction.runDraft();`);
        await page.waitForFunction(() => {
          const s = (window as unknown as { __MATTERLAB__: { reaction: { useReaction: { getState(): { running: boolean; structuresLoading: boolean } } } } }).__MATTERLAB__.reaction.useReaction.getState();
          return !s.running && !s.structuresLoading;
        });
        await lab.settle(300);
        expect(overlaps(await boxes(page), size), preset).toEqual([]);
      }
      await lab.eval('lab.lab.set({ sidePanelOpen: false });');
      await lab.settle(300);
      expect(overlaps(await boxes(page), size), 'set-up hidden').toEqual([]);
      await lab.eval('lab.lab.set({ inspectorOpen: false });');
      await lab.settle(300);
      expect(overlaps(await boxes(page), size), 'both panels hidden').toEqual([]);
    });
  });
}
