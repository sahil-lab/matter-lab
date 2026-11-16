import { expect, test } from '@playwright/test';

test('production molecular workspace loads without test hooks or browser errors', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');
  await expect(page.getByTestId('formula')).toHaveText('C8H10N4O2');
  await expect(page.getByTestId('validation-chip')).toContainText('Structure valid');
  const canvas = page.locator('.ml-viewport canvas');
  await expect(canvas).toBeVisible();
  const hasTestHook = await page.evaluate(() => '__MATTERLAB__' in window || '__MATTERLAB_LAB_TEST__' in window);
  expect(hasTestHook).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await info.attach('actual-production-view', { body: await page.screenshot(), contentType: 'image/png' });
  expect(errors, 'The production page logged errors').toEqual([]);
});
