import { expect, test } from '@playwright/test';
import { Lab } from './lab';

// Authorization is deliberately absent from trace artifacts and screenshots.
test.use({ trace: 'off' });
test('connects real PostgreSQL notebooks, preserves connection across screens and replays a saved laboratory', async ({ page }) => {
  test.setTimeout(240_000);
  const token = process.env.MATTERLAB_E2E_SERVICE_TOKEN;
  test.skip(!token, 'Requires the local science service and a memory-only test token; run tools\\test-connected.ps1.');
  const lab = new Lab(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await lab.open();
  const original = await lab.atoms();
  const title = `Verified workbench ${Date.now()}`;
  await page.getByRole('textbox', { name: 'Project name' }).fill(title);
  await page.getByRole('textbox', { name: 'Project name' }).press('Enter');
  await page.getByRole('button', { name: 'Display settings', exact: true }).click();
  await page.getByTestId('open-backend').click();
  await page.getByLabel(/Laboratory bearer token/).fill(token!);
  await page.getByRole('button', { name: 'Verify connection', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'PostgreSQL connection verified' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Notebooks', exact: true }).click();
  const [savedResponse] = await Promise.all([
    page.waitForResponse((response) => response.url().endsWith('/v1/experiments') && response.request().method() === 'POST'),
    page.getByRole('button', { name: 'Save new workbench snapshot', exact: true }).click(),
  ]);
  expect(savedResponse.status()).toBe(201);
  const saved = await savedResponse.json() as { id: string; inputs: { snapshot: { payload: { name: string } } } };
  expect(saved.inputs.snapshot.payload.name).toBe(title);
  await page.getByRole('button', { name: 'Close Scientific backend & catalogs', exact: true }).click();
  await lab.eval('lab.actions.newDocument();');
  expect((await lab.atoms()).length).toBe(0);
  await page.getByRole('button', { name: 'Display settings', exact: true }).click();
  await page.getByTestId('open-backend').click();
  await page.getByRole('button', { name: 'Notebooks', exact: true }).click();
  await page.getByRole('button', { name: 'Browse workbench snapshots', exact: true }).click();
  const row = page.getByRole('listitem').filter({ hasText: title });
  await row.getByRole('button', { name: 'Reopen workbench snapshot', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Scientific backend & catalogs', exact: true })).toHaveCount(0);
  expect(await lab.atoms()).toEqual(original);

  await lab.openExample('water');
  await lab.eval('lab.actions.setAtomPosition(2, [0, 1.2, -0.7]);');
  const inputGeometry = await lab.atoms();
  await page.getByRole('button', { name: 'Compute', exact: true }).click();
  await page.getByTestId('remote-quantum-run').click();
  await expect(page.getByTestId('remote-quantum-status')).toContainText('succeeded', { timeout: 120_000 });
  await page.getByText('Atomic forces at the returned geometry', { exact: true }).click();
  await expect(page.getByRole('table').filter({ hasText: 'Cartesian force components' }).getByRole('row')).toHaveCount(inputGeometry.length + 1);
  await expect(page.getByTestId('apply-remote-geometry')).toBeEnabled();
  await page.getByTestId('apply-remote-geometry').click();
  expect(await lab.atoms()).not.toEqual(inputGeometry);
  await lab.eval('lab.actions.undo();');
  expect(await lab.atoms()).toEqual(inputGeometry);
  await page.getByRole('combobox', { name: 'Remote quantum method' }).selectOption('pyscf-hf');
  await page.getByTestId('remote-quantum-run').click();
  await expect(page.getByTestId('remote-quantum-status')).toContainText('succeeded', { timeout: 120_000 });
  await expect(page.getByTestId('remote-quantum-status')).toContainText('pyscf');
  await expect(page.getByTestId('apply-remote-geometry')).toHaveCount(0);

  await page.getByTestId('open-laboratory').click();
  await page.getByTestId('instrument-laboratory').waitFor({ state: 'visible', timeout: 60_000 });
  const skip = page.getByRole('button', { name: 'Skip introduction', exact: true });
  if (await skip.isVisible()) await skip.click();
  await page.getByTestId('lab-prepare-reference').click();
  await expect(page.getByTestId('lab-current-ph')).toHaveText('1.0000');
  await page.getByTestId('lab-notebook').click();
  const notebook = page.getByRole('region', { name: 'Laboratory persistence', exact: true });
  await notebook.getByRole('button', { name: 'Save remotely', exact: true }).click();
  await expect(notebook.getByRole('status').filter({ hasText: 'PostgreSQL confirmed revision' })).toBeVisible({ timeout: 30_000 });
  await notebook.getByRole('button', { name: 'Replay saved scene', exact: true }).click();
  await expect(notebook.getByRole('status').filter({ hasText: 'SUCCEEDED' })).toBeVisible({ timeout: 90_000 });
  const [workbook] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export saved Excel', exact: true }).click(),
  ]);
  expect(workbook.suggestedFilename()).toMatch(/\.xlsx$/);
  expect(await workbook.failure()).toBeNull();
  const credentialsPersisted = await page.evaluate((secret) => Object.values(localStorage).some((value) => value.includes(secret)), token!);
  expect(credentialsPersisted).toBe(false);
  lab.expectNoProblems();
  // Delete only the legacy test snapshot made by this test. The verified private titration remains
  // as a real, reproducible example in the local PostgreSQL notebook.
  const removed = await page.request.delete(`http://127.0.0.1:8787/v1/experiments/${saved.id}`);
  expect(removed.ok()).toBe(true);
});
