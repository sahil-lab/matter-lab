import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: fileURLToPath(new URL('../../../', import.meta.url)),
  resolve: { alias: {
    '@matterlab/contracts/lab': fileURLToPath(new URL('../../../packages/contracts/lab/index.ts', import.meta.url)),
    '@matterlab/contracts': fileURLToPath(new URL('../../../packages/contracts/src/index.ts', import.meta.url)),
  } },
  test: { environment: 'node', include: ['apps/web/src/lab/persistence/**/*.test.ts', 'apps/web/src/services/science-client.test.ts'] },
});
