import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * Runs just the lab editor's own e2e suite (`e2e/lab-editor.spec.ts`) against a dedicated dev
 * server on a port the rest of the monorepo's tooling never uses, with `reuseExistingServer:
 * false` so it always starts fresh against *this* worktree's code — this repo's shared contract
 * has ten agents working in parallel worktrees, and port 5273 is not guaranteed to be free or to
 * be serving this branch's code when this suite runs.
 */
const url = 'http://127.0.0.1:5902';

export default defineConfig({
  ...base,
  testMatch: /lab-editor\.spec\.ts/,
  outputDir: './test-results/lab-editor',
  use: { ...base.use, baseURL: url },
  webServer: {
    command: 'npx vite --port 5902 --strictPort',
    url,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
