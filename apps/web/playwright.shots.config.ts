import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * Captures the documentation screenshots in docs/screenshots from the running application.
 * Run with `npm run screenshots`; it is kept out of the normal test run.
 */
export default defineConfig({
  ...base,
  testMatch: '**/*.shots.ts',
  outputDir: './test-results/shots',
  use: { ...base.use, viewport: { width: 1600, height: 900 }, trace: 'off' },
});
