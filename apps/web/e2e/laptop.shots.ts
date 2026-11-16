import { fileURLToPath } from 'node:url';
import { test } from '@playwright/test';
import { Lab } from './lab';

/**
 * The same scenes as the gallery, at the window sizes of small laptops, where space is tightest:
 * the review of spacing, wrapping and overlap is done on these.
 */
const OUT = fileURLToPath(new URL('../../../docs/screenshots/', import.meta.url));

const SIZES = [
  { name: '1280x720', width: 1280, height: 720 },
  { name: '1366x768', width: 1366, height: 768 },
] as const;

for (const size of SIZES) {
  test.describe(`laptop ${size.name}`, () => {
    test.use({ viewport: { width: size.width, height: size.height } });
    let lab: Lab;

    test.beforeEach(async ({ page }) => {
      lab = new Lab(page);
      await lab.open();
    });

    async function shot(name: string): Promise<void> {
      await lab.settle(900);
      await lab.page.screenshot({ path: `${OUT}laptop-${size.name}-${name}.png` });
    }

    async function quantumIdle(): Promise<void> {
      await lab.settle(150);
      await lab.page.waitForFunction(
        () => {
          const s = (window as unknown as { __MATTERLAB__: { quantum: { useQuantum: { getState(): Record<string, unknown> } } } }).__MATTERLAB__.quantum.useQuantum.getState();
          return !s.running && !s.fieldBusy && !s.sliceBusy && !s.molecularBusy;
        },
        undefined,
        { timeout: 120_000 },
      );
    }

    test('architect', async () => {
      await lab.eval('lab.actions.selectOnly([2]);');
      await shot('architect-atom');
      await lab.eval("lab.actions.selectOnly([]); lab.lab.set({ inspectorTab: 'explain', showPerf: true });");
      await shot('architect-explain');
    });

    test('architect with computed fields', async () => {
      await lab.openExample('water');
      await lab.eval("lab.lab.set({ inspectorTab: 'compute' }); return lab.quantum.runQuantum();");
      await quantumIdle();
      await shot('quantum-orbital');
      await lab.eval("lab.quantum.setField({ kind: 'potential' }); lab.quantum.setSlice({ enabled: true, field: 'density' }); lab.quantum.setMolecular({ enabled: true });");
      await quantumIdle();
      await shot('quantum-everything');
    });

    test('reaction laboratory', async () => {
      await lab.eval("lab.actions.enterWorkspace('reactions'); lab.reaction.loadPreset('no-o3-kinetics'); return lab.reaction.runDraft();");
      await lab.page.waitForFunction(() => {
        const s = (window as unknown as { __MATTERLAB__: { reaction: { useReaction: { getState(): { running: boolean; structuresLoading: boolean; result: unknown } } } } }).__MATTERLAB__.reaction.useReaction.getState();
        return !s.running && !s.structuresLoading && s.result !== null;
      });
      await shot('reactions-kinetics');
      await lab.eval("lab.reaction.setTab('graphs');");
      await shot('reactions-graphs');
    });
  });
}
