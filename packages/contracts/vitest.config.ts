import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

export default defineProject({
  root: fileURLToPath(new URL('.', import.meta.url)),
  cacheDir: '.cache/vite',
  test: {
    name: 'contracts',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    maxWorkers: 1,
    fileParallelism: false,
  },
});
