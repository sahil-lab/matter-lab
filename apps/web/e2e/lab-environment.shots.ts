import { fileURLToPath } from 'node:url';
import { test } from '@playwright/test';
import { LabEnvironmentPage } from './lab-environment';

/**
 * Documentation screenshots for Agent 02's 3D environment, run with
 * `npx playwright test -c playwright.lab-environment.config.ts lab-environment.shots.ts`
 * (kept out of the normal test run, like the main application's `*.shots.ts` files).
 */
const OUT = fileURLToPath(new URL('../../../docs/screenshots/lab-environment/', import.meta.url));

let lab: LabEnvironmentPage;

test.beforeEach(async ({ page }) => {
  lab = new LabEnvironmentPage(page);
  await lab.open();
});

async function shot(name: string): Promise<void> {
  await lab.page.evaluate(() => {
    const panel = document.querySelector('[data-testid="harness-panel"]');
    if (panel) (panel as HTMLElement).style.display = 'none';
  });
  await lab.settle(500);
  await lab.page.screenshot({ path: `${OUT}${name}.png` });
  await lab.page.evaluate(() => {
    const panel = document.querySelector('[data-testid="harness-panel"]');
    if (panel) (panel as HTMLElement).style.display = '';
  });
}

test('01 empty lab (room, no apparatus)', async () => {
  await lab.page.evaluate(() => {
    document.querySelector<HTMLInputElement>('[data-testid="toggle-apparatus"]')?.click();
  });
  await lab.focusActiveStation(false);
  await shot('01-empty-lab');
});

test('02 assembled titration station, close orbit', async () => {
  await lab.focusActiveStation(false);
  await shot('02-assembled-titration-station');
});

test('03 top-down station layout, three stations', async () => {
  await lab.addStation();
  await lab.addStation();
  await lab.fitAllStations(false);
  await lab.setCameraMode('top-down');
  await shot('03-top-down-station-layout');
});

test('04 close-up of glassware (inspect mode)', async () => {
  await lab.setCameraMode('inspect');
  await lab.eval('return lab.camera.focus({ center: [0.04, 1.05, 0.07], radiusM: 0.28 }, false);');
  await shot('04-glassware-close-up');
});

test('05 quality comparison (efficient vs balanced vs quality)', async () => {
  await lab.focusActiveStation(false);
  for (const id of ['efficient', 'balanced', 'quality'] as const) {
    await lab.setQuality(id);
    await shot(`05-quality-${id}`);
  }
});

test('06 lighting presets (daylight vs night vs studio-neutral)', async () => {
  await lab.focusActiveStation(false);
  for (const id of ['daylight-lab', 'night-lab', 'studio-neutral'] as const) {
    await lab.setLightingPreset(id);
    await shot(`06-lighting-${id}`);
  }
});

test('07 studio mode (infinite workbench)', async () => {
  await lab.setEnvironmentMode('studio');
  await lab.focusActiveStation(false);
  await shot('07-studio-mode');
});

test('08 lighting/reflection test rig for Agent 05', async () => {
  await lab.eval('lab.actions.setLightingTestRigVisible(true);');
  await lab.eval('return lab.camera.focus({ center: [0, 1.0, 0], radiusM: 0.1 }, false);');
  await shot('08-lighting-test-rig');
});
