import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * Runs the rendering benchmark against the real application and writes docs/benchmarks. Kept out
 * of the normal test run: `npm run benchmark`.
 */
export default defineConfig({
  ...base,
  testMatch: '**/*.bench.ts',
  timeout: 1_800_000,
  outputDir: './test-results/bench',
  use: { ...base.use, viewport: { width: 1600, height: 900 }, trace: 'off' },
});
