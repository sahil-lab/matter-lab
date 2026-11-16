import { defineConfig } from '@playwright/test';

// Tests drive the real application in a real browser. By default they use the Microsoft Edge that
// ships with Windows, so no browser download is needed; set PW_CHANNEL (e.g. "chrome") or
// PW_CHANNEL=bundled (after `npx playwright install chromium`) to use something else.
const channel = process.env.PW_CHANNEL === 'bundled' ? undefined : (process.env.PW_CHANNEL ?? 'msedge');

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: './test-results',
  use: {
    baseURL: 'http://127.0.0.1:5273',
    channel,
    viewport: { width: 1440, height: 810 },
    // Ask headless Chromium for the real GPU rather than a software rasteriser.
    launchOptions: { args: ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu'] },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:5273',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
