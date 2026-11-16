import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const webDirectory = fileURLToPath(new URL('../apps/web', import.meta.url));
const hardware = process.env.MATTERLAB_SMOKE_RENDERER === 'hardware';
const channel = process.env.PW_CHANNEL === 'bundled' || !process.env.PW_CHANNEL
  ? undefined : process.env.PW_CHANNEL;
const baseURL = 'http://127.0.0.1:6173';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.smoke.spec.ts',
  outputDir: './results/browser',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [
    ['list'],
    ['junit', { outputFile: 'qa/results/browser.xml' }],
    ['html', { outputFolder: 'qa/results/browser-report', open: 'never' }],
  ],
  use: {
    baseURL,
    channel,
    launchOptions: {
      args: hardware
        ? [...(process.platform === 'win32' ? ['--use-angle=d3d11'] : []), '--enable-gpu']
        : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1920, height: 1080 } } },
    { name: 'laptop', use: { viewport: { width: 1366, height: 768 } } },
    { name: 'reduced-motion', use: { viewport: { width: 1366, height: 768 }, reducedMotion: 'reduce' } },
  ],
  webServer: {
    command: 'npm run build && npm run preview -- --port 6173',
    cwd: webDirectory,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 300_000,
  },
});
