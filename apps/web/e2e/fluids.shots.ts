import { fileURLToPath } from 'node:url';
import { test } from '@playwright/test';
import { FluidsLab } from './fluids-lab';

/**
 * Real running screenshots of the lab/fluids regression harness (not pre-rendered concept art),
 * for Agent 05's "supply real running screenshots" acceptance test. Run with
 * `npx playwright test -c playwright.shots.config.ts e2e/fluids.shots.ts`; kept out of the normal
 * `npm run screenshots` run for the main application (that script targets `e2e/*.shots.ts`
 * broadly, so this file participates in it once wired to the same base URL as the rest).
 */

const OUT = fileURLToPath(new URL('../../../docs/screenshots/fluids/', import.meta.url));

let lab: FluidsLab;

test.beforeEach(async ({ page }) => {
  lab = new FluidsLab(page);
  await lab.open();
});

async function shot(name: string): Promise<void> {
  await lab.settle(500);
  await lab.page.screenshot({ path: `${OUT}${name}.png` });
}

test('regression scenario gallery', async () => {
  await lab.setScenario('clear-liquid');
  await shot('01-clear-liquid');

  await lab.setScenario('tinted-liquid');
  await shot('02-tinted-liquid');

  await lab.setScenario('burette-levels');
  await shot('03-burette-levels-full-half-near-empty');

  // Rotate to check transparency/depth-sorting legibility from a second viewpoint.
  const box = await lab.page.locator('canvas').boundingBox();
  if (box) {
    await lab.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await lab.page.mouse.down();
    await lab.page.mouse.move(box.x + box.width / 2 + 220, box.y + box.height / 2 - 40, { steps: 12 });
    await lab.page.mouse.up();
  }
  await shot('04-burette-levels-rotated');

  await lab.setScenario('swirling');
  await shot('05-swirling');
});

test('endpoint titration: meniscus, readout and chemistry-driven indicator color', async () => {
  await lab.setScenario('endpoint-titration');
  await lab.reset();

  await lab.setDeliveredMl(10);
  await shot('06-endpoint-10ml-delivered');

  await lab.setDeliveredMl(24.9);
  await shot('07-endpoint-just-before-equivalence');

  await lab.setDeliveredMl(25.5);
  await shot('08-endpoint-just-after-equivalence');

  await lab.reset();
  await lab.setDripping(true);
  await lab.page.waitForTimeout(500);
  await shot('09-endpoint-dripping');
  await lab.setDripping(false);
});

test('quality tiers: transmission vs. the alpha-blended low-power fallback', async () => {
  await lab.setScenario('endpoint-titration');
  await lab.setDeliveredMl(15);

  await lab.eval("lab.getState().setQualityTier('quality');");
  await shot('10-quality-tier-full-transmission');

  await lab.eval("lab.getState().setQualityTier('efficient');");
  await shot('11-quality-tier-efficient-fallback');
});
