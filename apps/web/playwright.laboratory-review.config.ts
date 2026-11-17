import { defineConfig } from '@playwright/test';
import preview from './playwright.preview.config';

export default defineConfig({
  ...preview,
  testMatch: '**/laboratory.review.ts',
  timeout: 600_000,
  outputDir: './test-results/laboratory-review',
  use: { ...preview.use, viewport: { width: 1366, height: 768 }, trace: 'off' },
});
