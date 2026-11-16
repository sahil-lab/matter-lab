import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

export default defineProject({
  root: fileURLToPath(new URL('.', import.meta.url)),
  cacheDir: '.cache/vite',
  resolve: { alias: {
    '@matterlab/lab-runtime': fileURLToPath(new URL('./src/index.ts', import.meta.url)),
    '@matterlab/contracts': fileURLToPath(new URL('../contracts/src/index.ts', import.meta.url)),
    '@matterlab/lab-science': fileURLToPath(new URL('../lab-science/src/index.ts', import.meta.url)),
  } },
  test: {
    name: 'lab-runtime', environment: 'node', include: ['test/**/*.test.ts'],
    maxWorkers: 1, fileParallelism: false,
  },
});
