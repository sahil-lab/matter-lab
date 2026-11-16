import { fileURLToPath } from 'node:url';
import { test } from '@playwright/test';
import { Lab } from './lab';

const OUT = fileURLToPath(new URL('../../../docs/screenshots/', import.meta.url));

let lab: Lab;

test.beforeEach(async ({ page }) => {
  lab = new Lab(page);
  await lab.open();
});

async function shot(name: string): Promise<void> {
  await lab.settle(700);
  await lab.page.screenshot({ path: `${OUT}${name}.png` });
}

test('representations and projections', async () => {
  await shot('01-caffeine-ball-and-stick');
  for (const [mode, file] of [
    ['space-fill', '02-caffeine-space-filling'],
    ['sticks', '03-caffeine-sticks'],
    ['wire', '04-caffeine-wireframe'],
  ] as const) {
    await lab.eval(`lab.lab.set({ renderMode: '${mode}' });`);
    await shot(file);
  }
  await lab.eval("lab.lab.set({ renderMode: 'ball-stick', projection: 'orthographic', labelMode: 'all' });");
  await shot('05-orthographic-with-labels');
});

test('quality presets', async () => {
  await lab.openExample('aspirin');
  for (const quality of ['efficient', 'balanced', 'quality'] as const) {
    await lab.eval(`lab.lab.set({ quality: '${quality}', showPerf: true });`);
    await lab.ready();
    await shot(`06-aspirin-${quality}`);
  }
});

test('inspector, measurement and validation', async ({ page }) => {
  await lab.openExample('glycine');
  await lab.click(await lab.atomPoint(1));
  await shot('07-atom-inspector');

  await lab.eval('lab.actions.selectOnly([], [1]);');
  await shot('08-bond-inspector');

  await lab.eval("lab.actions.selectOnly(); lab.actions.addMeasurement([1, 2]); lab.actions.addMeasurement([1, 2, 3]); lab.lab.set({ inspectorTab: 'measure', tool: 'measure' });");
  await shot('09-measurements');

  await lab.eval("lab.lab.set({ inspectorTab: 'explain', tool: 'select' }); lab.actions.selectOnly([2]);");
  await shot('10-explanation');

  await lab.openExample('methane');
  await lab.eval("lab.lab.set({ autoHydrogens: false, tool: 'build', buildElement: 1, inspectorTab: 'inspect' });");
  const carbon = await lab.atomPoint(1);
  await lab.drag(carbon, [carbon[0] + 140, carbon[1] - 130]);
  await page.getByTestId('validation-chip').click();
  await page.getByRole('button', { name: 'Physics', exact: true }).click();
  await shot('11-physics-mode-over-bonded');
});

test('dialogs', async ({ page }) => {
  await lab.eval("lab.lab.set({ dialog: 'periodic-table' });");
  await shot('12-periodic-table');
  await lab.eval("lab.lab.set({ dialog: 'library' });");
  await shot('13-library');
  await lab.eval("lab.lab.set({ dialog: 'export' });");
  await shot('14-export');
  await lab.eval("lab.lab.set({ dialog: 'shortcuts' });");
  await shot('15-shortcuts');
  await lab.eval('lab.lab.set({ dialog: null });');

  await lab.eval("lab.lab.set({ tool: 'build', buildElement: 8 });");
  const point = await lab.atomPoint(1);
  await page.mouse.move(point[0], point[1]);
  await page.mouse.down();
  await page.mouse.move(point[0] + 120, point[1] - 90, { steps: 6 });
  await shot('16-build-preview');
  await page.mouse.up();
});

test('large and small structures', async () => {
  for (const id of ['water', 'benzene', 'adamantane']) {
    await lab.openExample(id);
    await shot(`17-${id}`);
  }
});

test('finding structures', async ({ page }) => {
  await lab.eval("lab.lab.set({ dialog: 'library' });");
  const dialog = page.getByRole('dialog', { name: 'Library' });
  await dialog.getByRole('button', { name: 'Find', exact: true }).click();
  await shot('18-find-empty');

  // Cholesterol, as PubChem writes it: eight stereocentres for the builder to get right.
  await page.getByTestId('find-smiles').fill('C[C@H](CCCC(C)C)[C@H]1CC[C@@H]2[C@@]1(CC[C@H]3[C@H]2CC=C4[C@@]3(CC[C@@H](C4)O)C)C');
  await page.getByTestId('find-build').click();
  await page.getByTestId('find-model').waitFor({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Similar to' }).click();
  await page.getByTestId('find-use-current').click();
  await page.getByTestId('find-search').click();
  await page.getByTestId('find-hits').waitFor();
  await page.mouse.move(40, 860);
  await shot('18-find-model-and-search');
  await dialog.locator('.ml-dialog__body').evaluate((body) => body.scrollTo(0, body.scrollHeight));
  await shot('18-find-search-results');

  await page.getByTestId('find-model-open').click();
  await shot('19-cholesterol-from-smiles');

  // A refusal: a configuration the force field cannot hold is not offered with the wrong one.
  await lab.eval("lab.lab.set({ dialog: 'library' });");
  await dialog.getByRole('button', { name: 'Find', exact: true }).click();
  await page.getByTestId('find-smiles').fill('C[S@](=O)c1ccccc1');
  await page.getByTestId('find-build').click();
  await page.getByTestId('find-build-problem').waitFor({ timeout: 60_000 });
  await page.mouse.move(40, 860);
  await shot('19-find-refusal');
});

test('the nucleus of an atom', async ({ page }) => {
  const done = () => page.waitForFunction(() => (window as unknown as { __MATTERLAB__: { nucleus: { introDone: boolean } } }).__MATTERLAB__.nucleus.introDone, undefined, { timeout: 20_000 });
  // Carbon-14 in a methane molecule: six protons and eight neutrons.
  await lab.openExample('methane');
  await lab.eval("lab.actions.setParticles(1, { neutrons: 8 }, 'Change isotope'); lab.actions.selectOnly([1]);");
  await shot('60-atomic-forge-carbon-14');
  await page.getByTestId('open-nucleus').click();
  await page.getByTestId('nucleus').waitFor();
  // Part of the way from the atom to its nucleus.
  await page.waitForTimeout(1250);
  await page.screenshot({ path: `${OUT}61-nucleus-zooming-in.png` });
  await done();
  const front = await lab.eval<[number, number]>('const n = lab.nucleus; const first = [...n.model.nucleons].sort((a, b) => b.position[2] - a.position[2])[0]; return n.screenPoint(first.index);');
  await page.mouse.click(front[0], front[1]);
  await page.mouse.move(40, 860);
  await shot('62-nucleus-carbon-14');
  await page.keyboard.press('Escape');

  // Uranium-238: 92 protons and 146 neutrons.
  await lab.eval("lab.actions.changeElement([1], 92); lab.actions.setParticles(1, { neutrons: 146 }, 'Change isotope'); lab.actions.selectOnly([1]);");
  await page.getByTestId('open-nucleus').click();
  await page.getByTestId('nucleus').waitFor();
  await done();
  await shot('63-nucleus-uranium-238');
});
