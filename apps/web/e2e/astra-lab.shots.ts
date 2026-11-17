import { fileURLToPath } from 'node:url';
import { test } from '@playwright/test';
import { AstraLab } from './astraLab';

const OUT = fileURLToPath(new URL('../../../docs/screenshots/astra/', import.meta.url));

let lab: AstraLab;

test.beforeEach(async ({ page }) => {
  lab = new AstraLab(page);
});

async function shot(name: string): Promise<void> {
  await lab.settle(400);
  await lab.page.screenshot({ path: `${OUT}${name}.png` });
}

test('onboarding cinematic', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await lab.openFresh();
  await shot('01-onboarding-cinematic');
  await lab.skipOnboardingIfShown();
});

test('the shell, disconnected (the honest default) at the desktop and laptop gates', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await lab.open();
  await shot('02-shell-disconnected-1920x1080');
  await page.setViewportSize({ width: 1366, height: 768 });
  await lab.open();
  await shot('03-shell-disconnected-1366x768');
  await page.setViewportSize({ width: 1280, height: 800 });
  await lab.open();
  await shot('04-shell-disconnected-1280x800');
});

test('both side panels collapsed, for an (almost) full-bleed viewport', async () => {
  await lab.open();
  await lab.eval('astra.astraLab.set({ libraryOpen: false, inspectorOpen: false });');
  await shot('05-shell-both-panels-collapsed');
});

test('apparatus library: search and a selected item', async () => {
  await lab.open();
  await lab.eval('astra.astraLab.set({ inspectorOpen: true });');
  await shot('06-apparatus-library');
  await lab.page.getByPlaceholder('Search burette, flask, probe…').fill('burette');
  await shot('07-apparatus-library-search');
  await lab.page.getByTestId('astra-apparatus-card').first().click();
  await shot('08-apparatus-selected-inspector');
});

test('titration HUD and timeline, populated with watermarked sample data', async () => {
  await lab.open();
  await lab.page.getByTestId('astra-preview-sample').click();
  await lab.page.getByTestId('astra-dock-toggle').click();
  await shot('09-hud-and-timeline-populated');
  await lab.page.getByTestId('astra-playpause').click();
  await lab.settle(900);
  await shot('10-timeline-playing');
});

test('explanation panel, simple and advanced', async () => {
  await lab.open();
  await lab.eval('astra.astraLab.set({ inspectorOpen: true, previewDemoData: true, inspectorTab: "explain" });');
  await shot('11-explanation-simple');
  await lab.eval('astra.astraLab.set({ explainLevel: "advanced", explainTab: "diagnostics" });');
  await shot('12-explanation-advanced-diagnostics');
});

test('component gallery', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1200 });
  await lab.open('/lab/gallery');
  await lab.page.screenshot({ path: `${OUT}13-component-gallery.png`, fullPage: true });
});
