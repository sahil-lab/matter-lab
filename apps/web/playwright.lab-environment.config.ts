import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * Runs just Agent 02's lab-environment tests and screenshots, against the harness entry point
 * (`/lab-environment.html`), not the main application. A separate config (rather than reusing
 * port 5273) because several agents' dev servers may already be running on this machine; point
 * `LAB_ENV_URL` at wherever `vite` is actually serving this worktree if 5291 is unavailable.
 */
const url = process.env.LAB_ENV_URL ?? 'http://127.0.0.1:5291';

export default defineConfig({
  ...base,
  testMatch: ['**/lab-environment.spec.ts', '**/lab-environment.shots.ts'],
  outputDir: './test-results/lab-environment',
  use: { ...base.use, baseURL: url },
  webServer: {
    command: 'node ../../node_modules/vite/bin/vite.js --port 5291',
    url,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
