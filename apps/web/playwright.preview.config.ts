import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * Runs the browser tests against the production build instead of the development server:
 * `npm run test:e2e:build`. The build is made fresh each time, into dist-e2e, with the test hook
 * switched on (see .env.e2e); it is otherwise the same bundle `npm run build` produces.
 */
const url = 'http://127.0.0.1:4273';

export default defineConfig({
  ...base,
  outputDir: './test-results/preview',
  use: { ...base.use, baseURL: url },
  webServer: {
    command: 'npm run build:e2e && npm run preview:e2e',
    url,
    reuseExistingServer: false,
    timeout: 300_000,
  },
});
