import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: {
    alias: { '@matterlab/contracts': fileURLToPath(new URL('../contracts/src/index.ts', import.meta.url)) },
  },
  test: {
    name: 'lab-science',
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    maxWorkers: 1,
    isolate: false,
  },
});
